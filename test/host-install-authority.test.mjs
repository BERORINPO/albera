import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildAuthority, currentUserSid, getUnavailableReason, guestSid, makeConfig, makeHelloKey, makeTrustedTempDirectory, presenceMessage, standInService, startAuthority, startProcess, waitForExit,
} from './helpers/approval-authority-harness.mjs';
import { approverRecordCases, canonicalBytes, ecKey, goodEs256, goodHello, goodRs256, makeRecord, rsaKey, spkiDer } from './helpers/approver-key-records.mjs';

// The host installer against the phase 2 Approval Authority itself (docs/architecture/approver-webauthn.md, "Wire contract"). Windows-only, same-user, unprivileged, the test-faults build of the Authority; nothing is installed,
// registered or elevated, and nothing is sent to a real AlberaApprovalAuthority service: `service-check` only reads files, and the serve-loop it runs for the store test has a random pipe root of its own.
//   1. the Authority config the installer WRITES (albera-host-lib.ps1) is accepted by the Authority's own reader (service-check);
//   2. the installer's mirror of the Authority's config rules never accepts what the Authority refuses (it may be stricter, and the places where it is are listed here);
//   3. a key store WRITTEN BY THE AUTHORITY (seeded at start, after an approval, after a key_remove) is read by the installer's store reader, and an add after that key_remove does not bring the removed key back.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const driver = path.join(root, 'test', 'host-install', 'authority-agreement.ps1');
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const sha256 = (data) => createHash('sha256').update(data).digest();
const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const RP_ID_HASH = sha256('approver.albera.local');
const REQUEST = { v: 1, verb: 'submit', purpose: 'broker.operation', operationId: 'op-1', idempotencyKey: 'idem-1', leaseId: 'lease-1', leaseGeneration: 7, brokerEpoch: 3, brokerChallenge: '_-7dzLuqmYh3ZlVEMyIRAA', action: { action: 'environment.start', projectId: 'proj-alpha', computerId: 'pc-01', args: { vmName: 'alpha' } } };

/** Windows PowerShell 5.1 runs the driver (an inherited PSModulePath, PowerShell 7's on a CI runner, would break it). */
function runDriver(directory, cases) {
  const file = path.join(directory, `cases-${randomBytes(4).toString('hex')}.json`);
  writeFileSync(file, JSON.stringify(cases));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  const stdout = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver, '-CasesFile', file], { encoding: 'utf8', timeout: 180_000, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
}

/** A throw-away authenticator credential and its key record, as the Authority's own test builds it (alg -7 ES256 / -257 RS256). */
function makeCredential(alg = -7) {
  const { privateKey, publicKey } = alg === -7 ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const credentialId = randomBytes(32);
  const keyId = `webauthn-${sha256(spki).subarray(0, 8).toString('hex')}`;
  return { privateKey, alg, credentialId, keyId, record: { keyId, kind: 'webauthn', alg, publicKey: spki.toString('base64'), credentialId: b64url(credentialId) } };
}
const helloRecord = (hello) => { const keyId = `hello-${sha256(Buffer.from(hello.spki, 'base64')).subarray(0, 8).toString('hex')}`; return { keyId, kind: 'hello-rsa', alg: -257, publicKey: hello.spki }; };
const removeMessage = (record, challenge) => Buffer.from(`albera.keyremove.v1\0${record.keyId}\0${challenge}`, 'utf8');
/** What WebAuthn gives back: authenticatorData (rpIdHash, flags UP|UV, sign count) and a signature over authenticatorData || SHA-256(clientData). */
function assertion(credential, message, count) {
  const authenticatorData = Buffer.concat([RP_ID_HASH, Buffer.from([0x05]), Buffer.from([(count >>> 24) & 255, (count >>> 16) & 255, (count >>> 8) & 255, count & 255])]);
  const client = `{"type":"webauthn.get","challenge":"${b64url(sha256(message))}","origin":"albera://approver","crossOrigin":false}`;
  const data = Buffer.concat([authenticatorData, sha256(Buffer.from(client, 'utf8'))]);
  const signature = credential.alg === -7 ? sign('sha256', data, credential.privateKey) : sign('sha256', data, { key: credential.privateKey, padding: constants.RSA_PKCS1_PADDING });
  return { kind: 'webauthn', credentialId: b64url(credential.credentialId), authenticatorData: authenticatorData.toString('base64'), signature: signature.toString('base64') };
}
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

describe('host installer and the phase 2 Approval Authority (its own reader and its own key store)', { skip: getUnavailableReason(), timeout: 900_000 }, () => {
  let work, exe, trusted;
  before(() => {
    work = mkdtempSync(path.join(os.tmpdir(), 'albera-host-authority-'));
    exe = buildAuthority(path.join(work, 'faults'), { faults: true });
    trusted = makeTrustedTempDirectory('albera-host-authority-cfg-');
  });
  after(() => {
    if (work) rmSync(work, { recursive: true, force: true });
    if (trusted) rmSync(trusted, { recursive: true, force: true });
  });

  /** The Authority's own verdict on a config text: the test-faults build's service-check told to stand in for the service, in a folder only this user can write. */
  const authorityVerdict = async (text) => {
    const file = path.join(trusted, `config-${randomBytes(5).toString('hex')}.json`);
    writeFileSync(file, text);
    const child = startProcess(exe, standInService('service-check', file));
    const code = await waitForExit(child);
    return { code, lines: child.lines };
  };
  const OK = { code: 0, lines: ['SERVICE_CONFIG=ok'] };

  it('the config the installer writes is accepted by the Authority\'s own reader: one key, a webauthn and a Hello key, an RSA-3072 key, sixteen keys, and the legacy pair', async () => {
    const es = goodEs256();
    const rs = goodRs256(3072);
    const hello = goodHello();
    const sixteen = Array.from({ length: 16 }, () => goodEs256());
    const legacy = goodHello();
    const result = runDriver(work, {
      writer: [
        { name: 'one_es256', approverSid: guestSid(), records: [b64(canonicalBytes(es))] },
        { name: 'webauthn_and_hello', approverSid: guestSid(), records: [b64(canonicalBytes(goodRs256(2048))), b64(canonicalBytes(hello))] },
        { name: 'rs256_3072', approverSid: guestSid(), records: [b64(canonicalBytes(rs))] },
        { name: 'sixteen', approverSid: guestSid(), records: sixteen.map((record) => b64(canonicalBytes(record))) },
        { name: 'legacy_pair', approverSid: guestSid(), records: [], legacy: { keyId: legacy.keyId, publicKey: legacy.publicKey } },
      ],
    });
    assert.deepEqual(Object.keys(result.writer), ['one_es256', 'webauthn_and_hello', 'rs256_3072', 'sixteen', 'legacy_pair']);
    for (const [name, written] of Object.entries(result.writer)) {
      assert.deepEqual(written.reasons, [], `${name}: the installer's own check accepts what it writes`);
      assert.deepEqual(await authorityVerdict(written.text), OK, `${name}: the Authority's own reader accepts it`);
    }
    const list = JSON.parse(result.writer.sixteen.text);
    assert.equal(list.approverKeys.length, 16);
    assert.ok(result.writer.sixteen.bytes > 4096, `sixteen keys are bigger than the old 4096-byte limit (${result.writer.sixteen.bytes}) and the Authority still reads them`);
    assert.equal('approverKeyId' in list || 'approverPublicKey' in list, false, 'the list form has no legacy pair');
    // the record sits in the config exactly as the contract's canonical text
    assert.ok(result.writer.one_es256.text.includes(`"approverKeys":[${JSON.stringify(es)}]`));
  });

  it('what the Authority refuses the installer\'s mirror refuses too: a pair and a list together, 17 keys, a list over the reply frame, a key twice - and the installer may be STRICTER, never weaker, on a record', async () => {
    const es = goodEs256();
    const base = runDriver(work, { writer: [{ name: 'base', approverSid: guestSid(), records: [b64(canonicalBytes(es))] }] }).writer.base;
    const common = JSON.parse(base.text);
    const withKeys = (records) => JSON.stringify({ ...common, approverKeys: records });
    const rsa = spkiDer(rsaKey(2048));
    // the edge of the 1900-byte metadata cap: two keys, the first with a 1023-byte credential id, the second's credential id as long as still fits - and one byte longer
    const metadataBytes = (records) => Buffer.byteLength(JSON.stringify(records.map(({ keyId, kind, credentialId }) => ({ keyId, kind, ...(credentialId ? { credentialId } : {}) }))));
    const metadataEdge = () => {
      const long = makeRecord({ spki: spkiDer(ecKey('prime256v1')), credentialId: Buffer.alloc(1023, 1).toString('base64url') });
      const spki = spkiDer(ecKey('prime256v1'));
      const second = (bytes) => makeRecord({ spki, credentialId: Buffer.alloc(bytes, 2).toString('base64url') });
      let fits = 1;
      while (metadataBytes([long, second(fits + 1)]) <= 1900) fits++;
      assert.ok(metadataBytes([long, second(fits)]) <= 1900 && metadataBytes([long, second(fits + 1)]) > 1900 && fits > 100 && fits < 1000, `the edge was found (${fits} bytes)`);
      return { metadata_largest_that_fits: withKeys([long, second(fits)]), metadata_one_credential_byte_over: withKeys([long, second(fits + 1)]) };
    };
    const texts = {
      pair_and_list: JSON.stringify({ ...common, approverKeyId: 'hello-0123456789abcdef', approverPublicKey: makeHelloKey().spki }),
      seventeen_keys: withKeys(Array.from({ length: 17 }, () => goodEs256())),
      empty_list: withKeys([]),
      list_is_a_string: JSON.stringify({ ...common, approverKeys: 'webauthn' }),
      same_key_twice: withKeys([es, es]),
      same_credential_twice: withKeys([es, { ...goodEs256(), credentialId: es.credentialId }]),
      same_rsa_key_in_two_kinds: withKeys([makeRecord({ kind: 'webauthn', alg: -257, spki: rsa }), makeRecord({ kind: 'hello-rsa', alg: -257, spki: rsa })]),
      // each valid by itself, but the `keys` reply for both would not fit one frame (1900 bytes of metadata)
      metadata_over_the_frame: withKeys([makeRecord({ spki: spkiDer(ecKey('prime256v1')), credentialId: Buffer.alloc(1023, 1).toString('base64url') }), makeRecord({ spki: spkiDer(ecKey('prime256v1')), credentialId: Buffer.alloc(1023, 2).toString('base64url') })]),
      one_long_credential: withKeys([makeRecord({ spki: spkiDer(ecKey('prime256v1')), credentialId: Buffer.alloc(1023, 1).toString('base64url') })]),
      ...metadataEdge(),
    };
    // every record-file case of the validator test, as a one-key list: the parsed JSON is what the Authority reads from a config
    const recordTexts = {};
    for (const c of approverRecordCases()) {
      let parsed;
      try { parsed = JSON.parse(c.bytes.toString('utf8')); } catch { continue; }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      recordTexts[`record:${c.name}`] = withKeys([parsed]);
    }
    const all = { ...texts, ...recordTexts };
    assert.ok(Object.keys(recordTexts).length >= 35, 'many record cases are compared');
    const mirror = runDriver(work, { configs: Object.entries(all).map(([name, text]) => ({ name, text })) }).configs;
    const verdicts = {};
    const names = Object.keys(all);
    for (let i = 0; i < names.length; i += 8) {   // a few at a time
      await Promise.all(names.slice(i, i + 8).map(async (name) => { verdicts[name] = await authorityVerdict(all[name]); }));
    }
    // Where the installer is deliberately stricter than the Authority. Each is a rule of the contract or a fail-safe, never a weaker one:
    const stricter = new Set([
      'record:rsa_exponent_3',   // the installer requires the public exponent 65537 of every RSA key (every real WebAuthn and Hello key has it); the Authority takes any exponent its crypto library imports
      'record:rsa_2047',   // the installer measures the true bit length of the modulus; the Authority's KeySize is the byte length times 8, so a 2047-bit modulus counts as 2048 there (no real key looks like that)
      'record:rsa_even_modulus',   // an RSA modulus is odd; the installer says so, the Authority hands the bytes to its crypto library, which imports an even one
    ]);
    const disagreements = [];
    const strictUsed = new Set();
    let bothAccept = 0, bothRefuse = 0;
    for (const name of names) {
      const mine = mirror[name].reasons.length === 0;
      const theirs = verdicts[name].code === 0;
      if (mine && !theirs) disagreements.push(`${name}: the installer accepts it, the Authority refuses it (${verdicts[name].lines.join(' ')})`);   // the dangerous direction: a config the Authority would not start with
      else if (!mine && theirs) { if (stricter.has(name)) strictUsed.add(name); else disagreements.push(`${name}: the Authority accepts it and the installer refuses it (${mirror[name].reasons.join(',')}); add it to the stricter list only if that is intended`); }
      if (mine && theirs) bothAccept++;
      if (!mine && !theirs) bothRefuse++;
    }
    assert.deepEqual(disagreements, []);
    assert.deepEqual([...strictUsed].sort(), [...stricter].sort(), 'every entry of the stricter list is a real difference (a stale entry would hide a future one)');
    assert.ok(bothAccept >= 8 && bothRefuse >= 25, `the comparison is not vacuous (${bothAccept} accepted by both, ${bothRefuse} refused by both)`);
    // the named lists: the installer says what the Authority says
    for (const name of ['pair_and_list', 'seventeen_keys', 'empty_list', 'list_is_a_string', 'same_key_twice', 'same_credential_twice', 'same_rsa_key_in_two_kinds', 'metadata_over_the_frame']) {
      assert.notEqual(verdicts[name].code, 0, `${name}: the Authority refuses it`);
      assert.notDeepEqual(mirror[name].reasons, [], `${name}: and so does the installer`);
    }
    assert.deepEqual(verdicts.pair_and_list, { code: 73, lines: ['SERVICE_CONFIG=invalid:config_approver_keys'] }, 'the Authority\'s own reason word for a pair and a list together is the installer\'s');
    assert.deepEqual(mirror.pair_and_list.reasons, ['config_approver_keys']);
    assert.deepEqual(verdicts.one_long_credential, OK);
    assert.deepEqual(mirror.one_long_credential.reasons, []);
  });

  it('a key store written by the Authority is read by the installer\'s store reader (seeded at start, after an approval, after a key_remove), and an add afterwards does not bring the removed key back', async () => {
    const es = makeCredential(-7);
    const rs = makeCredential(-257);
    const hello = makeHelloKey();
    const records = [es.record, rs.record, helloRecord(hello)];
    const written = runDriver(work, { writer: [{ name: 'config', approverSid: guestSid(), records: records.map((record) => b64(canonicalBytes(record))) }] }).writer.config;
    assert.deepEqual(written.reasons, []);
    // the config the installer wrote, made runnable by a host test: a pipe root of its own and resolvable SIDs (the serve-loop does not insist on separate principals)
    const config = { ...JSON.parse(written.text), pipeRoot: makeConfig().pipeRoot, controlPlaneSid: currentUserSid(), approverSid: currentUserSid() };
    const directory = makeTrustedTempDirectory('albera-host-authority-store-');
    const storeFile = path.join(directory, 'approver-keys.json');
    const stores = {};
    let keysAfterRemove = 0;
    try {
      const authority = await startAuthority(exe, directory, { config });
      try {
        stores.seeded = readFileSync(storeFile);
        const submitted = await authority.submit({ ...REQUEST });
        const entry = (await authority.approver({ v: 1, verb: 'list' })).pending.find((e) => e.approvalId === submitted.approvalId);
        assert.deepEqual(await authority.approver({ v: 1, verb: 'decide', approvalId: entry.approvalId, decision: 'approve', presence: assertion(es, presenceMessage(entry), 5) }), { ok: true, state: 'approved' });
        stores.afterApproval = readFileSync(storeFile);
        const { challenge } = await authority.approver({ v: 1, verb: 'key_challenge', op: 'remove', keyId: rs.keyId });
        const removed = await authority.approver({ v: 1, verb: 'key_remove', keyId: rs.keyId, challenge, by: assertion(es, removeMessage(rs.record, challenge), 6) });
        assert.equal(removed.ok, true, JSON.stringify(removed));
        stores.afterRemove = readFileSync(storeFile);
        keysAfterRemove = (await authority.approver({ v: 1, verb: 'keys' })).keys.length;
      } finally { await authority.stop(); }
      // the legacy pair, in the two shapes the Authority seeds a store from: an id that IS the hash of the key, and one that is not (the Authority keeps the id it was given)
      const derived = helloRecord(hello).keyId;
      for (const [name, keyId] of [['legacyDerivedId', derived], ['legacyOtherId', 'hello-key-test']]) {
        const legacyAuthority = await startAuthority(exe, directory, { config: makeConfig({ approverKeyId: keyId, approverPublicKey: hello.spki }) });
        try { stores[name] = readFileSync(storeFile); } finally { await legacyAuthority.stop(); }
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
    assert.equal(keysAfterRemove, 2, 'the Authority itself holds two keys after the remove');
    const added = goodEs256();
    const read = runDriver(work, {
      stores: Object.entries(stores).map(([name, bytes]) => ({ name, b64: b64(bytes), ...(name === 'afterRemove' ? { given: [b64(canonicalBytes(added))] } : {}) })),
    }).stores;
    const seeded = JSON.parse(stores.seeded.toString('utf8'));
    assert.deepEqual([Object.keys(seeded), seeded.revision, seeded.signCounts], [['v', 'revision', 'keys', 'signCounts'], 1, {}], 'the seeded store has the shape the installer reads');
    assert.deepEqual(read.seeded, { ok: true, reasons: [], keyIds: [es.keyId, rs.keyId, helloRecord(hello).keyId] });
    const approved = JSON.parse(stores.afterApproval.toString('utf8'));
    assert.deepEqual([approved.revision, approved.signCounts], [2, { [es.keyId]: 5 }], 'a sign count is in the store after the approval');
    assert.deepEqual(read.afterApproval, { ok: true, reasons: [], keyIds: [es.keyId, rs.keyId, helloRecord(hello).keyId] });
    const afterRemove = JSON.parse(stores.afterRemove.toString('utf8'));
    assert.deepEqual([afterRemove.revision, afterRemove.keys.map((k) => k.keyId), afterRemove.signCounts], [3, [es.keyId, helloRecord(hello).keyId], { [es.keyId]: 6 }]);
    assert.deepEqual({ ok: read.afterRemove.ok, reasons: read.afterRemove.reasons, keyIds: read.afterRemove.keyIds }, { ok: true, reasons: [], keyIds: [es.keyId, helloRecord(hello).keyId] }, 'the installer reads the store without the removed key');
    // THE POINT: the config still names the removed key, the store does not; an add starts from the store
    assert.ok(config.approverKeys.some((k) => k.keyId === rs.keyId), 'the config the installer wrote still names the removed key');
    assert.deepEqual(read.afterRemove.addIds, [es.keyId, helloRecord(hello).keyId, added.keyId], 'the final list after an add has the added key and NOT the removed one');
    assert.equal(read.afterRemove.addIds.includes(rs.keyId), false);
    assert.equal(read.afterRemove.addOk, true);
    // the legacy pair seeds a store with the id it was given: the installer reads it when that id is the key's hash (the owner's real key is), and refuses a store it could not carry into approverKeys otherwise
    assert.deepEqual(read.legacyDerivedId, { ok: true, reasons: [], keyIds: [helloRecord(hello).keyId] });
    assert.equal(read.legacyOtherId.ok, false);
    assert.deepEqual(read.legacyOtherId.reasons, ['store_key:record_key_id_form', 'store_key:record_key_id_mismatch'], 'an id that is not "hello-" and the hash of the key cannot be carried into approverKeys: an add is refused (use -Replace)');
  });
});
