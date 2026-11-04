import assert from 'node:assert/strict';
import { constants, createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';
import { nodePipeOwnerSid } from './helpers/windows-broker-harness.mjs';
import { buildApprover, getUnavailableReason, runApprover } from './helpers/approver-harness.mjs';

// WebAuthn presence in the approver app (docs/architecture/approver-webauthn.md, phase 3), end to end on this PC and without the real Approval Authority (phase 2 builds that at the same time).
// The test-faults AlberaApprover.exe runs with its software authenticator (an in-memory P-256 key, no webauthn.dll, no prompt) against a FAKE Authority written in this file: a Node pipe server that
// answers the contract's verbs and VERIFIES every proof with Node's crypto from the contract's text only (the literal client data, SHA-256, the rp id hash, the flags, ES256 over
// authenticatorData || SHA-256(clientData)). So the bytes the software authenticator makes are checked by a verifier that shares no code with the approver. Tests that need the real phase 2 Authority are in
// runtime-approver-webauthn-integration.test.mjs. Windows-only, same user, unprivileged. Skipped without the .NET 10 SDK.
const RP_ID_HASH = createHash('sha256').update('approver.albera.local').digest();
const sha256 = (data) => createHash('sha256').update(data).digest();
const ACTION = { action: 'environment.start', projectId: 'proj-alpha', computerId: 'pc-01', args: { vmName: 'alpha', cpu: 2, fast: true } };
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

/** A WebAuthn key as the Authority stores it (the contract's key record), with the private half kept for the software authenticator. */
function makeWebAuthnKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const credentialId = randomBytes(32);
  const record = { keyId: `webauthn-${sha256(spki).subarray(0, 8).toString('hex')}`, kind: 'webauthn', alg: -7, publicKey: spki.toString('base64'), credentialId: credentialId.toString('base64url') };
  return { record, pkcs8: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), credentialId: record.credentialId };
}

const canonical = (record) => JSON.stringify(record.kind === 'webauthn'
  ? { keyId: record.keyId, kind: record.kind, alg: record.alg, publicKey: record.publicKey, credentialId: record.credentialId }
  : { keyId: record.keyId, kind: record.kind, alg: record.alg, publicKey: record.publicKey });

/** The Authority's verification of a WebAuthn proof (contract: "The proof" and "Verification"), from the text alone. */
function webAuthnProofVerifies(proof, record, message) {
  if (proof?.constructor !== Object || JSON.stringify(Object.keys(proof)) !== '["kind","credentialId","authenticatorData","signature"]') return false;
  if (proof.kind !== 'webauthn' || proof.credentialId !== record.credentialId || !/^[A-Za-z0-9+/]+={0,2}$/u.test(proof.authenticatorData) || !/^[A-Za-z0-9+/]+={0,2}$/u.test(proof.signature)) return false;
  const authenticatorData = Buffer.from(proof.authenticatorData, 'base64');
  if (authenticatorData.length !== 37 || !authenticatorData.subarray(0, 32).equals(RP_ID_HASH)) return false;
  const flags = authenticatorData[32];
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0 || (flags & 0x40) !== 0 || (flags & 0x80) !== 0) return false;
  const clientData = Buffer.from(`{"type":"webauthn.get","challenge":"${sha256(message).toString('base64url')}","origin":"albera://approver","crossOrigin":false}`, 'utf8');
  const key = createPublicKey({ key: Buffer.from(record.publicKey, 'base64'), format: 'der', type: 'spki' });
  const signed = Buffer.concat([authenticatorData, sha256(clientData)]);
  return record.alg === -7 ? verify('sha256', signed, { key, dsaEncoding: 'der' }, Buffer.from(proof.signature, 'base64'))
    : verify('sha256', signed, { key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(proof.signature, 'base64'));
}

/**
 * A pipe server named like the approver pipe that behaves like the Authority for the verbs the approver speaks: list, keys, decide, key_challenge (op remove only), key_remove. There is no key_add (keys are
 * added only by the elevated set-approver; `state.keys` is changed from outside to stand in for it). Every proof is verified here. `state` is inspectable: the keys, the frames received (verb + length)
 * and what each decision verified as. `policyResetOnRemove` adds "policyReset":true to the key_remove reply.
 */
async function startFakeAuthority({ keys, ownerSid, policyResetOnRemove = false }) {
  const root = `ALBERA\\ApprovalAuthority\\twa${randomBytes(4).toString('hex')}`;
  const approvalId = [4, 2, 2, 2, 6].map((n) => randomBytes(n).toString('hex')).join('-');
  const entry = { seq: 1, approvalId, purpose: 'broker.operation', operationId: 'op-1', actionDigest: computeActionDigest('broker.operation', ACTION), challenge: randomBytes(16).toString('base64url'), expiresAt: Math.floor(Date.now() / 1000) + 300, action: ACTION };
  const state = { keys: [...keys], frames: [], decisions: [], removes: [], pending: { op: null, keyId: null, challenge: null } };
  const presenceMessage = Buffer.from(`albera.presence.v1\0${approvalId}\0${entry.actionDigest}\0${entry.challenge}`, 'utf8');
  const listing = (record) => (record.kind === 'webauthn' ? { keyId: record.keyId, kind: record.kind, credentialId: record.credentialId } : { keyId: record.keyId, kind: record.kind });
  const keysReply = () => ({ ok: true, keys: state.keys.map(listing) });
  const refuse = (code) => ({ ok: false, code });

  const provesAny = (proof, message) => (typeof proof === 'string'
    ? state.keys.filter((k) => k.kind === 'hello-rsa').some((k) => verify('sha256', message, { key: createPublicKey({ key: Buffer.from(k.publicKey, 'base64'), format: 'der', type: 'spki' }), padding: constants.RSA_PKCS1_PADDING }, Buffer.from(proof, 'base64')))
    : state.keys.filter((k) => k.kind === 'webauthn').some((k) => webAuthnProofVerifies(proof, k, message)));
  const orderIs = (request, names) => JSON.stringify(Object.keys(request)) === JSON.stringify(names);

  function handle(request) {
    switch (request.verb) {
      case 'list': return { ok: true, pending: [entry], more: false, lastSeq: 1 };
      case 'keys': return keysReply();
      case 'decide': {
        if (request.decision !== 'approve') return request.decision === 'presence_unavailable' ? refuse('presence_unavailable') : { ok: true, state: 'denied' };
        const ok = orderIs(request, ['v', 'verb', 'approvalId', 'decision', 'presence']) && request.approvalId === approvalId && provesAny(request.presence, presenceMessage);
        state.decisions.push({ ok, presence: request.presence });
        return ok ? { ok: true, state: 'approved' } : refuse('presence_mismatch');
      }
      case 'key_challenge': {
        if (!orderIs(request, ['v', 'verb', 'op', 'keyId']) || request.op !== 'remove') return refuse('request_invalid'); // op "add" is refused: there is no run-time add
        state.pending = { op: request.op, keyId: request.keyId, challenge: randomBytes(16).toString('base64url') };
        return { ok: true, challenge: state.pending.challenge, expiresAt: Math.floor(Date.now() / 1000) + 120 };
      }
      case 'key_remove': {
        const target = state.keys.find((k) => k.keyId === request.keyId);
        if (!orderIs(request, ['v', 'verb', 'keyId', 'challenge', 'by']) || state.pending.op !== 'remove' || state.pending.keyId !== request.keyId || request.challenge !== state.pending.challenge) return refuse('challenge_unknown');
        if (!target) return refuse('key_unknown');
        if (state.keys.length === 1) return refuse('last_key');
        const message = Buffer.from(`albera.keyremove.v1\0${target.keyId}\0${request.challenge}`, 'utf8'); // the key id and the challenge only: a key from another device (a lost one) can be removed
        const ok = provesAny(request.by, message);
        state.removes.push({ ok, message });
        state.pending = { op: null, keyId: null, challenge: null };
        if (!ok) return refuse('presence_mismatch');
        state.keys = state.keys.filter((k) => k.keyId !== target.keyId);
        return policyResetOnRemove ? { ...keysReply(), policyReset: true } : keysReply();
      }
      default: return refuse('request_invalid');
    }
  }

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length < 4 || buffer.length < 4 + buffer.readInt32LE(0)) return;
      const length = buffer.readInt32LE(0);
      const request = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
      state.frames.push({ verb: request.verb, length });
      const reply = Buffer.from(JSON.stringify(handle(request)), 'utf8');
      const header = Buffer.alloc(4);
      header.writeInt32LE(reply.length, 0);
      socket.end(Buffer.concat([header, reply]));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\${root}\\approver\\v1`, resolve); });
  return { root, approvalId, state, ownerSid, verbs: () => state.frames.map((f) => f.verb), close: () => new Promise((resolve) => server.close(resolve)) };
}

describe('WebAuthn presence: the test-faults approver (software authenticator) against a fake Authority that verifies with Node crypto', { skip: getUnavailableReason(), timeout: 900_000 }, () => {
  let root, exe, shippedExe, nodeOwner;
  before(() => {
    root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'albera-approver-wa-')));
    exe = buildApprover(path.join(root, 'faults'), { faults: true });
    shippedExe = buildApprover(path.join(root, 'shipped'), { faults: false });
    nodeOwner = nodePipeOwnerSid();
  });
  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  const folder = () => realpathSync.native(mkdtempSync(path.join(root, 'keys-')));
  /** Run the approver against `authority` with the software authenticator holding `held` (a makeWebAuthnKey result) and records going to `keysDir`. */
  const app = (authority, args, { held, keysDir = folder(), remote = false, mode = 'on', stdin = 'yes\n' } = {}) => runApprover(exe, [...args, '--test-pipe-root', authority.root, '--test-owner-sid', nodeOwner, '--test-pid', String(process.pid),
    '--test-interactive', 'yes', '--test-webauthn', mode, '--test-keys-dir', keysDir, '--test-remote-session', remote ? 'yes' : 'no',
    ...(held ? ['--test-webauthn-key', held.pkcs8, '--test-webauthn-credential', held.credentialId] : [])], { stdin });
  async function withAuthority(keys, body, options = {}) {
    const authority = await startFakeAuthority({ keys: keys.map((k) => k.record ?? k), ownerSid: nodeOwner, ...options });
    try { return await body(authority); } finally { await authority.close(); }
  }

  it('approve with a registered WebAuthn key: the decide frame carries a proof that Node\'s ES256 verifier accepts over the client data built from the contract\'s text', async () => {
    const key = makeWebAuthnKey();
    await withAuthority([key], async (authority) => {
      const result = await app(authority, ['approve', authority.approvalId], { held: key });
      assert.deepEqual([result.code, result.stderr], [0, '']);
      assert.ok(result.stdout.endsWith('result: approved\n') && result.stdout.includes('Windows will ask you to verify with a registered WebAuthn key'), result.stdout);
      assert.deepEqual(authority.verbs(), ['list', 'keys', 'decide']);
      assert.equal(authority.state.decisions.length, 1);
      assert.equal(authority.state.decisions[0].ok, true, 'the fake Authority verified the proof');
      const { presence } = authority.state.decisions[0];
      assert.equal(presence.credentialId, key.credentialId);
      const authenticatorData = Buffer.from(presence.authenticatorData, 'base64');
      assert.equal(authenticatorData.length, 37);
      assert.equal(authenticatorData[32], 0x05, 'user present + user verified');
      assert.equal(authenticatorData.readUInt32BE(33), 1, 'sign count of the first assertion');
    });
  });

  it('a proof that does not verify is refused by the verifier, not accepted by shape: the right credential id with another public key is presence_mismatch (exit 67)', async () => {
    const held = makeWebAuthnKey();
    const registered = makeWebAuthnKey().record;
    registered.credentialId = held.credentialId; // the same credential id, but the Authority knows another public key for it
    await withAuthority([registered], async (authority) => {
      const result = await app(authority, ['approve', authority.approvalId], { held });
      assert.deepEqual([result.code, result.stderr], [67, 'error: authority:presence_mismatch\n']);
      assert.equal(authority.state.decisions[0].ok, false);
    });
  });

  it('a dismissed prompt sends decide presence_unavailable with no proof; an unavailable platform sends nothing (exit 69); a remote session with only Hello registered stops BEFORE the typed yes (remote_session, exit 69)', async () => {
    const key = makeWebAuthnKey();
    await withAuthority([key], async (authority) => {
      const dismissed = await app(authority, ['approve', authority.approvalId], { held: key, mode: 'cancel' });
      assert.deepEqual([dismissed.code, dismissed.stderr], [67, 'error: authority:presence_unavailable\n']);
      assert.deepEqual(authority.verbs(), ['list', 'keys', 'decide']);
      const unavailable = await app(authority, ['approve', authority.approvalId], { held: key, mode: 'unavailable' });
      assert.deepEqual([unavailable.code, unavailable.stderr.split('\n')[0]], [69, 'error: presence_signer_unavailable']);
      assert.equal(authority.verbs().filter((v) => v === 'decide').length, 1, 'the unavailable platform sent no decide');
    });
    const helloOnly = { keyId: 'hello-951a135537287eae', kind: 'hello-rsa', alg: -257, publicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
    await withAuthority([helloOnly], async (authority) => {
      const remote = await app(authority, ['approve', authority.approvalId], { remote: true });
      assert.equal(remote.code, 69);
      const lines = remote.stderr.trimEnd().split('\n');
      assert.equal(lines[0], 'error: remote_session');
      assert.match(lines[1], /Windows Hello does not work over Remote Desktop.*enroll --webauthn.*set-approver/u);
      assert.equal(remote.stdout.includes('Type yes'), false, 'the person is never asked to type yes');
      assert.deepEqual(authority.verbs(), ['list', 'keys']);
    });
  });

  it('enroll --webauthn: refuses without the opt-in and without a console before anything is made; with them it prints the record, and the record file is the canonical JSON that Node derives from the same fields', async () => {
    const keysDir = folder();
    const noFlag = await runApprover(exe, ['enroll', '--webauthn', '--test-interactive', 'yes', '--test-webauthn', 'on', '--test-keys-dir', keysDir]);
    assert.deepEqual([noFlag.code, noFlag.stdout, noFlag.stderr.split('\n')[0]], [65, '', 'error: unattested_not_accepted']);
    const piped = await runApprover(exe, ['enroll', '--webauthn', '--accept-unattested', '--test-webauthn', 'on', '--test-keys-dir', keysDir]);
    assert.deepEqual([piped.code, piped.stdout, piped.stderr], [65, '', 'error: not_interactive\n']);
    assert.deepEqual(readdirSync(keysDir), [], 'nothing was written');

    const made = await runApprover(exe, ['enroll', '--webauthn', '--accept-unattested', '--test-interactive', 'yes', '--test-webauthn', 'on', '--test-keys-dir', keysDir]);
    assert.deepEqual([made.code, made.stderr], [0, '']);
    const field = (name) => made.stdout.split('\n').find((line) => line.startsWith(`  "${name}": `)).slice(`  "${name}": `.length).replace(/,$/u, '').replace(/^"|"$/gu, '');
    const record = { keyId: field('keyId'), kind: field('kind'), alg: Number(field('alg')), publicKey: field('publicKey'), credentialId: field('credentialId') };
    const spki = Buffer.from(record.publicKey, 'base64');
    const publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    assert.equal(publicKey.asymmetricKeyType, 'ec');
    assert.equal(publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
    assert.equal(record.kind, 'webauthn');
    assert.equal(record.alg, -7);
    assert.equal(record.keyId, `webauthn-${sha256(spki).subarray(0, 8).toString('hex')}`, 'the key id rule');
    assert.equal(Buffer.from(record.credentialId, 'base64url').length, 32);
    assert.equal(field('approverSid').startsWith('S-1-5-21-'), true);
    assert.deepEqual(readdirSync(keysDir), [`${record.keyId}.json`]);
    assert.equal(readFileSync(path.join(keysDir, `${record.keyId}.json`), 'utf8'), canonical(record), 'the file is exactly the canonical record');
    assert.match(made.stdout, /\nattestation: none \(accepted with --accept-unattested: this key is NOT proven to be hardware-backed\)\n/u);
    const recordPath = path.join(keysDir, `${record.keyId}.json`);
    assert.ok(made.stdout.includes(`record file: ${recordPath}\n`), made.stdout);
    assert.ok(made.stdout.endsWith(`next (the owner, in an elevated prompt; Windows asks for the administrator's consent): albera-host.ps1 -Mode set-approver -ApproverKeyFile "${recordPath}" -ExpectedApproverKeyId ${record.keyId}\nThis key approves nothing until set-approver has added it to the Authority. -ExpectedApproverKeyId pins the key id printed above: set-approver refuses a record file whose public key hashes to another id, so a file swapped after this command is caught.\n`), 'the exact next step');
    assert.equal(made.stdout.includes('keys add'), false, 'no run-time add is offered');
    assert.equal(/PRIVATE|pkcs8/iu.test(made.stdout), false);
  });

  it('enroll --webauthn, then (standing in for the elevated set-approver) the Authority learns the key, then keys list and keys remove from a PC that has NO record file of it (a key from another device): the remove proof verifies with Node crypto', async () => {
    const first = makeWebAuthnKey();
    const keysDir = folder();
    await withAuthority([first], async (authority) => {
      const made = await runApprover(exe, ['enroll', '--webauthn', '--accept-unattested', '--test-interactive', 'yes', '--test-webauthn', 'on', '--test-keys-dir', keysDir]);
      assert.equal(made.code, 0, made.stderr);
      const [file] = readdirSync(keysDir);
      const second = JSON.parse(readFileSync(path.join(keysDir, file), 'utf8'));
      authority.state.keys.push(second); // what the elevated set-approver does: the owner adds the record file's key; the approver cannot

      const listed = await app(authority, ['keys', 'list'], { held: first, keysDir });
      assert.deepEqual([listed.code, listed.stderr], [0, '']);
      assert.ok(listed.stdout.startsWith('keys: 2\n') && listed.stdout.includes(`key "${second.keyId}"`) && listed.stdout.includes(`credentialId: "${second.credentialId}"`), listed.stdout);

      const emptyFolder = folder(); // this PC has no record of the second key: the remove message is only the key id and the challenge
      const removed = await app(authority, ['keys', 'remove', second.keyId], { held: first, keysDir: emptyFolder });
      assert.deepEqual(readdirSync(emptyFolder), [], 'nothing was needed from, or written to, the record folder');
      assert.deepEqual([removed.code, removed.stderr], [0, '']);
      assert.ok(removed.stdout.includes('result: key removed\nkeys: 1\n') && !removed.stdout.includes('policy:'), removed.stdout);
      assert.equal(authority.state.removes.length, 1);
      assert.equal(authority.state.removes[0].ok, true, 'the remove proof verified over albera.keyremove.v1');
      assert.deepEqual(authority.state.keys.map((k) => k.keyId), [first.record.keyId]);
      assert.deepEqual(authority.verbs(), ['keys', 'keys', 'key_challenge', 'key_remove'], 'keys list, then keys remove: keys, key_challenge, key_remove');
      assert.ok(authority.state.frames.every((f) => f.length <= 2048), 'every frame fits the 2048-byte limit');

      const last = await app(authority, ['keys', 'remove', first.record.keyId], { held: first, keysDir });
      assert.deepEqual([last.code, last.stderr.split('\n')[0]], [65, 'error: last_key'], 'the last key is refused locally, before a prompt is needed');
    });
  });

  it('keys remove: "policyReset":true is reported to the person; over Remote Desktop with only Hello registered it stops before the typed yes (remote_session); keys add is a usage error and key_add is never sent', async () => {
    const first = makeWebAuthnKey(), second = makeWebAuthnKey();
    const keysDir = folder();
    await withAuthority([first, second], async (authority) => {
      const reset = await app(authority, ['keys', 'remove', second.record.keyId], { held: first, keysDir });
      assert.deepEqual([reset.code, reset.stderr], [0, '']);
      assert.match(reset.stdout, /result: key removed\npolicy: set back to careful \(the removed key had signed the policy in force\)\./u);
    }, { policyResetOnRemove: true });

    // Two Hello keys registered; over Remote Desktop nothing can sign (Hello does not work there): remote_session, before the typed yes.
    const helloRecord = () => {
      const spki = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' });
      return { keyId: `hello-${sha256(spki).subarray(0, 8).toString('hex')}`, kind: 'hello-rsa', alg: -257, publicKey: spki.toString('base64') };
    };
    const [mine, other] = [helloRecord(), helloRecord()];
    await withAuthority([mine, other], async (authority) => {
      const remote = await app(authority, ['keys', 'remove', other.keyId], { remote: true, keysDir: folder() });
      assert.equal(remote.code, 69);
      assert.equal(remote.stderr.split('\n')[0], 'error: remote_session');
      assert.equal(remote.stdout.includes('Type yes'), false, 'the person is never asked to type yes');
      assert.deepEqual(authority.verbs(), ['keys']);
    });

    await withAuthority([first], async (authority) => {
      for (const args of [['keys', 'add'], ['keys', 'add', '--accept-unattested']]) {
        const rejected = await app(authority, args, { held: first });
        assert.deepEqual([rejected.code, rejected.stdout], [64, ''], args.join(' '));
        assert.match(rejected.stderr, /^usage: AlberaApprover /u);
      }
      assert.deepEqual(authority.verbs(), [], 'nothing was sent');
    });
  });

  describe('the shipped build', () => {
    const utf16 = (text) => Buffer.from(text, 'utf16le');

    it('contains the platform WebAuthn code and none of the software authenticator or its options; the test-faults build is the other way round', () => {
      const shipped = readFileSync(path.join(root, 'shipped', 'AlberaApprover.dll'));
      const faults = readFileSync(path.join(root, 'faults', 'AlberaApprover.dll'));
      for (const name of ['SoftwareAuthenticator', 'TestSeam']) {
        assert.equal(shipped.includes(Buffer.from(name, 'utf8')), false, `${name} must not be in the shipped build`);
        assert.equal(faults.includes(Buffer.from(name, 'utf8')), true, `${name} is in the test-faults build (control)`);
      }
      for (const name of ['PlatformWebAuthn', 'WebAuthNAuthenticatorMakeCredential', 'WebAuthNAuthenticatorGetAssertion']) {
        assert.equal(shipped.includes(Buffer.from(name, 'utf8')), true, `${name} is in the shipped build`);
        assert.equal(faults.includes(Buffer.from(name, 'utf8')), false, `${name} must not be in the test-faults build (tests never reach webauthn.dll)`);
      }
      for (const literal of ['--test-webauthn', '--test-webauthn-key', '--test-webauthn-credential', '--test-keys-dir', '--test-remote-session']) {
        assert.equal(shipped.includes(utf16(literal)), false, `"${literal}" must not be in the shipped build`);
        assert.equal(faults.includes(utf16(literal)), true, `"${literal}" is in the test-faults build (control)`);
      }
    });

    it('rejects the WebAuthn test options with the usage line; refuses enroll --webauthn and the keys commands before any platform call or pipe access (no prompt can appear)', async () => {
      for (const args of [['list', '--test-webauthn', 'on', '--test-keys-dir', 'x'], ['keys', 'list', '--test-remote-session', 'yes'], ['enroll', '--webauthn', '--test-webauthn-key', 'AA==']]) {
        const rejected = await runApprover(shippedExe, args);
        assert.deepEqual([rejected.code, rejected.stdout], [64, ''], args.join(' '));
        assert.match(rejected.stderr, /^usage: AlberaApprover list \| approve <approvalId> \| deny <approvalId> \| enroll /u);
        assert.match(rejected.stderr, /enroll --webauthn --accept-unattested \| keys list \| keys remove <keyId> \| policy /u);
        assert.equal(rejected.stderr.includes('keys add'), false, 'there is no keys add');
      }
      const noFlag = await runApprover(shippedExe, ['enroll', '--webauthn']);
      assert.deepEqual([noFlag.code, noFlag.stdout, noFlag.stderr.split('\n')[0]], [65, '', 'error: unattested_not_accepted']);
      for (const args of [['enroll', '--webauthn', '--accept-unattested'], ['keys', 'remove', 'webauthn-0123456789abcdef']]) {
        const piped = await runApprover(shippedExe, args, { stdin: 'yes\n' });
        assert.deepEqual([piped.code, piped.stdout, piped.stderr.split('\n')[0]], [65, '', 'error: not_interactive'], `${args.join(' ')} with redirected stdin`);
      }
    });
  });
});
