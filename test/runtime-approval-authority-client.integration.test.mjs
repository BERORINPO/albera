import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';
import { validateReceiptV2 } from '../src/runtime/broker-contract/receipt-v2.mjs';
import { captureExecutableIdentity } from '../src/runtime/executable-identity.mjs';
import { AUTHORITY_CLIENT_PRESEND_CODES, getApprovalStatus, submitApproval } from '../src/runtime/approval-authority-client.mjs';
import { buildPipeClient, nodePipeOwnerSid } from './helpers/windows-broker-harness.mjs';
import {
  VIRTUAL_ACCOUNT_SID, buildAuthority, currentUserSid, getUnavailableReason, guestSid, helloSignature, makeConfig, makeHelloKey, makeTrustedTempDirectory, presenceMessage,
  startAuthority,
} from './helpers/approval-authority-harness.mjs';

// Windows-only, same-user, unprivileged: the Node client + the trusted .NET pipe client helper + the REAL Approval Authority (test-faults build: in-memory ECDSA
// signer, SHA-256 fake or real RSA presence), plus hostile same-user pipe servers. No service, ACL change, admin or Hyper-V. Skipped without the .NET 10 SDK.
// Proves the SAME-USER verification only; the service identity (SCM PID, service owner SID, session 0) stays lab-only (#23).
const NOW = () => Math.floor(Date.now() / 1000);
const ACTION = { action: 'environment.start', projectId: 'proj-alpha', computerId: 'pc-01', args: { vmName: 'alpha', cpu: 2, fast: true } };
const FIELDS = { purpose: 'broker.operation', operationId: 'op-1', idempotencyKey: 'idem-1', leaseId: 'lease-1', leaseGeneration: 7, brokerEpoch: 3, brokerChallenge: '_-7dzLuqmYh3ZlVEMyIRAA', action: ACTION };
const MISMATCH = { ok: false, code: 'server_identity_mismatch' };

describe('Approval Authority submit client: the Node client, the real helper and the real Authority', { skip: getUnavailableReason(), timeout: 600_000 }, () => {
  let root, exe, helper, trusted, sid, nodeOwner, authorityImage;
  before(async () => {
    root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'albera-authority-client-it-'))); // long form: TEMP may be an 8.3 short name
    exe = buildAuthority(path.join(root, 'faults'), { faults: true });
    helper = await buildPipeClient(path.join(root, 'helper'));
    trusted = makeTrustedTempDirectory('albera-authority-client-cfg-');
    sid = currentUserSid();
    nodeOwner = nodePipeOwnerSid(); // owner of the Node-made squatter / fake Broker pipes (Administrators when elevated)
    authorityImage = (await captureExecutableIdentity(exe)).sha256;
  });
  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    if (trusted) rmSync(trusted, { recursive: true, force: true });
  });

  /** Run `body` against a fresh Authority (real RSA presence with `hello`) and always stop it. */
  async function withAuthority(body, { hello = makeHelloKey(), config = {} } = {}) {
    const authority = await startAuthority(exe, trusted, { config: makeConfig({ approverPublicKey: hello.spki, ...config }) });
    try { return await body(authority, hello); } finally { await authority.stop(); }
  }
  const expectFor = (authority, overrides = {}) => ({ ownerSid: sid, pid: authority.child.pid, imageSha256: authorityImage, ...overrides });
  const connection = (authority, expect = expectFor(authority)) => ({ pipeRoot: authority.config.pipeRoot, expect, helperPath: helper, timeoutMs: 10_000 });
  const clientFor = (authority, expect) => ({
    submit: (fields = {}) => submitApproval({ ...FIELDS, ...connection(authority, expect), ...fields }),
    status: (approvalId) => getApprovalStatus({ approvalId, ...connection(authority, expect) }),
  });
  const pending = async (authority) => (await authority.approver({ v: 1, verb: 'list' })).pending;
  const verifyEcdsa = (publicKey, receipt, signature) => verify('sha256', receipt, { key: createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }), dsaEncoding: 'ieee-p1363' }, signature);
  const contextFor = (fields) => ({
    clock: NOW, environment: 'test', action: fields.action,
    expected: { audience: 'albera-host-broker', purpose: fields.purpose, operationId: fields.operationId, idempotencyKey: fields.idempotencyKey, leaseId: fields.leaseId,
      leaseGeneration: fields.leaseGeneration, brokerEpoch: fields.brokerEpoch, brokerChallenge: fields.brokerChallenge, policyVersion: 'policy-test' },
  });

  it('submit -> approver approves with presence -> status returns a receipt that validates with the contract and verifies with the signer key', async () => {
    await withAuthority(async (authority, hello) => {
      const client = clientFor(authority);
      const submitted = await client.submit({ includeDigest: true }); // also proves the Authority's own digest equals the Node computation
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      assert.equal(submitted.state, 'pending');
      assert.ok(submitted.expiresAt - NOW() <= 120 && submitted.expiresAt - NOW() >= 110, 'TTL is 120 s');
      assert.deepEqual(await client.status(submitted.approvalId), { ok: true, state: 'pending', expiresAt: submitted.expiresAt });

      const [entry] = await pending(authority);
      assert.equal(entry.approvalId, submitted.approvalId);
      assert.deepEqual(entry.action, ACTION, 'the human sees the exact DTO that was submitted');
      assert.equal(entry.actionDigest, computeActionDigest('broker.operation', ACTION));
      assert.deepEqual(await authority.approver({ v: 1, verb: 'decide', approvalId: entry.approvalId, decision: 'approve', presence: helloSignature(hello.privateKey, presenceMessage(entry)) }), { ok: true, state: 'approved' });

      const approved = await client.status(submitted.approvalId);
      assert.deepEqual(Object.keys(approved).sort(), ['ok', 'receipt', 'signature', 'state']);
      assert.equal(approved.state, 'approved');
      const receiptBytes = Buffer.from(approved.receipt, 'base64');
      assert.equal(verifyEcdsa(authority.publicKey, receiptBytes, Buffer.from(approved.signature, 'base64')), true, 'signature verifies with the (fake) signer key');
      const verdict = validateReceiptV2(receiptBytes, contextFor(FIELDS));
      assert.equal(verdict.ok, true, JSON.stringify(verdict));
      assert.equal(verdict.receipt.approvalId, submitted.approvalId);
      assert.equal(verdict.receipt.brokerChallenge, FIELDS.brokerChallenge);

      const again = await client.submit(); // same operationId + idempotencyKey: the first request, now approved
      assert.deepEqual(again, { ok: true, approvalId: submitted.approvalId, state: 'approved', expiresAt: again.expiresAt });
    });
  });

  it('strings with non-ASCII text, quotes and backslashes cross the helper byte for byte: the human sees them exactly', async () => {
    await withAuthority(async (authority) => {
      const args = { label: 'café "q" \\ あ😀', other: 'café' };
      const submitted = await clientFor(authority).submit({ operationId: 'op-unicode', idempotencyKey: 'idem-unicode', action: { ...ACTION, args }, includeDigest: true });
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      const [entry] = await pending(authority);
      assert.deepEqual(entry.action.args, args);
      assert.equal(entry.actionDigest, computeActionDigest('broker.operation', { ...ACTION, args }));
    });
  });

  it('a denial and an unknown approval come back as the Authority\'s fixed codes (post-send, never retry-safe)', async () => {
    await withAuthority(async (authority) => {
      const client = clientFor(authority);
      const submitted = await client.submit({ operationId: 'op-deny', idempotencyKey: 'idem-deny' });
      const [entry] = await pending(authority);
      assert.deepEqual(await authority.approver({ v: 1, verb: 'decide', approvalId: entry.approvalId, decision: 'deny' }), { ok: true, state: 'denied' });
      assert.deepEqual(await client.status(submitted.approvalId), { ok: false, code: 'human_denied' });
      const unknown = await client.status('3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b');
      assert.deepEqual(unknown, { ok: false, code: 'request_invalid' });
      assert.equal(AUTHORITY_CLIENT_PRESEND_CODES.includes('human_denied') || AUTHORITY_CLIENT_PRESEND_CODES.includes('request_invalid'), false);
    });
  });

  it('wrong owner SID, wrong PID or wrong image hash against the real Authority: mismatch, and nothing is queued', async () => {
    await withAuthority(async (authority) => {
      const wrong = {
        'owner SID': expectFor(authority, { ownerSid: VIRTUAL_ACCOUNT_SID }),
        'PID': expectFor(authority, { pid: authority.child.pid + 4 }),
        'image hash': expectFor(authority, { imageSha256: '0'.repeat(64) }),
      };
      for (const [label, expect] of Object.entries(wrong)) {
        assert.deepEqual(await clientFor(authority, expect).submit({ operationId: `op-${label.replace(/\W/gu, '')}` }), MISMATCH, label);
        assert.deepEqual(await clientFor(authority, expect).status('3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b'), MISMATCH, label);
      }
      assert.deepEqual(await pending(authority), [], 'the Authority never saw a request');
    });
  });

  it('squatter that holds the submit pipe name: server_identity_mismatch and the squatter receives 0 bytes; the same squatter with its own PID is accepted (control)', async () => {
    await withAuthority(async (authority) => {
      const squatterRoot = `ALBERA_Squat\\t${authority.config.pipeRoot.slice(-12)}`;
      const squatter = { connections: 0, bytes: 0 };
      const server = net.createServer((socket) => { squatter.connections += 1; socket.on('data', (data) => { squatter.bytes += data.length; }); socket.on('error', () => {}); });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\${squatterRoot}\\submit\\v1`, resolve); });
      try {
        const expectReal = expectFor(authority);
        assert.deepEqual(await submitApproval({ ...FIELDS, pipeRoot: squatterRoot, expect: expectReal, helperPath: helper, timeoutMs: 10_000 }), MISMATCH);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(squatter.bytes, 0, 'nothing was written to the squatter');

        // Control: the identity check, not a connection problem, refused it. With the squatter's own PID the helper writes the frame (and then waits for a reply that never comes).
        const own = await submitApproval({ ...FIELDS, pipeRoot: squatterRoot, expect: { ownerSid: nodeOwner, pid: process.pid }, helperPath: helper, timeoutMs: 1000 });
        assert.deepEqual(own, { ok: false, code: 'timeout' });
        assert.ok(squatter.bytes > 4, 'the control request reached the squatter');
      } finally { await new Promise((resolve) => server.close(resolve)); }
      assert.deepEqual(await pending(authority), []);
    });
  });

  /** Run the helper directly (a Broker `fence` request) against a Node pipe server that answers with `reply`; resolves with the helper's output line. */
  async function fenceThroughHelper(reply) {
    const pipe = `ALBERA_Fence_${process.pid}_${Math.random().toString(16).slice(2, 10)}`;
    const server = net.createServer((socket) => {
      socket.on('data', () => { const body = Buffer.from(JSON.stringify(reply)); const header = Buffer.alloc(4); header.writeInt32LE(body.length); socket.end(Buffer.concat([header, body])); });
      socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\${pipe}`, resolve); });
    try {
      const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { out += chunk; });
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.stdin.end(`${JSON.stringify({ pipeName: pipe, fence: 'computer-1', timeoutMs: 5000, expect: { ownerSid: nodeOwner, pid: process.pid } })}
`);
      await closed;
      return JSON.parse(out);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  }

  it('the helper relays a Broker fence reply with leaseId, refuses one without it, and refuses a leaseId that is not a contract id', async () => {
    const four = { ok: true, brokerEpoch: 3, leaseGeneration: 7, brokerChallenge: 'AAAAAAAAAAAAAAAAAAAAAA' };
    assert.deepEqual(await fenceThroughHelper(four), { ok: false, code: 'invalid_response' }, 'a reply without leaseId is refused (the Broker always sends it since #92)');
    const five = { ok: true, brokerEpoch: 3, leaseGeneration: 7, leaseId: 'lease-1.a:b_c', brokerChallenge: 'AAAAAAAAAAAAAAAAAAAAAA' };
    const relayed = await fenceThroughHelper(five);
    assert.deepEqual(relayed, five);
    assert.deepEqual(Object.keys(relayed), ['ok', 'brokerEpoch', 'leaseGeneration', 'leaseId', 'brokerChallenge']);
    for (const leaseId of ['', '-x', 'a b', 'x'.repeat(65), 'C:\\secret', 7, null, ['a']]) {
      assert.deepEqual(await fenceThroughHelper({ ...five, leaseId }), { ok: false, code: 'invalid_response' }, JSON.stringify(leaseId));
    }
  });

  it('Authority stopped: authority_unreachable, a pre-send code', async () => {
    let expect, pipeRoot;
    await withAuthority(async (authority) => { expect = expectFor(authority); pipeRoot = authority.config.pipeRoot; });
    const gone = await submitApproval({ ...FIELDS, pipeRoot, expect, helperPath: helper, timeoutMs: 10_000 });
    assert.deepEqual(gone, { ok: false, code: 'authority_unreachable' });
    assert.ok(AUTHORITY_CLIENT_PRESEND_CODES.includes(gone.code));
    assert.deepEqual(await getApprovalStatus({ approvalId: '3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b', pipeRoot, expect, helperPath: helper, timeoutMs: 10_000 }), gone);
  });

  it('an Authority configured for another Control Plane SID answers request_invalid (its peer-SID check); the frame was sent, so it is not retry-safe', async () => {
    // A test runs as one user, which is also the Authority's own SID and therefore on the pipe's DACL: the pipe opens (access_denied needs a second account, lab-only),
    // and the Authority's per-connection peer check is what refuses this caller.
    await withAuthority(async (authority) => {
      const refused = await clientFor(authority).submit();
      assert.deepEqual(refused, { ok: false, code: 'request_invalid' });
      assert.equal(AUTHORITY_CLIENT_PRESEND_CODES.includes(refused.code), false);
      assert.deepEqual(await pending(authority), []);
    }, { config: { controlPlaneSid: guestSid() } });
  });
});
