import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';
import { validateReceiptV2 } from '../src/runtime/broker-contract/receipt-v2.mjs';
import { repositoryRoot } from './helpers/windows-broker-harness.mjs';
import { buildApprover, buildAuthority, currentUserSid, getUnavailableReason, makeConfig, makeTrustedTempDirectory, runApprover, startAuthority, testOptions } from './helpers/approver-harness.mjs';

// THE APPROVER AGAINST THE REAL PHASE 2 AUTHORITY (docs/architecture/approver-webauthn.md, "Wire contract"). These tests need the Authority's `approverKeys` config, `keys`, `key_challenge` (op remove only) and `key_remove`
// and its WebAuthnPresenceVerifier, which phase 2 builds at the same time as phase 3. They are written against the contract and have NOT been run: when the Authority sources contain no WebAuthnPresenceVerifier (phase 2
// is not in this tree) the whole file is skipped with that reason, and it starts running the day phase 2 lands. The same flows against a fake Authority, with a Node verifier written from the contract's text,
// are in runtime-approver-webauthn.test.mjs and run now.
const authoritySources = path.join(repositoryRoot, 'src', 'runtime', 'windows-approval-authority');
const phase2Present = existsSync(authoritySources) && readdirSync(authoritySources).filter((f) => f.endsWith('.cs')).some((f) => readFileSync(path.join(authoritySources, f), 'utf8').includes('WebAuthnPresenceVerifier'));
const skipReason = getUnavailableReason() || (phase2Present ? false : 'phase 2 (the Authority\'s WebAuthnPresenceVerifier and key verbs) is not in this tree yet');

const ACTION = { action: 'environment.start', projectId: 'proj-alpha', computerId: 'pc-01', args: { vmName: 'alpha', cpu: 2, fast: true } };
const submitRequest = () => ({
  v: 1, verb: 'submit', purpose: 'broker.operation', operationId: 'op-1', idempotencyKey: 'idem-1', leaseId: 'lease-1', leaseGeneration: 7, brokerEpoch: 3, brokerChallenge: '_-7dzLuqmYh3ZlVEMyIRAA', action: ACTION,
});
const sha256 = (data) => createHash('sha256').update(data).digest();

function makeWebAuthnKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const credentialId = randomBytes(32).toString('base64url');
  return { record: { keyId: `webauthn-${sha256(spki).subarray(0, 8).toString('hex')}`, kind: 'webauthn', alg: -7, publicKey: spki.toString('base64'), credentialId }, pkcs8: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), credentialId };
}

describe('Approver (test-faults, software WebAuthn authenticator) against the real Authority', { skip: skipReason, timeout: 900_000 }, () => {
  let root, authorityExe, exe, trusted, sid;
  before(() => {
    root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'albera-approver-wa-it-')));
    authorityExe = buildAuthority(path.join(root, 'authority'), { faults: true });
    exe = buildApprover(path.join(root, 'faults'), { faults: true });
    trusted = makeTrustedTempDirectory('albera-approver-wa-cfg-');
    sid = currentUserSid();
  });
  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    if (trusted) rmSync(trusted, { recursive: true, force: true });
  });

  /** An Authority whose approver keys are exactly `keys` (the contract: `approverKeys`, never together with the legacy pair). */
  async function withAuthority(keys, body) {
    const config = makeConfig();
    delete config.approverKeyId;
    delete config.approverPublicKey;
    config.approverKeys = keys.map((k) => k.record);
    const authority = await startAuthority(authorityExe, trusted, { config });
    try { return await body(authority); } finally { await authority.stop(); }
  }
  const app = (authority, args, { held, keysDir, stdin = 'yes\n' }) => runApprover(exe, [...args, ...testOptions(authority, { sid }), '--test-webauthn', 'on', '--test-keys-dir', keysDir, '--test-remote-session', 'no',
    ...(held ? ['--test-webauthn-key', held.pkcs8, '--test-webauthn-credential', held.credentialId] : [])], { stdin });
  const folder = () => realpathSync.native(mkdtempSync(path.join(root, 'keys-')));

  it('approve with a registered WebAuthn key: the real verifier accepts the proof, and the receipt names that key', async () => {
    const key = makeWebAuthnKey();
    await withAuthority([key], async (authority) => {
      const submitted = await authority.submit(submitRequest());
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      const result = await app(authority, ['approve', submitted.approvalId], { held: key, keysDir: folder() });
      assert.deepEqual([result.code, result.stderr], [0, '']);
      const approved = await authority.submit({ v: 1, verb: 'status', approvalId: submitted.approvalId });
      assert.equal(approved.state, 'approved');
      const verdict = validateReceiptV2(Buffer.from(approved.receipt, 'base64'), {
        clock: () => Math.floor(Date.now() / 1000), environment: 'test', action: ACTION,
        expected: { audience: 'albera-host-broker', purpose: 'broker.operation', operationId: 'op-1', idempotencyKey: 'idem-1', leaseId: 'lease-1', leaseGeneration: 7, brokerEpoch: 3, brokerChallenge: '_-7dzLuqmYh3ZlVEMyIRAA', policyVersion: 'policy-test' },
      });
      assert.equal(verdict.ok, true, JSON.stringify(verdict));
      assert.equal(verdict.receipt.approverKeyId, key.record.keyId, 'the receipt names the key that verified');
      assert.equal(verdict.receipt.actionDigest, computeActionDigest('broker.operation', ACTION));
    });
  });

  it('keys list shows the registered keys; keys remove goes through the real key challenge and the Authority\'s own key store (keys are added only by the elevated set-approver, so the config holds both here)', async () => {
    const first = makeWebAuthnKey(), second = makeWebAuthnKey();
    const keysDir = folder();
    writeFileSync(path.join(keysDir, `${second.record.keyId}.json`), JSON.stringify(second.record)); // the record file `enroll --webauthn` writes: the canonical record
    await withAuthority([first, second], async (authority) => {
      const listed = await app(authority, ['keys', 'list'], { held: first, keysDir });
      assert.deepEqual([listed.code, listed.stderr], [0, '']);
      assert.ok(listed.stdout.startsWith('keys: 2\n') && listed.stdout.includes(first.record.keyId) && listed.stdout.includes(second.record.keyId), listed.stdout);

      const removed = await app(authority, ['keys', 'remove', second.record.keyId], { held: first, keysDir });
      assert.deepEqual([removed.code, removed.stderr], [0, '']);
      assert.deepEqual((await authority.approver({ v: 1, verb: 'keys' })).keys.map((k) => k.keyId), [first.record.keyId]);

      const last = await app(authority, ['keys', 'remove', first.record.keyId], { held: first, keysDir });
      assert.deepEqual([last.code, last.stderr.split('\n')[0]], [65, 'error: last_key']);
    });
  });
});
