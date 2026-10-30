import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';
import { validateReceiptV2 } from '../src/runtime/broker-contract/receipt-v2.mjs';
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
