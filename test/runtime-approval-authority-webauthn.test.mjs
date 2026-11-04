import assert from 'node:assert/strict';
import { constants, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { validateReceiptV2 } from '../src/runtime/broker-contract/receipt-v2.mjs';
import {
  VIRTUAL_ACCOUNT_SID, buildAuthority, getUnavailableReason, guestSid, helloSignature, makeConfig, makeHelloKey, makeTrustedTempDirectory, presenceMessage, standInService,
  startAuthority, startProcess, waitForExit, writeConfig,
} from './helpers/approval-authority-harness.mjs';

// WebAuthn presence and the approver key list over the REAL pipes (docs/architecture/approver-webauthn.md, "Wire contract", phase 2). Windows-only, same-user, unprivileged, the test-faults build.
// Everything the approver would build (the client data, the authenticatorData, the canonical key record and its digest, the add / remove messages, the proof objects) is built HERE, in Node, from
// the document alone, so the C# Authority is checked against an independent implementation of the contract rather than against itself.
const sha256 = (data) => createHash('sha256').update(data).digest();
const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const RP_ID_HASH = sha256('approver.albera.local');
const REQUEST = { v: 1, verb: 'submit', purpose: 'broker.operation', operationId: 'op-1', idempotencyKey: 'idem-1', leaseId: 'lease-1', leaseGeneration: 7, brokerEpoch: 3, brokerChallenge: '_-7dzLuqmYh3ZlVEMyIRAA', action: { action: 'environment.start', projectId: 'proj-alpha', computerId: 'pc-01', args: { vmName: 'alpha' } } };

/** A throw-away authenticator credential and its key record (alg -7 = ES256 / P-256, -257 = RS256 / RSA-2048). */
function makeCredential(alg = -7, credentialBytes = 32) {
  const { privateKey, publicKey } = alg === -7 ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const credentialId = randomBytes(credentialBytes);
  const keyId = `webauthn-${sha256(spki).subarray(0, 8).toString('hex')}`;
  return { privateKey, alg, credentialId, keyId, record: { keyId, kind: 'webauthn', alg, publicKey: spki.toString('base64'), credentialId: b64url(credentialId) } };
}

/** The Hello key as a record of the list (kind hello-rsa, derived id, alg -257). */
function makeHelloCredential(hello) {
  const keyId = `hello-${sha256(Buffer.from(hello.spki, 'base64')).subarray(0, 8).toString('hex')}`;
  return { keyId, record: { keyId, kind: 'hello-rsa', alg: -257, publicKey: hello.spki } };
}

/** The internal packed form of a webauthn proof (docs/architecture/approval-authority.md): what must never be accepted when it arrives as a string. */
function packed(proof) {
  const credentialId = Buffer.from(proof.credentialId, 'base64url'), data = Buffer.from(proof.authenticatorData, 'base64'), signature = Buffer.from(proof.signature, 'base64');
  const u16 = (n) => Buffer.from([n >> 8, n & 255]);
  return Buffer.concat([Buffer.from('ALBWA1'), u16(credentialId.length), credentialId, Buffer.from([data.length]), data, u16(signature.length), signature]);
}

/** The canonical bytes of a record: this JSON, keys in this order, no spaces. */
const canonical = (record) => JSON.stringify(record);
const recordDigest = (record) => sha256(Buffer.from(canonical(record), 'utf8')).toString('hex');
const addDomainMessage = (record, challenge) => Buffer.from(`albera.keyadd.v1\0${record.keyId}\0${recordDigest(record)}\0${challenge}`, 'utf8');
const removeMessage = (record, challenge) => Buffer.from(`albera.keyremove.v1\0${record.keyId}\0${recordDigest(record)}\0${challenge}`, 'utf8');

/** What WebAuthn gives back: authenticatorData (rpIdHash, flags UP|UV, sign count) and a signature over authenticatorData || SHA-256(clientData). */
function assertion(credential, message, count = 1, { flags = 0x05, clientData } = {}) {
  const authenticatorData = Buffer.concat([RP_ID_HASH, Buffer.from([flags]), Buffer.from([(count >>> 24) & 255, (count >>> 16) & 255, (count >>> 8) & 255, count & 255])]);
  const client = clientData ?? `{"type":"webauthn.get","challenge":"${b64url(sha256(message))}","origin":"albera://approver","crossOrigin":false}`;
  const data = Buffer.concat([authenticatorData, sha256(Buffer.from(client, 'utf8'))]);
  const signature = credential.alg === -7 ? sign('sha256', data, credential.privateKey) : sign('sha256', data, { key: credential.privateKey, padding: constants.RSA_PKCS1_PADDING });
  return { kind: 'webauthn', credentialId: b64url(credential.credentialId), authenticatorData: authenticatorData.toString('base64'), signature: signature.toString('base64') };
}

/** A config that names its approver keys as a list (no legacy pair). */
function listConfig(credentials, overrides = {}) {
  const { approverKeyId: _id, approverPublicKey: _key, ...rest } = makeConfig(overrides);
  return { ...rest, approverKeys: credentials.map((credential) => credential.record) };
}

describe('Approval Authority: WebAuthn presence and the approver key list (real pipes, independent Node implementation of the wire contract)', { skip: getUnavailableReason(), timeout: 600_000 }, () => {
  let root, exe, folders;
  before(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'albera-authority-webauthn-'));
    exe = buildAuthority(path.join(root, 'faults'), { faults: true });
    folders = [];
  });
  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  });

  const folder = () => { const made = makeTrustedTempDirectory('albera-authority-keys-'); folders.push(made); return made; };
  const storeOf = (directory) => JSON.parse(readFileSync(path.join(directory, 'approver-keys.json'), 'utf8'));
  const isFailure = (reply, code) => assert.deepEqual(reply, { ok: false, code });
  // keepKeyStore: a plain restart with the same config (the file is the key list). Without it the helper does what the installer's set-approver does: new config, store deleted, seeded again.
  async function withAuthority(directory, config, body, { keepKeyStore = false } = {}) {
    const authority = await startAuthority(exe, directory, { config, keepKeyStore });
    try { return await body(authority); } finally { await authority.stop(); }
  }
  async function pending(authority, n = 1) {
    const submitted = await authority.submit({ ...REQUEST, operationId: `op-${n}`, idempotencyKey: `idem-${n}` });
    return (await authority.approver({ v: 1, verb: 'list' })).pending.find((entry) => entry.approvalId === submitted.approvalId);
  }
  const decide = (authority, entry, presence) => authority.approver({ v: 1, verb: 'decide', approvalId: entry.approvalId, decision: 'approve', presence });
  const receiptOf = async (authority, entry) => JSON.parse(Buffer.from((await authority.submit({ v: 1, verb: 'status', approvalId: entry.approvalId })).receipt, 'base64').toString('utf8'));
  const keysOf = async (authority) => (await authority.approver({ v: 1, verb: 'keys' })).keys;
  async function removeKey(authority, keyId, record, by) {
    const { challenge } = await authority.approver({ v: 1, verb: 'key_challenge', op: 'remove', keyId });
    return authority.approver({ v: 1, verb: 'key_remove', keyId, challenge, by: by(removeMessage(record, challenge)) });
  }

  it('a config that lists its keys: a webauthn assertion approves, the receipt names the key that signed, and the store is created at start and keeps the sign count', async () => {
    const es = makeCredential(-7);
    const directory = folder();
    const config = listConfig([es]);
    await withAuthority(directory, config, async (authority) => {
      const seeded = storeOf(directory);
      assert.deepEqual(Object.keys(seeded), ['v', 'revision', 'keys', 'signCounts']);
      assert.deepEqual([seeded.v, seeded.revision, seeded.keys, seeded.signCounts], [1, 1, [es.record], {}], 'created from the config keys, the record exactly as the config gave it');
      assert.deepEqual(await keysOf(authority), [{ keyId: es.keyId, kind: 'webauthn', credentialId: es.record.credentialId }], 'keys: id, kind, credential id and nothing else');
      const entry = await pending(authority);
      assert.deepEqual(await decide(authority, entry, assertion(es, presenceMessage(entry), 5)), { ok: true, state: 'approved' });
      const receipt = await receiptOf(authority, entry);
      assert.equal(receipt.approverKeyId, es.keyId);
      const status = await authority.submit({ v: 1, verb: 'status', approvalId: entry.approvalId });
      const verdict = validateReceiptV2(Buffer.from(status.receipt, 'base64'), {
        clock: () => Math.floor(Date.now() / 1000), environment: 'test', action: REQUEST.action,
        expected: { audience: 'albera-host-broker', purpose: REQUEST.purpose, operationId: 'op-1', idempotencyKey: 'idem-1', leaseId: 'lease-1', leaseGeneration: 7, brokerEpoch: 3, brokerChallenge: REQUEST.brokerChallenge, policyVersion: 'policy-test' },
      });
      assert.equal(verdict.ok, true, JSON.stringify(verdict));
      assert.deepEqual([storeOf(directory).revision, storeOf(directory).signCounts], [2, { [es.keyId]: 5 }], 'the moved count was written');
      const replay = await pending(authority, 2);
      isFailure(await decide(authority, replay, assertion(es, presenceMessage(replay), 5)), 'presence_mismatch');
    });
  });

  it('the older config (approverKeyId + approverPublicKey) keeps working: one hello-rsa key with the id it was given, raw RSA signature, receipts name it', async () => {
    const hello = makeHelloKey();
    const directory = folder();
    const config = makeConfig({ approverPublicKey: hello.spki });
    await withAuthority(directory, config, async (authority) => {
      assert.deepEqual(await keysOf(authority), [{ keyId: 'hello-key-test', kind: 'hello-rsa' }]);
      const entry = await pending(authority);
      assert.deepEqual(await decide(authority, entry, helloSignature(hello.privateKey, presenceMessage(entry))), { ok: true, state: 'approved' });
      assert.equal((await receiptOf(authority, entry)).approverKeyId, 'hello-key-test');
      assert.deepEqual(storeOf(directory).keys, [{ keyId: 'hello-key-test', kind: 'hello-rsa', alg: -257, publicKey: hello.spki }], 'the pair became one hello-rsa record in the store');
      const answer = await authority.approver({ v: 1, verb: 'list' });
      assert.equal('keys' in answer, false, 'list keeps its shape');
      isFailure(await authority.approver({ v: 1, verb: 'list', keys: true }), 'request_invalid');
    });
  });

  it('keys can only be removed over the pipe, with signatures; the list, the sign counts and the removal survive a restart, and a removed key can no longer approve', async () => {
    const hello = makeHelloKey(), helloKey = makeHelloCredential(hello);
    const es = makeCredential(-7), rs = makeCredential(-257);
    const directory = folder();
    const config = listConfig([helloKey, es, rs]);
    await withAuthority(directory, config, async (authority) => {
      assert.deepEqual((await keysOf(authority)).map((key) => key.keyId), [helloKey.keyId, es.keyId, rs.keyId], 'the list the config named');
      // each approves; the receipt names its signer
      const first = await pending(authority, 1);
      assert.equal((await decide(authority, first, assertion(rs, presenceMessage(first), 3))).ok, true);
      assert.equal((await receiptOf(authority, first)).approverKeyId, rs.keyId);
      // any registered key removes another: the webauthn key `es` removes the Hello key
      const removed = await removeKey(authority, helloKey.keyId, helloKey.record, (message) => assertion(es, message, 2));
      assert.equal(removed.ok, true, JSON.stringify(removed));
      assert.deepEqual(removed.keys.map((key) => key.keyId), [es.keyId, rs.keyId]);
      assert.equal('policyReset' in removed, false, 'no policy was signed by it');
      const stale = await pending(authority, 2);
      isFailure(await decide(authority, stale, helloSignature(hello.privateKey, presenceMessage(stale))), 'presence_mismatch');
    }, { keepKeyStore: true });
    assert.deepEqual(storeOf(directory).keys.map((key) => key.keyId), [es.keyId, rs.keyId]);
    assert.deepEqual(storeOf(directory).signCounts, { [rs.keyId]: 3, [es.keyId]: 2 });
    await withAuthority(directory, config, async (authority) => {
      assert.deepEqual((await keysOf(authority)).map((key) => key.keyId), [es.keyId, rs.keyId], 'the file is the list: the config still names the Hello key, which did not come back');
      const same = await pending(authority, 3);
      isFailure(await decide(authority, same, assertion(rs, presenceMessage(same), 3)), 'presence_mismatch');
      const zero = await pending(authority, 4);
      isFailure(await decide(authority, zero, assertion(rs, presenceMessage(zero), 0)), 'presence_mismatch');
      const entry = await pending(authority, 5);
      assert.equal((await decide(authority, entry, assertion(rs, presenceMessage(entry), 4))).ok, true, 'the stored count (3) survived the restart: 3 and 0 are refused, 4 is fine');
      assert.equal((await receiptOf(authority, entry)).approverKeyId, rs.keyId);
    }, { keepKeyStore: true });
  });

  it('removing the key that signed the standing policy resets the policy to careful in the same call (policyReset), the next start succeeds; removing another key leaves the policy alone', async () => {
    const hello = makeHelloKey(), helloKey = makeHelloCredential(hello);
    const es = makeCredential(-7), rs = makeCredential(-257);
    const directory = folder();
    const config = listConfig([helloKey, es, rs]);
    const helloAuthorizes = (message) => helloSignature(hello.privateKey, message);
    const policyHash = (rev, tier) => `sha256:${sha256(['albera.policy-hash.v3', String(rev), tier].join('\0')).toString('hex')}`;
    const policyMessage = (rev, tier) => Buffer.from(`albera.policy.v1\0${config.kid}\0${config.audience}\0${policyHash(rev, tier)}`, 'utf8');
    const policyFile = path.join(directory, 'policy.json');
    await withAuthority(directory, config, async (authority) => {
      // the webauthn key `es` authorizes the standard policy: the file keeps its proof
      assert.deepEqual(await authority.approver({ v: 1, verb: 'policy_set', policy: { v: 1, rev: 1, tier: 'standard', overrides: {} }, presence: assertion(es, policyMessage(1, 'standard'), 1) }), { ok: true, policyVersion: policyHash(1, 'standard') });
      const signed = readFileSync(policyFile, 'utf8');
      assert.match(signed, /"authorized"/u);
      // a key that did not sign it goes: nothing happens to the policy
      const removedRs = await removeKey(authority, rs.keyId, rs.record, (message) => assertion(es, message, 2));
      assert.equal(removedRs.ok, true, JSON.stringify(removedRs));
      assert.equal('policyReset' in removedRs, false);
      assert.equal(readFileSync(policyFile, 'utf8'), signed, 'the file is as it was');
      // the signer goes (the Hello key authorizes): the policy is reset in the same call
      const removedEs = await removeKey(authority, es.keyId, es.record, helloAuthorizes);
      assert.deepEqual(Object.keys(removedEs), ['ok', 'keys', 'policyReset']);
      assert.equal(removedEs.policyReset, true);
      assert.deepEqual(removedEs.keys, [{ keyId: helloKey.keyId, kind: 'hello-rsa' }]);
      const policy = await authority.approver({ v: 1, verb: 'policy' });
      assert.deepEqual([policy.policy.rev, policy.policy.tier], [2, 'careful']);
      assert.doesNotMatch(readFileSync(policyFile, 'utf8'), /authorized/u);
      assert.ok(authority.child.lines.includes(`POLICY_CHANGED=2 careful ${policyHash(2, 'careful')}`), 'the reset is reported like any policy change');
    }, { keepKeyStore: true });
    // the next start: it would have been exit 79 (policy_unsigned) with the signed file and no es
    await withAuthority(directory, config, async (authority) => {
      const policy = await authority.approver({ v: 1, verb: 'policy' });
      assert.deepEqual([policy.policy.rev, policy.policy.tier], [2, 'careful']);
      assert.deepEqual((await keysOf(authority)).map((key) => key.keyId), [helloKey.keyId]);
      const entry = await pending(authority);
      assert.equal(entry.action.action, 'environment.start');
    }, { keepKeyStore: true });
  });

  it('refusals carry the documented codes and change nothing: key_unknown, last_key, challenge_unknown, presence_mismatch, request_invalid; key_add is not a verb', async () => {
    const hello = makeHelloKey(), helloKey = makeHelloCredential(hello);
    const es = makeCredential(-7), stranger = makeCredential(-7), other = makeCredential(-7);
    const directory = folder();
    await withAuthority(directory, listConfig([helloKey, es]), async (authority) => {
      const challenge = async (op, keyId) => authority.approver({ v: 1, verb: 'key_challenge', op, keyId });
      const reply = await challenge('remove', es.keyId);
      assert.deepEqual(Object.keys(reply), ['ok', 'challenge', 'expiresAt']);
      assert.match(reply.challenge, /^[A-Za-z0-9_-]{21}[AQgw]$/u);
      assert.ok(reply.expiresAt - Math.floor(Date.now() / 1000) <= 120 && reply.expiresAt - Math.floor(Date.now() / 1000) >= 115, 'valid for 120 s');
      isFailure(await challenge('remove', other.keyId), 'key_unknown');
      isFailure(await challenge('add', other.keyId), 'request_invalid');
      isFailure(await challenge('add', es.keyId), 'request_invalid');
      isFailure(await challenge('rename', es.keyId), 'request_invalid');
      isFailure(await authority.approver({ v: 1, verb: 'key_challenge', keyId: es.keyId }), 'request_invalid');

      // key_add does not exist: the verb of the older contract is request_invalid on both pipes and adds nothing
      const oldMessage = Buffer.from(`albera.keyadd.v1\0${other.keyId}\0${recordDigest(other.record)}\0AAAAAAAAAAAAAAAAAAAAAA`, 'utf8');
      const oldFrame = { v: 1, verb: 'key_add', key: other.record, challenge: 'AAAAAAAAAAAAAAAAAAAAAA', by: helloSignature(hello.privateKey, oldMessage), newKey: assertion(other, oldMessage) };
      isFailure(await authority.approver(oldFrame), 'request_invalid');
      isFailure(await authority.submit(oldFrame), 'request_invalid');

      // removal: a stranger's proof, an authorization over another record, the old add domain, a digest with a prefix, a wrong challenge
      const helloAuthorizes = (message) => helloSignature(hello.privateKey, message);
      const frame = async (by, extra = {}) => {
        const { challenge: value } = await challenge('remove', es.keyId);
        const message = removeMessage(es.record, value);
        return { v: 1, verb: 'key_remove', keyId: es.keyId, challenge: value, by: by(message, value), ...extra };
      };
      isFailure(await authority.approver(await frame((m) => assertion(stranger, m))), 'presence_mismatch');
      isFailure(await authority.approver(await frame((m, c) => helloAuthorizes(removeMessage(other.record, c)))), 'presence_mismatch');
      isFailure(await authority.approver(await frame((m, c) => helloAuthorizes(addDomainMessage(es.record, c)))), 'presence_mismatch');
      isFailure(await authority.approver(await frame((m) => helloAuthorizes(Buffer.from(m.toString('utf8').replace(recordDigest(es.record), `sha256:${recordDigest(es.record)}`), 'utf8')))), 'presence_mismatch');
      isFailure(await authority.approver(await frame(() => 'AAAA')), 'presence_mismatch');
      isFailure(await authority.approver(await frame(helloAuthorizes, { challenge: 'AAAAAAAAAAAAAAAAAAAAAA' })), 'challenge_unknown');
      isFailure(await authority.approver(await frame(helloAuthorizes, { keyId: helloKey.keyId })), 'challenge_unknown');
      isFailure(await authority.approver(await frame(helloAuthorizes, { extra: 1 })), 'request_invalid');
      assert.deepEqual((await keysOf(authority)).map((key) => key.keyId), [helloKey.keyId, es.keyId], 'nothing was removed by any of them');
      // flags / client data / counts of a registered key's approval
      const entry = await pending(authority);
      isFailure(await decide(authority, entry, assertion(es, presenceMessage(entry), 5, { flags: 0x01 })), 'presence_mismatch');
      const entry2 = await pending(authority, 2);
      isFailure(await decide(authority, entry2, assertion(es, presenceMessage(entry2), 5, { clientData: '{"type":"webauthn.get","challenge":"x","origin":"albera://approver","crossOrigin":false}' })), 'presence_mismatch');
      const entry3 = await pending(authority, 3);
      assert.equal((await decide(authority, entry3, assertion(es, presenceMessage(entry3), 5))).ok, true, 'the same key with the right flags and client data approves');
      const entry4 = await pending(authority, 4);
      isFailure(await decide(authority, entry4, assertion(es, presenceMessage(entry4), 0)), 'presence_mismatch');
      // the packed form is not a string: the internal marker in a legacy string is a shape error, and the same assertion as an object is accepted
      const entry5 = await pending(authority, 5);
      const proof = assertion(es, presenceMessage(entry5), 6);
      isFailure(await decide(authority, entry5, packed(proof).toString('base64')), 'request_invalid');
      isFailure(await decide(authority, entry5, Buffer.concat([Buffer.from('ALBWA1'), randomBytes(250)]).toString('base64')), 'request_invalid');
      assert.equal((await decide(authority, entry5, proof)).ok, true, 'refused as a string (the request stayed pending), accepted as an object');
      // the legacy string form still works for the Hello key
      const entry6 = await pending(authority, 6);
      assert.equal((await decide(authority, entry6, helloSignature(hello.privateKey, presenceMessage(entry6)))).ok, true);
      assert.equal((await receiptOf(authority, entry6)).approverKeyId, helloKey.keyId);
    });
  });

  it('only the last-key rule protects the list: a removal that would leave no key is refused even with a valid signature', async () => {
    const es = makeCredential(-7);
    const directory = folder();
    await withAuthority(directory, listConfig([es]), async (authority) => {
      isFailure(await authority.approver({ v: 1, verb: 'key_challenge', op: 'remove', keyId: es.keyId }), 'last_key');
      const message = removeMessage(es.record, 'AAAAAAAAAAAAAAAAAAAAAA');
      isFailure(await authority.approver({ v: 1, verb: 'key_remove', keyId: es.keyId, challenge: 'AAAAAAAAAAAAAAAAAAAAAA', by: assertion(es, message) }), 'challenge_unknown');
      assert.deepEqual((await keysOf(authority)).map((key) => key.keyId), [es.keyId]);
    });
  });

  it('start-up: service-check reads the store and creates nothing; a bad store stops the start with 80 and a fixed word; the pair together with the list is config_approver_keys (73)', async () => {
    const es = makeCredential(-7), second = makeCredential(-257);
    const directory = folder();
    const settings = { controlPlaneSid: VIRTUAL_ACCOUNT_SID, approverSid: guestSid() };
    const file = (config, name = 'config.json') => writeConfig(directory, config, name);
    const check = (configFile) => { const child = startProcess(exe, standInService('service-check', configFile)); return waitForExit(child).then((code) => ({ code, lines: child.lines })); };
    const configFile = file(listConfig([es], settings));
    assert.deepEqual(await check(configFile), { code: 0, lines: ['SERVICE_CONFIG=ok'] }, 'no store: nothing extra is printed');
    assert.equal(existsSync(path.join(directory, 'approver-keys.json')), false, 'service-check creates nothing');
    await withAuthority(directory, listConfig([es], settings), async () => {}, { keepKeyStore: true });
    assert.equal(existsSync(path.join(directory, 'approver-keys.json')), true, 'the service created it');
    assert.deepEqual(await check(configFile), { code: 0, lines: ['SERVICE_CONFIG=ok'] }, 'a store that loads is not reported');
    assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith('.tmp')), [], 'no temp file is left behind');

    const store = path.join(directory, 'approver-keys.json');
    const good = readFileSync(store, 'utf8');
    for (const [label, content, reason] of [
      ['not json', 'keys', 'approver_keys_invalid'], ['an extra key', good.replace(/\}$/u, ',"x":1}'), 'approver_keys_invalid'], ['an empty list', JSON.stringify({ v: 1, revision: 1, keys: [], signCounts: {} }), 'approver_keys_invalid'],
      ['a count for no key', JSON.stringify({ v: 1, revision: 1, keys: [es.record], signCounts: { [second.keyId]: 1 } }), 'approver_keys_invalid'],
      ['an id that is not derived', JSON.stringify({ v: 1, revision: 1, keys: [{ ...es.record, keyId: 'webauthn-0123456789abcdef' }], signCounts: {} }), 'approver_keys_invalid'],
      ['too large', `${good}${' '.repeat(40000)}`, 'approver_keys_too_large'],
    ]) {
      writeFileSync(store, content);
      assert.deepEqual(await check(configFile), { code: 80, lines: ['SERVICE_CONFIG=ok', `SERVICE_APPROVER_KEYS=invalid:${reason}`] }, label);
      const child = startProcess(exe, standInService('serve-loop', file(listConfig([es], settings), 'serve.json'), 'real', '120'), { stdin: true });
      assert.equal(await waitForExit(child), 80, `${label}: the serve loop refuses too`);
      assert.ok(child.lines.includes(`SERVICE_APPROVER_KEYS=invalid:${reason}`), child.lines.join('|'));
    }
    writeFileSync(store, good);
    assert.equal((await check(configFile)).code, 0, 'control: the good file is fine again');

    const hello = makeHelloKey();
    const both = { ...listConfig([es], settings), approverKeyId: 'hello-key-test', approverPublicKey: hello.spki };
    assert.deepEqual(await check(file(both, 'both.json')), { code: 73, lines: ['SERVICE_CONFIG=invalid:config_approver_keys'] });
    assert.deepEqual(await check(file({ ...listConfig([es], settings), approverKeys: [] }, 'empty.json')), { code: 73, lines: ['SERVICE_CONFIG=invalid:config_approver_keys'] });
    assert.deepEqual(await check(file((({ approverKeys: _list, ...rest }) => rest)(listConfig([es], settings)), 'neither.json')), { code: 73, lines: ['SERVICE_CONFIG=invalid:config_keys'] });
  });
});
