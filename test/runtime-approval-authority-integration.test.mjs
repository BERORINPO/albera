import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';
import { createNetworkAttestation, signNetworkAttestation } from '../src/runtime/broker-contract/network-attestation.mjs';
import { createEcdsaAttestationSigner } from '../src/runtime/ecdsa-attestation-signer.mjs';
import { validateReceiptV2 } from '../src/runtime/broker-contract/receipt-v2.mjs';
import { validateReceipt } from '../src/runtime/broker-contract/receipt-v3.mjs';
import { buildProbe } from './helpers/windows-broker-harness.mjs';
import {
  CLIENT_MASK, SELF_CONTROL_MASK, VIRTUAL_ACCOUNT_SID, buildAuthority, currentUserSid, getUnavailableReason, guestSid, helloSignature, icaclsOn, makeConfig,
  makeHelloKey, makeTrustedTempDirectory, presenceMessage, standInService, startAuthority, startProcess, trustSid, waitForExit, waitForLine, writeConfig,
} from './helpers/approval-authority-harness.mjs';

// Windows-only, same-user, unprivileged: the real Authority pipes and protocol with the test-faults build (in-memory ECDSA signer, test issuer).
// A test has one user, so the Control Plane SID and the approver SID are both the current user for the flow tests; the separation of the two pipes
// is proven by (a) each pipe's verb allow-list and (b) the live DACL of each pipe with two different SIDs. Skipped without the .NET 10 SDK.
const NOW = () => Math.floor(Date.now() / 1000);
const ACTION = { action: 'environment.start', projectId: 'proj-alpha', computerId: 'pc-01', args: { vmName: 'alpha', cpu: 2, fast: true } };
const submitRequest = (overrides = {}) => ({
  v: 1, verb: 'submit', purpose: 'broker.operation', operationId: 'op-1', idempotencyKey: 'idem-1', leaseId: 'lease-1', leaseGeneration: 7, brokerEpoch: 3,
  brokerChallenge: '_-7dzLuqmYh3ZlVEMyIRAA', action: ACTION, ...overrides,
});
const ONE_OF = ['authority_unavailable', 'request_invalid', 'request_expired', 'human_denied', 'presence_unavailable', 'presence_mismatch', 'queue_full'];

describe('Approval Authority pipes (test-faults build, fake signer)', { skip: getUnavailableReason(), timeout: 600_000 }, () => {
  let root, exe, plainExe, probeExe, trusted;
  before(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'albera-authority-it-'));
    exe = buildAuthority(path.join(root, 'faults'), { faults: true });
    plainExe = buildAuthority(path.join(root, 'plain'), { faults: false });
    probeExe = buildProbe(path.join(root, 'probe'));
    trusted = makeTrustedTempDirectory('albera-authority-cfg-');
  });
  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    if (trusted) rmSync(trusted, { recursive: true, force: true });
  });

  /** Run `body` against a fresh Authority and always stop it. */
  async function withAuthority(options, body) {
    const authority = await startAuthority(exe, trusted, options);
    try { return await body(authority); } finally { await authority.stop(); }
  }
  const isFailure = (reply, code) => assert.deepEqual(reply, { ok: false, code });
  const verifyEcdsa = (publicKey, receipt, signature) => verify('sha256', receipt, { key: createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }), dsaEncoding: 'ieee-p1363' }, signature);
  const contextFor = (request, overrides = {}) => ({
    clock: NOW, environment: 'test', action: request.action, ...overrides,
    expected: { audience: 'albera-host-broker', purpose: request.purpose, operationId: request.operationId, idempotencyKey: request.idempotencyKey, leaseId: request.leaseId,
      leaseGeneration: request.leaseGeneration, brokerEpoch: request.brokerEpoch, brokerChallenge: request.brokerChallenge, policyVersion: 'policy-test', ...overrides.expected },
  });

  it('submit -> list -> decide(approve with presence) -> status returns a receipt that validates with the contract and the signer key', async () => {
    const hello = makeHelloKey();
    await withAuthority({ config: makeConfig({ approverPublicKey: hello.spki }) }, async (authority) => {
      const request = submitRequest();
      const submitted = await authority.submit(request);
      assert.deepEqual(Object.keys(submitted).sort(), ['approvalId', 'expiresAt', 'ok', 'state']);
      assert.equal(submitted.state, 'pending');
      assert.ok(submitted.expiresAt - NOW() <= 120 && submitted.expiresAt - NOW() >= 115, 'TTL is 120 s');
      assert.deepEqual(await authority.submit({ v: 1, verb: 'status', approvalId: submitted.approvalId }), { ok: true, state: 'pending', expiresAt: submitted.expiresAt });

      const listed = await authority.approver({ v: 1, verb: 'list' });
      assert.equal(listed.ok, true);
      assert.equal(listed.more, false);
      assert.equal(listed.pending.length, 1);
      const entry = listed.pending[0];
      assert.equal(entry.approvalId, submitted.approvalId);
      assert.deepEqual(entry.action, ACTION, 'the human sees the exact DTO');
      assert.equal(entry.actionDigest, computeActionDigest('broker.operation', ACTION), 'the Authority computed the digest itself');
      assert.match(entry.challenge, /^[A-Za-z0-9_-]{21}[AQgw]$/u);

      const decided = await authority.approver({ v: 1, verb: 'decide', approvalId: entry.approvalId, decision: 'approve', presence: helloSignature(hello.privateKey, presenceMessage(entry)) });
      assert.deepEqual(decided, { ok: true, state: 'approved' });

      const status = await authority.submit({ v: 1, verb: 'status', approvalId: entry.approvalId });
      assert.deepEqual(Object.keys(status).sort(), ['ok', 'receipt', 'signature', 'state']);
      assert.equal(status.state, 'approved');
      const receiptBytes = Buffer.from(status.receipt, 'base64');
      const signature = Buffer.from(status.signature, 'base64');
      assert.equal(signature.length, 64);
      assert.equal(verifyEcdsa(authority.publicKey, receiptBytes, signature), true, 'signature verifies with the (fake) signer key');
      const verdict = validateReceiptV2(receiptBytes, contextFor(request));
      assert.equal(verdict.ok, true, JSON.stringify(verdict));
      assert.equal(verdict.receipt.brokerEpoch, 3);
      assert.equal(verdict.receipt.brokerChallenge, request.brokerChallenge);
      assert.equal(verdict.receipt.leaseGeneration, 7);
      assert.equal(verdict.receipt.issuer, 'albera-test-approval-authority');
      assert.equal(verdict.receipt.kid, 'authority-key-test');
      assert.equal(verdict.receipt.approverKeyId, 'hello-key-test');
      assert.equal(verdict.receipt.approvalId, entry.approvalId);
      assert.equal(verdict.receipt.exp - verdict.receipt.iat, 120);
      assert.equal(validateReceiptV2(receiptBytes, contextFor(request, { environment: 'production' })).code, 'issuer', 'a fake-signed receipt fails production validation');
      assert.deepEqual((await authority.approver({ v: 1, verb: 'list' })).pending, [], 'a decided request leaves the queue');
    });
  });

  it('a receipt for one DTO does not validate for a tampered DTO or other broker state', async () => {
    const hello = makeHelloKey();
    await withAuthority({ config: makeConfig({ approverPublicKey: hello.spki }) }, async (authority) => {
      const request = submitRequest();
      const { approvalId } = await authority.submit(request);
      const [entry] = (await authority.approver({ v: 1, verb: 'list' })).pending;
      await authority.approver({ v: 1, verb: 'decide', approvalId, decision: 'approve', presence: helloSignature(hello.privateKey, presenceMessage(entry)) });
      const receiptBytes = Buffer.from((await authority.submit({ v: 1, verb: 'status', approvalId })).receipt, 'base64');
      assert.equal(validateReceiptV2(receiptBytes, contextFor(request)).ok, true, 'control');
      const tampered = { ...ACTION, args: { ...ACTION.args, vmName: 'beta' } };
      assert.equal(validateReceiptV2(receiptBytes, contextFor({ ...request, action: tampered })).code, 'action_digest', 'tampered DTO');
      assert.equal(validateReceiptV2(receiptBytes, contextFor(request, { expected: { brokerEpoch: 4 } })).code, 'binding', 'other epoch');
      assert.equal(validateReceiptV2(receiptBytes, contextFor(request, { expected: { brokerChallenge: 'ABEiM0RVZneImaq7zN3u_w' } })).code, 'binding', 'other challenge');
      assert.equal(validateReceiptV2(receiptBytes, contextFor(request, { clock: () => NOW() + 121 })).code, 'expired', 'after exp');
    });
  });

  it('deny: status says human_denied and no receipt exists', async () => {
    await withAuthority({}, async (authority) => {
      const { approvalId } = await authority.submit(submitRequest());
      assert.deepEqual(await authority.approver({ v: 1, verb: 'decide', approvalId, decision: 'deny' }), { ok: true, state: 'denied' });
      isFailure(await authority.submit({ v: 1, verb: 'status', approvalId }), 'human_denied');
      isFailure(await authority.approver({ v: 1, verb: 'decide', approvalId, decision: 'deny' }), 'request_invalid');
    });
  });

  it('presence failures: another key, a replayed signature and an unavailable Hello are final and reach the Control Plane as presence_* codes', async () => {
    const hello = makeHelloKey();
    const stranger = makeHelloKey();
    await withAuthority({ config: makeConfig({ approverPublicKey: hello.spki }) }, async (authority) => {
      const ids = [];
      for (const n of [1, 2, 3]) ids.push((await authority.submit(submitRequest({ operationId: `op-${n}`, idempotencyKey: `idem-${n}`, action: { ...ACTION, args: { n } } }))).approvalId);
      const entries = (await authority.approver({ v: 1, verb: 'list' })).pending;
      const [first, second, third] = ids.map((id) => entries.find((e) => e.approvalId === id));
      const decide = (entry, presence) => authority.approver({ v: 1, verb: 'decide', approvalId: entry.approvalId, decision: 'approve', presence });
      isFailure(await decide(first, helloSignature(stranger.privateKey, presenceMessage(first))), 'presence_mismatch');
      isFailure(await decide(second, helloSignature(hello.privateKey, presenceMessage(first))), 'presence_mismatch'); // a valid signature made for another request
      isFailure(await authority.approver({ v: 1, verb: 'decide', approvalId: third.approvalId, decision: 'presence_unavailable' }), 'presence_unavailable');
      isFailure(await authority.submit({ v: 1, verb: 'status', approvalId: first.approvalId }), 'presence_mismatch');
      isFailure(await authority.submit({ v: 1, verb: 'status', approvalId: second.approvalId }), 'presence_mismatch');
      isFailure(await authority.submit({ v: 1, verb: 'status', approvalId: third.approvalId }), 'presence_unavailable');
      isFailure(await decide(first, helloSignature(hello.privateKey, presenceMessage(first))), 'request_invalid'); // no second try on a finished request
      assert.deepEqual((await authority.approver({ v: 1, verb: 'list' })).pending, []);
    });
  });

  it('the fake presence verifier plugs into the same pipes (verified, mismatch, unavailable)', async () => {
    await withAuthority({ presence: 'fake' }, async (authority) => {
      const proofFor = (entry) => createHash('sha256').update(Buffer.concat([Buffer.from('albera-fake-presence\0'), presenceMessage(entry)])).digest().toString('base64');
      const ids = [];
      for (const n of [1, 2, 3]) ids.push((await authority.submit(submitRequest({ operationId: `op-${n}`, idempotencyKey: `idem-${n}` }))).approvalId);
      const entries = (await authority.approver({ v: 1, verb: 'list' })).pending;
      const decide = (id, presence) => authority.approver({ v: 1, verb: 'decide', approvalId: id, decision: 'approve', presence });
      assert.deepEqual(await decide(ids[0], proofFor(entries[0])), { ok: true, state: 'approved' });
      isFailure(await decide(ids[1], Buffer.from('nope').toString('base64')), 'presence_mismatch');
      isFailure(await decide(ids[2], Buffer.from([0x55]).toString('base64')), 'presence_unavailable');
    });
  });

  it('each pipe answers only its own verbs: list/decide on the submit pipe and submit/status on the approver pipe are request_invalid and change nothing', async () => {
    await withAuthority({}, async (authority) => {
      const { approvalId } = await authority.submit(submitRequest());
      isFailure(await authority.submit({ v: 1, verb: 'list' }), 'request_invalid');
      isFailure(await authority.submit({ v: 1, verb: 'decide', approvalId, decision: 'deny' }), 'request_invalid');
      isFailure(await authority.submit({ v: 1, verb: 'decide', approvalId, decision: 'presence_unavailable' }), 'request_invalid');
      isFailure(await authority.approver(submitRequest({ operationId: 'op-2', idempotencyKey: 'idem-2' })), 'request_invalid');
      isFailure(await authority.approver({ v: 1, verb: 'status', approvalId }), 'request_invalid');
      const { pending } = await authority.approver({ v: 1, verb: 'list' });
      assert.deepEqual(pending.map((e) => e.approvalId), [approvalId], 'still exactly the one pending request, untouched');
      assert.deepEqual(await authority.submit({ v: 1, verb: 'status', approvalId }), { ok: true, state: 'pending', expiresAt: pending[0].expiresAt });
    });
  });

  it('a digest or DTO the Control Plane tampered with is request_invalid and never queued', async () => {
    await withAuthority({}, async (authority) => {
      const wrongDigest = `sha256:${'0'.repeat(64)}`;
      isFailure(await authority.submit(submitRequest({ expectedDigest: wrongDigest })), 'request_invalid');
      isFailure(await authority.submit(submitRequest({ action: { ...ACTION, action: 'environment.explode' } })), 'request_invalid');
      isFailure(await authority.submit(submitRequest({ action: { ...ACTION, extra: 1 } })), 'request_invalid');
      isFailure(await authority.submit(submitRequest({ purpose: 'guest.command' })), 'request_invalid'); // environment.start is not a guest command
      isFailure(await authority.submit(submitRequest({ brokerChallenge: 'not-a-challenge' })), 'request_invalid');
      isFailure(await authority.submit(submitRequest({ leaseGeneration: 0 })), 'request_invalid');
      assert.deepEqual((await authority.approver({ v: 1, verb: 'list' })).pending, []);
      const accepted = await authority.submit(submitRequest({ expectedDigest: computeActionDigest('broker.operation', ACTION) }));
      assert.equal(accepted.ok, true, 'a correct expectedDigest is only a cross-check');
      const [entry] = (await authority.approver({ v: 1, verb: 'list' })).pending;
      assert.equal(entry.actionDigest, computeActionDigest('broker.operation', ACTION));
    });
  });

  it('malformed frames get request_invalid: broken JSON, null, oversized declared length, an unknown verb', async () => {
    await withAuthority({}, async (authority) => {
      isFailure(await authority.submit(null, { raw: '{"v":1,"verb":"status"' }), 'request_invalid');
      isFailure(await authority.submit(null, { raw: '{"v":1,"verb":"status","approvalId":null}' }), 'request_invalid');
      isFailure(await authority.submit(null, { raw: '{"v":1,"verb":"status","approvalId":"x","approvalId":"y"}' }), 'request_invalid');
      isFailure(await authority.submit({ v: 1, verb: 'status', approvalId: 'x' }, { declaredLength: 4096 }), 'request_invalid');
      isFailure(await authority.submit({ v: 1, verb: 'purge' }), 'request_invalid');
      isFailure(await authority.submit({ v: 1, verb: 'status', approvalId: '00000000-0000-4000-8000-000000000000' }), 'request_invalid');
      assert.equal((await authority.submit(submitRequest())).ok, true, 'the pipe keeps serving after bad frames');
    });
  });

  it('an expired request: status and decide say request_expired, nothing is listed, no receipt is made', async () => {
    const hello = makeHelloKey();
    await withAuthority({ config: makeConfig({ approverPublicKey: hello.spki }), ttl: 2 }, async (authority) => {
      const submitted = await authority.submit(submitRequest());
      const [entry] = (await authority.approver({ v: 1, verb: 'list' })).pending;
      assert.equal(entry.approvalId, submitted.approvalId);
      await new Promise((resolve) => setTimeout(resolve, 3200));
      isFailure(await authority.submit({ v: 1, verb: 'status', approvalId: entry.approvalId }), 'request_expired');
      assert.deepEqual((await authority.approver({ v: 1, verb: 'list' })).pending, []);
      isFailure(await authority.approver({ v: 1, verb: 'decide', approvalId: entry.approvalId, decision: 'approve', presence: helloSignature(hello.privateKey, presenceMessage(entry)) }), 'request_expired');
      isFailure(await authority.approver({ v: 1, verb: 'decide', approvalId: entry.approvalId, decision: 'deny' }), 'request_expired');
    });
  });

  it('queue_full: the 33rd pending request is refused, a duplicate of a queued one is not, and a decision frees a slot', async () => {
    await withAuthority({}, async (authority) => {
      const first = await authority.submit(submitRequest({ operationId: 'op-0', idempotencyKey: 'idem-0' }));
      for (let n = 1; n < 32; n += 1) assert.equal((await authority.submit(submitRequest({ operationId: `op-${n}`, idempotencyKey: `idem-${n}` }))).ok, true);
      isFailure(await authority.submit(submitRequest({ operationId: 'op-32', idempotencyKey: 'idem-32' })), 'queue_full');
      assert.equal((await authority.submit(submitRequest({ operationId: 'op-0', idempotencyKey: 'idem-0' }))).approvalId, first.approvalId, 'the same operation + key is the same request');
      await authority.approver({ v: 1, verb: 'decide', approvalId: first.approvalId, decision: 'deny' });
      assert.equal((await authority.submit(submitRequest({ operationId: 'op-32', idempotencyKey: 'idem-32' }))).ok, true);
      let after = 0;
      let seen = 0;
      for (;;) {
        const page = await authority.approver({ v: 1, verb: 'list', afterSeq: after });
        seen += page.pending.length;
        after = page.lastSeq;
        if (!page.more) break;
      }
      assert.equal(seen, 32, 'list pages through all 32 pending requests');
    });
  });

  it('every failure reply carries exactly one of the documented codes and nothing else', async () => {
    await withAuthority({}, async (authority) => {
      const replies = [
        await authority.submit({ v: 1, verb: 'list' }), await authority.submit(submitRequest({ expectedDigest: 'x' })), await authority.submit(null, { raw: 'not json' }),
        await authority.approver({ v: 1, verb: 'decide', approvalId: 'SECRET-TEXT', decision: 'deny' }),
      ];
      for (const reply of replies) {
        assert.deepEqual(Object.keys(reply).sort(), ['code', 'ok']);
        assert.ok(ONE_OF.includes(reply.code), reply.code);
      }
    });
  });

  it('live DACLs with two different principals: the Control Plane SID is on the submit pipe only, the approver SID on the approver pipe only, and a peer that is not the configured SID is refused', async () => {
    const self = currentUserSid();
    const approver = guestSid();
    const config = makeConfig({ controlPlaneSid: VIRTUAL_ACCOUNT_SID, approverSid: approver });
    const aceList = ({ aces }) => aces.map((a) => `${a.type} ${a.sid} 0x${a.mask.toString(16)}`).sort(); // Windows keeps its own canonical ACE order
    await withAuthority({ config }, async (authority) => {
      const dacl = async (pipeName) => {
        const reader = startProcess(probeExe, ['dacl', pipeName]);
        const sddl = (await waitForLine(reader, /^SDDL=/u)).slice('SDDL='.length);
        await waitForExit(reader);
        const domain = self.slice(0, self.lastIndexOf('-'));
        const resolve = (sid) => (sid === 'LA' ? `${domain}-500` : sid === 'LG' ? `${domain}-501` : sid);
        return {
          owner: resolve(/^O:([^D]+)D:/u.exec(sddl)?.[1]),
          aces: [...sddl.matchAll(/\(([A-Z]+);[^;]*;([^;]+);[^;]*;[^;]*;([^)]+)\)/gu)].map((m) => ({ type: m[1], mask: Number(m[2]), sid: resolve(m[3]) })),
        };
      };
      const submitPipe = await dacl(authority.submitPipe);
      assert.equal(submitPipe.owner, self);
      assert.deepEqual(aceList(submitPipe), aceList({ aces: [{ type: 'A', sid: self, mask: SELF_CONTROL_MASK }, { type: 'A', sid: VIRTUAL_ACCOUNT_SID, mask: CLIENT_MASK }] }));
      const approverPipe = await dacl(authority.approverPipe);
      assert.equal(approverPipe.owner, self);
      assert.deepEqual(aceList(approverPipe), aceList({ aces: [{ type: 'A', sid: self, mask: SELF_CONTROL_MASK }, { type: 'A', sid: approver, mask: CLIENT_MASK }] }));
      assert.equal(CLIENT_MASK & (0x4 | 0x40000000 | 0x10000000), 0, 'no FILE_APPEND_DATA / create-instance and no generic right');
      assert.equal(submitPipe.aces.some((a) => a.sid === approver), false, 'the approver has no access to the submit pipe');
      assert.equal(approverPipe.aces.some((a) => a.sid === VIRTUAL_ACCOUNT_SID), false, 'the Control Plane has no access to the approver pipe');

      // This test process is neither configured principal: it can open the pipes (it is the owner here) but is not an accepted peer.
      isFailure(await authority.submit(submitRequest()), 'request_invalid');
      isFailure(await authority.approver({ v: 1, verb: 'list' }), 'request_invalid');
      assert.ok(authority.child.lines.includes('PEER=Submit:denied') && authority.child.lines.includes('PEER=Approver:denied'), authority.child.lines.join('|'));
      assert.equal(authority.child.lines.includes('PEER=Submit:authenticated'), false);
    });
  });

  it('a second Authority on the same pipe names refuses to start (exit 70) while the first keeps serving', async () => {
    await withAuthority({}, async (first) => {
      const second = startProcess(exe, standInService('serve-loop', first.configFile, 'real', '120'), { stdin: true });
      assert.equal(await waitForExit(second), 70);
      assert.ok(second.lines.includes('AUTHORITY_FATAL=PIPE_UNAVAILABLE'), second.lines.join('|'));
      assert.equal((await first.submit(submitRequest())).ok, true);
    });
  });

  it('stop (end of stdin) ends the loop with exit 0', async () => {
    const authority = await startAuthority(exe, trusted);
    assert.equal(await authority.stop(), 0);
    assert.ok(authority.child.lines.includes('AUTHORITY_STOPPED'));
  });

  // Network attestation (issue #115 step 3b) through the real pipes, signed in Node (ECDSA P-256) and checked by the C# Authority against the key pinned in its config:
  // at the standard tier, start / create are signed without a person only for a valid 'none' attestation bound to this very request; everything else waits for a person.
  describe('network attestation', () => {
    const KID = 'authority-key-test';
    const AUDIENCE = 'albera-host-broker';
    const KEY_ID = 'broker-attest-it-1';
    const policyObj = (rev, tier) => ({ v: 1, rev, tier, overrides: {} });
    const policyHash = (rev, tier) => `sha256:${createHash('sha256').update(['albera.policy-hash.v2', String(rev), tier].join('\0')).digest('hex')}`;
    const policyMessage = (rev, tier) => Buffer.from(`albera.policy.v1\0${KID}\0${AUDIENCE}\0${policyHash(rev, tier)}`, 'utf8');
    const newSigner = (keyId = KEY_ID) => createEcdsaAttestationSigner({ keyId, privateKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey });
    const START = { action: 'environment.start', projectId: 'proj-alpha', computerId: 'pc-01', args: { expectedGeneration: 3, vmName: 'alpha' } };
    const startRequest = (operationId, extra = {}) => submitRequest({ operationId, idempotencyKey: operationId, action: START, ...extra });
    /** A statement as the Broker would make it for the request above, observed 5 s ago, valid for 60 s unless overridden. */
    const statement = async (signer, overrides = {}) => JSON.parse(JSON.stringify(await signNetworkAttestation(createNetworkAttestation({
      network: 'none', computerId: 'pc-01', vmId: '11111111-2222-4333-8444-555555555555', generation: 3, projectId: 'proj-alpha', leaseId: 'lease-1', leaseGeneration: 7, observedAt: NOW() - 5, ...overrides,
    }), signer)));

    const refusals = (authority) => authority.child.lines.filter((line) => line.startsWith('ATTESTATION_REFUSED='));
    /** The refusal lines the Authority printed after the first `before` ones (stdout reaches the test a moment after the reply): waits for at least one, or 300 ms when none is expected. */
    async function refusalsAfter(authority, before, expectNone) {
      for (let waited = 0; waited < (expectNone ? 300 : 5000); waited += 50) {
        if (!expectNone && refusals(authority).length > before) break;
        await new Promise((resolve) => { setTimeout(resolve, 50); });
      }
      return refusals(authority).slice(before);
    }

    /** An Authority that pins `signer`'s public key, with Hello available to raise the tier. */
    async function withPinnedAuthority(signer, body, { pin = true } = {}) {
      const hello = makeHelloKey();
      const folder = makeTrustedTempDirectory('albera-authority-attest-');
      try {
        const config = makeConfig({ approverPublicKey: hello.spki, ...(pin ? { attestationKeyId: signer.keyId, attestationPublicKey: signer.publicKeySpki } : {}) });
        const authority = await startAuthority(exe, folder, { config });
        try { return await body(authority, (rev, tier) => authority.approver({ v: 1, verb: 'policy_set', policy: policyObj(rev, tier), presence: helloSignature(hello.privateKey, policyMessage(rev, tier)) })); } finally { await authority.stop(); }
      } finally { rmSync(folder, { recursive: true, force: true }); }
    }

    it('a valid attestation signed in Node by the pinned key gets a v3 policy receipt at once; careful, no / forged / stale / mismatched / present attestations and an other action wait for a person', async () => {
      const signer = newSigner();
      await withPinnedAuthority(signer, async (authority, raise) => {
        const valid = await statement(signer);
        assert.equal((await authority.submit(startRequest('op-careful', { attestation: valid }))).state, 'pending', 'careful tier: a valid attestation is worth nothing');
        assert.deepEqual(await raise(1, 'standard'), { ok: true, policyVersion: policyHash(1, 'standard') });

        const reply = await authority.submit(startRequest('op-ok', { attestation: valid }));
        assert.equal(reply.state, 'approved');
        const status = await authority.submit({ v: 1, verb: 'status', approvalId: reply.approvalId });
        const receiptBytes = Buffer.from(status.receipt, 'base64');
        assert.equal(verifyEcdsa(authority.publicKey, receiptBytes, Buffer.from(status.signature, 'base64')), true, 'signed by the Authority');
        const request = startRequest('op-ok');
        const verdict = validateReceipt(receiptBytes, contextFor(request));
        assert.equal(verdict.ok, true, JSON.stringify(verdict));
        assert.deepEqual([verdict.receipt.v, verdict.receipt.basis, verdict.receipt.attestationDigest, verdict.receipt.policyVersion], [3, 'policy', valid.digest, policyHash(1, 'standard')]);
        assert.ok(verdict.receipt.exp <= valid.attestation.expiresAt, 'never outlives the attestation');
        assert.equal(validateReceipt(receiptBytes, contextFor(request, { environment: 'production' })).code, 'issuer', 'a test-signed receipt is not a production one');
        await waitForLine(authority.child, `POLICY_SIGNED=environment.start ${reply.approvalId} ATTESTED=${valid.digest}`);
        assert.deepEqual((await authority.approver({ v: 1, verb: 'list' })).pending.map((e) => e.operationId), ['op-careful'], 'only the careful-tier request waits');

        const refused = [
          ['no attestation', {}, null],
          ['signed by another key', { attestation: await statement(newSigner()) }, 'signature:signature'],
          ['signed under another key id', { attestation: await statement(newSigner('broker-attest-it-2')) }, 'signature:signature'],
          ['expired', { attestation: await statement(signer, { observedAt: NOW() - 100 }) }, 'expired:expiresAt'],
          ['network present', { attestation: await statement(signer, { network: 'present' }) }, 'network_present'],
          ['another lease', { attestation: await statement(signer, { leaseId: 'lease-2' }) }, 'binding:leaseId'],
          ['another lease generation', { attestation: await statement(signer, { leaseGeneration: 8 }) }, 'binding:leaseGeneration'],
          ['another generation', { attestation: await statement(signer, { generation: 4 }) }, 'binding:generation'],
          ['another computer', { attestation: await statement(signer, { computerId: 'pc-02' }) }, 'binding:computerId'],
          ['another project', { attestation: await statement(signer, { projectId: 'proj-beta' }) }, 'binding:projectId'],
          ['a body changed after signing', { attestation: { ...valid, attestation: { ...valid.attestation, network: 'present' } } }, 'digest:digest'],
          ['not an envelope', { attestation: 5 }, 'malformed'],
        ];
        let n = 0;
        for (const [label, extra, reason] of refused) {
          const before = refusals(authority).length;
          const answer = await authority.submit(startRequest(`op-refused-${n++}`, extra));
          assert.equal(answer.state, 'pending', label);
          assert.deepEqual(await refusalsAfter(authority, before, reason === null), reason === null ? [] : [`ATTESTATION_REFUSED=${reason}`], label);
        }
        // The same valid statement does nothing for an action that cannot skip a person, nor for start with another generation arg.
        const destroy = await authority.submit(startRequest('op-destroy', { action: { ...START, action: 'environment.destroy' }, attestation: valid }));
        assert.equal(destroy.state, 'pending');
        const otherGeneration = await authority.submit(startRequest('op-gen', { action: { ...START, args: { expectedGeneration: 4 } }, attestation: valid }));
        assert.equal(otherGeneration.state, 'pending', 'the statement is for generation 3');
        const create = await authority.submit(startRequest('op-create', { action: { ...START, action: 'environment.create' }, attestation: valid }));
        assert.equal(create.state, 'approved', 'create is covered the same way');
      });
    });

    it('a malformed attestation key in the config stops the start (config_keys / attestation_public_key / attestation_key_id) and an existing config without it still starts', async () => {
      const signer = newSigner();
      const folder = makeTrustedTempDirectory('albera-authority-attest-cfg-');
      try {
        const attempt = async (name, config) => {
          const child = startProcess(exe, standInService('serve-loop', writeConfig(folder, config, name), 'real', '120'), { stdin: true });
          const code = await waitForExit(child);
          return { code, lines: child.lines.filter((line) => line.startsWith('SERVICE_CONFIG=')) };
        };
        const bad = (reason) => ({ code: 73, lines: [`SERVICE_CONFIG=invalid:${reason}`] });
        assert.deepEqual(await attempt('id-only.json', makeConfig({ attestationKeyId: KEY_ID })), bad('config_keys'));
        assert.deepEqual(await attempt('key-only.json', makeConfig({ attestationPublicKey: signer.publicKeySpki })), bad('config_keys'));
        assert.deepEqual(await attempt('bad-id.json', makeConfig({ attestationKeyId: 'bad id', attestationPublicKey: signer.publicKeySpki })), bad('attestation_key_id'));
        assert.deepEqual(await attempt('rsa.json', makeConfig({ attestationKeyId: KEY_ID, attestationPublicKey: makeHelloKey().spki })), bad('attestation_public_key'));
        assert.deepEqual(await attempt('p384.json', makeConfig({ attestationKeyId: KEY_ID, attestationPublicKey: generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64') })), bad('attestation_public_key'));
        assert.deepEqual(await attempt('junk.json', makeConfig({ attestationKeyId: KEY_ID, attestationPublicKey: 'AAAA' })), bad('attestation_public_key'));
      } finally { rmSync(folder, { recursive: true, force: true }); }
      // No key pinned (an existing config): it starts, and at the standard tier an attestation is ignored: the request waits for a person, and the reason is on the audit line.
      await withPinnedAuthority(signer, async (authority, raise) => {
        await raise(1, 'standard');
        assert.equal((await authority.submit(startRequest('op-nokey', { attestation: await statement(signer) }))).state, 'pending');
        await waitForLine(authority.child, 'ATTESTATION_REFUSED=no_key_pinned');
      }, { pin: false });
    });
  });

  // Tier policy (issue #115 step 3) through the real pipes: the policy file next to the config, the careful default, the standard tier, and the Hello-signed change.
  // A policy that skips a person is only loaded with the approver's signature (bound to this Authority's kid and audience) stored in the file; the config folder must be trusted first.
  describe('tier policy', () => {
    const KID = 'authority-key-test'; // makeConfig's kid and audience
    const AUDIENCE = 'albera-host-broker';
    const policyObj = (rev, tier, ...prompts) => ({ v: 1, rev, tier, overrides: Object.fromEntries(prompts.map((a) => [a, 'prompt'])) });
    const policyJson = (rev, tier, ...prompts) => JSON.stringify(policyObj(rev, tier, ...prompts));
    const policyHash = (rev, tier, prompts) => `sha256:${createHash('sha256').update(['albera.policy-hash.v2', String(rev), tier, ...[...prompts].sort()].join('\0')).digest('hex')}`;
    const policyMessage = (rev, tier, prompts = [], kid = KID, audience = AUDIENCE) => Buffer.from(`albera.policy.v1\0${kid}\0${audience}\0${policyHash(rev, tier, prompts)}`, 'utf8');
    /** policy.json as the Authority writes it: the policy, and the policy the signature authorized with that signature. */
    const signedFile = (policy, authorized, presence) => JSON.stringify({ ...policy, authorized: { ...authorized, presence } });
    const STOP = { action: 'environment.stop', projectId: 'proj-alpha', computerId: 'pc-01', args: {} };
    const DESTROY = { ...STOP, action: 'environment.destroy' };
    const stopRequest = (overrides = {}) => submitRequest({ operationId: 'op-stop', idempotencyKey: 'idem-stop', action: STOP, ...overrides });
    /** A fresh trusted folder (config and policy.json share it); removed afterwards. */
    async function inFolder(body) {
      const folder = makeTrustedTempDirectory('albera-authority-policy-');
      try { return await body(folder); } finally { rmSync(folder, { recursive: true, force: true }); }
    }
    /** A fresh Authority whose config and policy.json live in `folder`; always stopped. */
    const run = async (folder, options, body) => {
      const authority = await startAuthority(exe, folder, options);
      try { return await body(authority); } finally { await authority.stop(); }
    };
    const standardFile = (hello) => signedFile(policyObj(1, 'standard'), policyObj(1, 'standard'), helloSignature(hello.privateKey, policyMessage(1, 'standard')));

    it('with no policy file the Authority is careful: every action, the skippable ones included, waits for a person, and nothing is signed', async () => {
      await inFolder((folder) => run(folder, {}, async (authority) => {
        for (const [index, action] of [STOP, { ...STOP, action: 'environment.inspect' }].entries()) {
          const reply = await authority.submit(stopRequest({ operationId: `op-${index}`, idempotencyKey: `idem-${index}`, action }));
          assert.equal(reply.state, 'pending', action.action);
        }
        assert.equal((await authority.approver({ v: 1, verb: 'list' })).pending.length, 2);
        assert.deepEqual(await authority.approver({ v: 1, verb: 'policy' }), {
          ok: true, policy: { v: 1, rev: 0, tier: 'careful', overrides: {} }, policyVersion: policyHash(0, 'careful', []), kid: KID, audience: AUDIENCE,
        });
      }));
    });

    it('a signed standard policy file is applied from the first request: a skippable action is signed at once with a v3 policy receipt that validates and verifies; the others still wait', async () => {
      const hello = makeHelloKey();
      await inFolder(async (folder) => {
        writeFileSync(path.join(folder, 'policy.json'), standardFile(hello));
        await run(folder, { config: makeConfig({ approverPublicKey: hello.spki }) }, async (authority) => {
          const request = stopRequest();
          const reply = await authority.submit(request);
          assert.equal(reply.state, 'approved');
          const status = await authority.submit({ v: 1, verb: 'status', approvalId: reply.approvalId });
          const receiptBytes = Buffer.from(status.receipt, 'base64');
          assert.equal(verifyEcdsa(authority.publicKey, receiptBytes, Buffer.from(status.signature, 'base64')), true);
          const verdict = validateReceipt(receiptBytes, contextFor(request));
          assert.equal(verdict.ok, true, JSON.stringify(verdict));
          assert.deepEqual([verdict.receipt.v, verdict.receipt.basis, verdict.receipt.policyVersion], [3, 'policy', policyHash(1, 'standard', [])]);
          assert.equal(validateReceipt(receiptBytes, contextFor(request, { environment: 'production' })).code, 'issuer', 'a fake-signed policy receipt fails production validation too');
          assert.equal(validateReceipt(receiptBytes, contextFor({ ...request, action: { ...STOP, computerId: 'pc-02' } })).ok, false, 'not for another computer');
          assert.deepEqual((await authority.approver({ v: 1, verb: 'list' })).pending, [], 'nobody is asked');
          assert.ok(authority.child.lines.includes(`POLICY_SIGNED=environment.stop ${reply.approvalId}`), `the signature without a person is reported: ${authority.child.lines.join('|')}`);
          const destroy = await authority.submit(stopRequest({ operationId: 'op-destroy', idempotencyKey: 'idem-destroy', action: DESTROY }));
          assert.equal(destroy.state, 'pending', 'destroy still needs a person at standard');
          assert.equal((await authority.approver({ v: 1, verb: 'list' })).pending.length, 1);
        });
      });
    });

    it('Control Plane input cannot change the decision: tier, basis, policy and presence fields in a submit are request_invalid, and the same destroy is pending under both tiers', async () => {
      const hello = makeHelloKey();
      await inFolder(async (folder) => {
        writeFileSync(path.join(folder, 'policy.json'), standardFile(hello));
        await run(folder, { config: makeConfig({ approverPublicKey: hello.spki }) }, async (authority) => {
          for (const extra of [{ tier: 'standard' }, { basis: 'policy' }, { policy: policyObj(9, 'standard') }, { policyVersion: policyHash(9, 'standard', []) }, { presence: 'AAAA' }]) {
            isFailure(await authority.submit(submitRequest({ action: DESTROY, ...extra })), 'request_invalid');
          }
          isFailure(await authority.submit({ v: 1, verb: 'policy' }), 'request_invalid');
          isFailure(await authority.submit({ v: 1, verb: 'policy_set', policy: policyObj(2, 'careful') }), 'request_invalid');
          assert.equal((await authority.approver({ v: 1, verb: 'policy' })).policy.tier, 'standard', 'the Control Plane pipe changed nothing');
          assert.equal((await authority.submit(submitRequest({ action: DESTROY }))).state, 'pending');
        });
      });
    });

    it('the Hello-signed change over the pipes: raising needs the signature for THIS Authority and THIS policy (none, wrong domain, wrong hash, another kid or audience: presence_mismatch), a valid one is applied and written with it, lowering needs none, and a restart keeps it', async () => {
      const hello = makeHelloKey();
      await inFolder(async (folder) => {
        const config = makeConfig({ approverPublicKey: hello.spki });
        const sign = (message) => helloSignature(hello.privateKey, message);
        await run(folder, { config }, async (authority) => {
          const set = (rev, tier, presence, ...prompts) => authority.approver({ v: 1, verb: 'policy_set', policy: policyObj(rev, tier, ...prompts), ...(presence === undefined ? {} : { presence }) });
          isFailure(await set(1, 'standard'), 'presence_mismatch');
          isFailure(await set(1, 'standard', sign(Buffer.from(`albera.presence.v1\0${policyHash(1, 'standard', [])}`))), 'presence_mismatch');
          isFailure(await set(1, 'standard', sign(Buffer.from(`albera.selfcheck.v1\0${policyHash(1, 'standard', [])}`))), 'presence_mismatch');
          isFailure(await set(1, 'standard', sign(Buffer.from(`albera.policy.v1\0${policyHash(1, 'standard', [])}`))), 'presence_mismatch'); // the old message without kid and audience
          isFailure(await set(1, 'standard', sign(policyMessage(1, 'standard', ['task.cancel']))), 'presence_mismatch');
          isFailure(await set(1, 'standard', sign(policyMessage(2, 'standard'))), 'presence_mismatch');
          isFailure(await set(1, 'standard', sign(policyMessage(1, 'standard', [], 'authority-key-other'))), 'presence_mismatch');
          isFailure(await set(1, 'standard', sign(policyMessage(1, 'standard', [], KID, 'albera-other-broker'))), 'presence_mismatch');
          assert.equal((await authority.submit(stopRequest())).state, 'pending', 'still careful');
          assert.equal(existsSync(path.join(folder, 'policy.json')), false, 'a refused change writes nothing');

          const valid = sign(policyMessage(1, 'standard'));
          assert.deepEqual(await set(1, 'standard', valid), { ok: true, policyVersion: policyHash(1, 'standard', []) });
          assert.equal(readFileSync(path.join(folder, 'policy.json'), 'utf8'), signedFile(policyObj(1, 'standard'), policyObj(1, 'standard'), valid), 'written next to the config with the signature that authorized it');
          assert.ok(authority.child.lines.includes(`POLICY_CHANGED=1 standard ${policyHash(1, 'standard', [])}`), 'the applied change is reported');
          assert.equal(authority.child.lines.filter((line) => line.startsWith('POLICY_CHANGED=')).length, 1, 'refused changes are not');
          isFailure(await set(1, 'standard', valid), 'request_invalid');
          assert.equal((await authority.submit(stopRequest({ operationId: 'op-2', idempotencyKey: 'idem-2' }))).state, 'approved', 'applied at once');

          assert.deepEqual(await set(2, 'standard', undefined, 'environment.stop'), { ok: true, policyVersion: policyHash(2, 'standard', ['environment.stop']) }, 'adding a prompt needs no signature');
          assert.equal(readFileSync(path.join(folder, 'policy.json'), 'utf8'), signedFile(policyObj(2, 'standard', 'environment.stop'), policyObj(1, 'standard'), valid), 'and keeps the signature that authorized the ceiling');
          assert.equal((await authority.submit(stopRequest({ operationId: 'op-3', idempotencyKey: 'idem-3' }))).state, 'pending', 'and applies at once');
          isFailure(await set(3, 'standard', undefined), 'presence_mismatch');
        });
        await run(folder, { config }, async (authority) => {
          const policy = await authority.approver({ v: 1, verb: 'policy' });
          assert.deepEqual([policy.policy.rev, policy.policy.tier, Object.keys(policy.policy.overrides)], [2, 'standard', ['environment.stop']], 'a restart reads what was written');
        });
        // The same signed file under another Authority (another kid, or another audience) is not loaded.
        for (const other of [{ kid: 'authority-key-other' }, { audience: 'albera-other-broker' }]) {
          const child = startProcess(exe, standInService('serve-loop', writeConfig(folder, makeConfig({ approverPublicKey: hello.spki, ...other }), 'other.json'), 'real', '120'), { stdin: true });
          assert.equal(await waitForExit(child), 79, JSON.stringify(other));
          assert.ok(child.lines.includes('SERVICE_POLICY=invalid:policy_unsigned'), child.lines.join('|'));
        }
      });
    });

    it('the file is read once at start: a file written or changed while the Authority runs changes nothing until it restarts', async () => {
      const hello = makeHelloKey();
      await inFolder(async (folder) => {
        await run(folder, { config: makeConfig({ approverPublicKey: hello.spki }) }, async (authority) => {
          writeFileSync(path.join(folder, 'policy.json'), standardFile(hello));
          assert.equal((await authority.submit(stopRequest())).state, 'pending');
          assert.equal((await authority.approver({ v: 1, verb: 'policy' })).policy.tier, 'careful');
        });
      });
    });

    it('an invalid, unsigned, wrongly signed, untrusted or unreadable policy file stops the start with exit 79 and a fixed word (service-check and the serve loop agree); a missing file is a normal start', async () => {
      const hello = makeHelloKey();
      const stranger = makeHelloKey();
      await inFolder(async (folder) => {
        const file = path.join(folder, 'policy.json');
        const config = writeConfig(folder, makeConfig({ controlPlaneSid: VIRTUAL_ACCOUNT_SID, approverSid: guestSid(), approverPublicKey: hello.spki }), 'config.json');
        const check = () => { const child = startProcess(exe, standInService('service-check', config)); return waitForExit(child).then((code) => ({ code, lines: child.lines })); };
        const sign = (message, key = hello) => helloSignature(key.privateKey, message);
        assert.deepEqual(await check(), { code: 0, lines: ['SERVICE_CONFIG=ok'] }, 'no file: nothing extra is printed');
        for (const [label, content, reason] of [
          ['not json', 'standard', 'policy_invalid'], ['an extra key', JSON.stringify({ ...policyObj(1, 'careful'), grants: {} }), 'policy_invalid'],
          ['a missing revision', JSON.stringify({ v: 1, tier: 'careful', overrides: {} }), 'policy_invalid'], ['an unknown tier', policyJson(1, 'delegated'), 'policy_invalid'],
          ['an override that is not a prompt', JSON.stringify({ v: 1, rev: 1, tier: 'careful', overrides: { 'environment.stop': 'allow' } }), 'policy_invalid'],
          ['a BOM', `﻿${policyJson(1, 'careful')}`, 'policy_invalid'], ['too large', `${policyJson(1, 'careful')}${' '.repeat(2100)}`, 'policy_too_large'],
          ['a standard policy nobody signed', policyJson(1, 'standard'), 'policy_unsigned'],
          ['a standard policy with a signature over another policy', signedFile(policyObj(1, 'standard'), policyObj(1, 'standard'), sign(policyMessage(1, 'standard', ['task.cancel']))), 'policy_unsigned'],
          ['a signature made for another kid', signedFile(policyObj(1, 'standard'), policyObj(1, 'standard'), sign(policyMessage(1, 'standard', [], 'authority-key-other'))), 'policy_unsigned'],
          ['a signature made for another audience', signedFile(policyObj(1, 'standard'), policyObj(1, 'standard'), sign(policyMessage(1, 'standard', [], KID, 'albera-other-broker'))), 'policy_unsigned'],
          ['a signature from a key the Authority does not pin', signedFile(policyObj(1, 'standard'), policyObj(1, 'standard'), sign(policyMessage(1, 'standard'), stranger)), 'policy_unsigned'],
          ['a policy that skips more than the signed one', signedFile(policyObj(1, 'standard'), policyObj(1, 'standard', 'task.cancel'), sign(policyMessage(1, 'standard', ['task.cancel']))), 'policy_unsigned'],
          ['a signature block that is not base64', signedFile(policyObj(1, 'standard'), policyObj(1, 'standard'), '!!!'), 'policy_invalid'],
        ]) {
          writeFileSync(file, content);
          assert.deepEqual(await check(), { code: 79, lines: ['SERVICE_CONFIG=ok', `SERVICE_POLICY=invalid:${reason}`] }, label);
          const loop = startProcess(exe, standInService('serve-loop', config, 'real', '120'), { stdin: true });
          assert.equal(await waitForExit(loop), 79, `${label}: the serve loop refuses too`);
          assert.equal(loop.lines.includes('AUTHORITY_READY'), false, `${label}: no pipe was created`);
        }
        writeFileSync(file, standardFile(hello));
        assert.deepEqual(await check(), { code: 0, lines: ['SERVICE_CONFIG=ok', 'SERVICE_POLICY=ok:standard'] }, 'a validly signed file');
        const noStandIn = startProcess(exe, ['service-check', config]);
        assert.equal(await waitForExit(noStandIn), 73, 'the token user alone is not the service: the config is refused first (the same rule guards the policy)');
      });
      const writable = makeTrustedTempDirectory('albera-authority-policy-writable-');
      try {
        const config = writeConfig(writable, makeConfig({ controlPlaneSid: VIRTUAL_ACCOUNT_SID, approverSid: guestSid(), approverPublicKey: hello.spki }), 'config.json');
        writeFileSync(path.join(writable, 'policy.json'), standardFile(hello));
        icaclsOn(path.join(writable, 'policy.json'), '/grant', '*S-1-5-32-545:M'); // BUILTIN\Users may now write the policy file only, not the config or the folder
        const child = startProcess(exe, standInService('service-check', config));
        assert.equal(await waitForExit(child), 79);
        assert.deepEqual(child.lines, ['SERVICE_CONFIG=ok', 'SERVICE_POLICY=invalid:policy_untrusted'], 'a policy file other users can write is never read');
      } finally { rmSync(writable, { recursive: true, force: true }); }
    });

    it('a folder where other users can create files is refused at the config load (73 config_folder_untrusted) BEFORE policy.json is looked at: a squatted policy.json cannot turn into an exit 79 lock-out', async () => {
      const hello = makeHelloKey();
      await inFolder(async (folder) => {
        const config = writeConfig(folder, makeConfig({ controlPlaneSid: VIRTUAL_ACCOUNT_SID, approverSid: guestSid(), approverPublicKey: hello.spki }), 'config.json');
        const check = () => { const child = startProcess(exe, standInService('service-check', config)); return waitForExit(child).then((code) => ({ code, lines: child.lines })); };
        assert.deepEqual(await check(), { code: 0, lines: ['SERVICE_CONFIG=ok'] }, 'control: a protected folder is fine');
        icaclsOn(folder, '/grant', '*S-1-5-32-545:(WD)'); // BUILTIN\Users may create files here (this folder only: the config file itself stays trusted)
        writeFileSync(path.join(folder, 'policy.json'), 'squatted');
        assert.deepEqual(await check(), { code: 73, lines: ['SERVICE_CONFIG=invalid:config_folder_untrusted'] }, 'the folder is refused before the file is read');
        const loop = startProcess(exe, standInService('serve-loop', config, 'real', '120'), { stdin: true });
        assert.equal(await waitForExit(loop), 73);
        assert.equal(loop.lines.some((line) => line.startsWith('SERVICE_POLICY=')), false, 'policy.json was never looked at');
      });
    });
  });

  describe('service entry and config trust', () => {
    const production = (extra = {}) => makeConfig({ controlPlaneSid: VIRTUAL_ACCOUNT_SID, approverSid: guestSid(), ...extra });
    // The shipped build trusts only the Authority's own per-service SID (not in a host test's token), so the validation tests run the test-faults build told to stand in the
    // signed-in user for it. `checkWith(exe, args)` is the same check with the arguments spelled out (the shipped rule, or another stand-in).
    const checkWith = (program, args) => { const child = startProcess(program, args); return waitForExit(child).then((code) => ({ code, lines: child.lines })); };
    const check = (file) => checkWith(exe, standInService('service-check', file));
    const UNTRUSTED = { code: 73, lines: ['SERVICE_CONFIG=invalid:config_untrusted'] };

    it('service-check accepts a production config and refuses one SID for both pipes (73 sids_not_distinct)', async () => {
      assert.deepEqual(await check(writeConfig(trusted, production(), 'ok.json')), { code: 0, lines: ['SERVICE_CONFIG=ok'] });
      const same = await check(writeConfig(trusted, production({ approverSid: guestSid(), controlPlaneSid: guestSid() }), 'same.json'));
      assert.deepEqual(same, { code: 73, lines: ['SERVICE_CONFIG=invalid:sids_not_distinct'] });
      const own = await check(writeConfig(trusted, production({ approverSid: currentUserSid() }), 'own.json'));
      assert.deepEqual(own, { code: 73, lines: ['SERVICE_CONFIG=invalid:sids_not_distinct'] });
    });

    it('service-check refuses a config that other users could write (73 config_untrusted) and a bad value (73 with its reason word)', async () => {
      const writable = makeTrustedTempDirectory('albera-authority-writable-');
      try {
        const file = writeConfig(writable, production(), 'config.json');
        icaclsOn(writable, '/grant', '*S-1-5-32-545:(OI)(CI)M'); // BUILTIN\Users may now write here
        assert.deepEqual(await check(file), { code: 73, lines: ['SERVICE_CONFIG=invalid:config_untrusted'] });
      } finally { rmSync(writable, { recursive: true, force: true }); }
      assert.deepEqual(await check(writeConfig(trusted, production({ audience: 'Not Valid' }), 'bad.json')), { code: 73, lines: ['SERVICE_CONFIG=invalid:audience'] });
      assert.deepEqual(await check(writeConfig(trusted, { ...production(), extra: 'x' }, 'extra.json')), { code: 73, lines: ['SERVICE_CONFIG=invalid:config_keys'] });
    });

    it('the token user alone is never trusted: a config only this user and SYSTEM can reach is refused without a stand-in SID (shipped build and test-faults build alike)', async () => {
      const file = writeConfig(trusted, production(), 'token-user.json');
      assert.deepEqual(await checkWith(exe, standInService('service-check', file)), { code: 0, lines: ['SERVICE_CONFIG=ok'] }, 'control: with the stand-in the same file is fine');
      assert.deepEqual(await checkWith(plainExe, ['service-check', file]), UNTRUSTED, 'shipped build: no per-service SID in this token');
      assert.deepEqual(await checkWith(exe, ['service-check', file]), UNTRUSTED, 'test-faults build without --trust-sid applies the same rule');
      assert.deepEqual(await checkWith(exe, trustSid(VIRTUAL_ACCOUNT_SID, 'service-check', file)), UNTRUSTED, 'a stand-in other than the owner / writers of the file');
      assert.equal((await checkWith(exe, trustSid('not-a-sid', 'service-check', file))).code, 64, 'a malformed --trust-sid is a usage error');
    });

    it('`service` outside the service control manager exits 74 and creates no pipe', async () => {
      const config = production();
      const file = writeConfig(trusted, config, 'scm.json');
      const child = startProcess(plainExe, ['service', file]);
      assert.equal(await waitForExit(child), 74);
      assert.ok(child.lines.includes('AUTHORITY_FATAL=SERVICE_CONTROLLER_UNAVAILABLE'), child.lines.join('|'));
      const probe = startProcess(probeExe, ['dacl', `${config.pipeRoot}\\submit\\v1`]);
      assert.notEqual(await waitForExit(probe), 0, 'no such pipe exists');
    });

    it('the shipped build has no test fakes and no test subcommands; the test-faults build does', () => {
      const bytes = (file) => readFileSync(file.replace(/\.exe$/u, '.dll'));
      // Type names live in the UTF-8 metadata heap, string literals in the UTF-16 user-string heap.
      const present = (file, text, encoding) => bytes(file).includes(Buffer.from(text, encoding));
      for (const type of ['FakeReceiptSigner', 'FakePresenceVerifier', 'TestSeam']) {
        assert.equal(present(plainExe, type, 'utf8'), false, `${type} must not be in the shipped build`);
      }
      for (const literal of ['albera-test-approval-authority', 'serve-loop', 'albera-fake-presence', 'CLIENT_ERROR=', '--trust-sid']) {
        assert.equal(present(plainExe, literal, 'utf16le'), false, `"${literal}" must not be in the shipped build`);
        assert.equal(present(exe, literal, 'utf16le'), true, `"${literal}" is in the test-faults build (control)`);
      }
      assert.equal(present(exe, 'FakeReceiptSigner', 'utf8'), true, 'the fakes are in the test-faults build (control)');
      assert.equal(spawnSync(plainExe, ['serve-loop', 'x', 'real', '1'], { windowsHide: true }).status, 64, 'serve-loop is an unknown command (64) in the shipped build');
      assert.equal(spawnSync(plainExe, trustSid(currentUserSid(), 'service-check', 'x'), { windowsHide: true }).status, 64, '--trust-sid is an unknown command (64) in the shipped build');
      assert.equal(spawnSync(plainExe, ['request', 'x', 'e30='], { windowsHide: true }).status, 64, 'request is an unknown command (64) in the shipped build');
    });
  });
});
