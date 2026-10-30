import assert from 'node:assert/strict';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';
import { validateReceiptV2 } from '../src/runtime/broker-contract/receipt-v2.mjs';
import { nodePipeOwnerSid } from './helpers/windows-broker-harness.mjs';
import {
  VIRTUAL_ACCOUNT_SID, buildApprover, buildAuthority, currentUserSid, fakeKeyArgument, getUnavailableReason, makeConfig, makeHelloKey, makeTrustedTempDirectory, runApprover, startAuthority, testOptions,
} from './helpers/approver-harness.mjs';

// Windows-only, same-user, unprivileged: AlberaApprover.exe (test-faults build: fake in-memory RSA "Hello") against the REAL Approval Authority (test-faults build, real RSA
// presence verifier pinned to that fake key), plus hostile same-user pipe servers (a tampering proxy and a squatter). No service, ACL change, admin, Hyper-V or Hello
// enrolment. Proves the SAME-USER identity checks only; the service identity (SCM PID, service owner SID, session 0) stays lab-only. Skipped without the .NET 10 SDK.
const NOW = () => Math.floor(Date.now() / 1000);
const ACTION = { action: 'environment.start', projectId: 'proj-alpha', computerId: 'pc-01', args: { vmName: 'alpha', cpu: 2, fast: true } };
const submitRequest = (overrides = {}) => ({
  v: 1, verb: 'submit', purpose: 'broker.operation', operationId: 'op-1', idempotencyKey: 'idem-1', leaseId: 'lease-1', leaseGeneration: 7, brokerEpoch: 3,
  brokerChallenge: '_-7dzLuqmYh3ZlVEMyIRAA', action: ACTION, ...overrides,
});
const UNKNOWN_ID = '3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';
const blocks = (stdout) => stdout.split(/\r?\n(?=request )/u).filter((x) => x.startsWith('request ')).map((text) => ({ id: text.split(/\r?\n/u)[0].slice('request '.length), text }));

describe('Approver app (test-faults build, fake Hello) against the real Authority', { skip: getUnavailableReason(), timeout: 900_000 }, () => {
  let root, authorityExe, exe, shippedExe, trusted, sid, nodeOwner;
  before(() => {
    root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'albera-approver-it-'))); // long form: TEMP may be an 8.3 short name
    authorityExe = buildAuthority(path.join(root, 'authority'), { faults: true });
    exe = buildApprover(path.join(root, 'faults'), { faults: true });
    shippedExe = buildApprover(path.join(root, 'shipped'), { faults: false });
    trusted = makeTrustedTempDirectory('albera-approver-cfg-');
    sid = currentUserSid();
    nodeOwner = nodePipeOwnerSid(); // owner of the Node-made proxy / squatter pipes (Administrators when elevated)
  });
  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    if (trusted) rmSync(trusted, { recursive: true, force: true });
  });

  /** Run `body` against a fresh Authority whose pinned approver key is `hello` (real RSA presence verification), and always stop it. */
  async function withAuthority(body, { hello = makeHelloKey() } = {}) {
    const authority = await startAuthority(authorityExe, trusted, { config: makeConfig({ approverPublicKey: hello.spki }) });
    try { return await body(authority, hello); } finally { await authority.stop(); }
  }
  /** The app, pointed at `authority` with the fake Hello key (omit `hello` for a build with no signer). */
  // approve always needs a typed yes; the fake console (--test-interactive) lets a test pipe it.
  const app = (authority, args, { hello, stdin = args[0] === 'approve' ? 'yes\n' : '', ...options } = {}) => runApprover(exe, [...args, ...testOptions(authority, { sid, hello, ...options })], { stdin });
  const listed = async (authority) => blocks((await app(authority, ['list'])).stdout);
  const status = (authority, approvalId) => authority.submit({ v: 1, verb: 'status', approvalId });
  const submit = async (authority, overrides = {}) => { const reply = await authority.submit(submitRequest(overrides)); assert.equal(reply.ok, true, JSON.stringify(reply)); return reply.approvalId; };
  const verifyEcdsa = (publicKey, receipt, signature) => verify('sha256', receipt, { key: createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }), dsaEncoding: 'ieee-p1363' }, signature);
  const contextFor = (fields) => ({
    clock: NOW, environment: 'test', action: fields.action,
    expected: { audience: 'albera-host-broker', purpose: fields.purpose, operationId: fields.operationId, idempotencyKey: fields.idempotencyKey, leaseId: fields.leaseId,
      leaseGeneration: fields.leaseGeneration, brokerEpoch: fields.brokerEpoch, brokerChallenge: fields.brokerChallenge, policyVersion: 'policy-test' },
  });

  it('list shows an empty queue, then each request with every digest input and the digest the Node contract computes; more requests than one frame holds are all listed', async () => {
    await withAuthority(async (authority) => {
      const empty = await app(authority, ['list']);
      assert.deepEqual([empty.code, empty.stdout, empty.stderr], [0, 'pending: 0\n', '']);

      const first = await submit(authority);
      const [entry] = await listed(authority);
      assert.equal(entry.id, first);
      for (const line of ['purpose: "broker.operation"', 'action: "environment.start"', 'projectId: "proj-alpha"', 'computerId: "pc-01"', 'args: 3', '"cpu" = 2 (int)', '"fast" = true (bool)',
        '"vmName" = "alpha" (string)', 'operationId: "op-1"', `actionDigest: ${computeActionDigest('broker.operation', ACTION)}`, 'digest check: OK']) {
        assert.ok(entry.text.includes(line), `missing "${line}" in\n${entry.text}`);
      }
      assert.match(entry.text, /expiresAt: \d+ \(\d{4}-\d\d-\d\dT[\d:]+Z, in \d+ s\)/u);

      const ids = [first];
      for (let n = 2; n <= 7; n += 1) ids.push(await submit(authority, { operationId: `op-${n}`, idempotencyKey: `idem-${n}` }));
      const all = await app(authority, ['list']);
      assert.equal(all.stdout.split('\n')[0], 'pending: 7');
      assert.deepEqual(blocks(all.stdout).map((b) => b.id), ids, 'oldest first, across more than one frame');
    });
  });

  it('approve with the fake Hello: the request is approved, its receipt validates with the contract and verifies with the signer key, and it leaves the list', async () => {
    await withAuthority(async (authority, hello) => {
      const approvalId = await submit(authority);
      const result = await app(authority, ['approve', approvalId], { hello });
      assert.deepEqual([result.code, result.stderr], [0, '']);
      assert.ok(result.stdout.includes('digest check: OK') && result.stdout.endsWith('result: approved\n'), result.stdout);
      const approved = await status(authority, approvalId);
      assert.equal(approved.state, 'approved');
      const receiptBytes = Buffer.from(approved.receipt, 'base64');
      assert.equal(verifyEcdsa(authority.publicKey, receiptBytes, Buffer.from(approved.signature, 'base64')), true);
      const verdict = validateReceiptV2(receiptBytes, contextFor(submitRequest()));
      assert.equal(verdict.ok, true, JSON.stringify(verdict));
      assert.equal(verdict.receipt.approvalId, approvalId);
      assert.equal(verdict.receipt.actionDigest, computeActionDigest('broker.operation', ACTION));
      assert.equal((await app(authority, ['list'])).stdout, 'pending: 0\n');
    });
  });

  it('only a typed "yes" approves (there is no --yes); anything else decides nothing and the request stays pending', async () => {
    await withAuthority(async (authority, hello) => {
      const approvalId = await submit(authority);
      for (const answer of ['no\n', '\n', 'y\n']) {
        const declined = await app(authority, ['approve', approvalId], { hello, stdin: answer });
        assert.deepEqual([declined.code, declined.stderr], [65, 'error: not_confirmed\n']);
        assert.equal((await status(authority, approvalId)).state, 'pending');
      }
      const accepted = await app(authority, ['approve', approvalId], { hello, stdin: 'yes\n' });
      assert.equal(accepted.code, 0, accepted.stderr);
      assert.ok(accepted.stdout.includes('Type yes to approve exactly this request: '));
      assert.equal((await status(authority, approvalId)).state, 'approved');
    });
  });

  it('deny finalises the request (human_denied for the Control Plane); a second decision on it is refused by the Authority', async () => {
    await withAuthority(async (authority, hello) => {
      const approvalId = await submit(authority);
      const denied = await app(authority, ['deny', approvalId]);
      assert.deepEqual([denied.code, denied.stdout, denied.stderr], [0, 'result: denied\n', '']);
      assert.deepEqual(await status(authority, approvalId), { ok: false, code: 'human_denied' });
      const again = await app(authority, ['approve', approvalId], { hello });
      assert.equal(again.code, 65, 'a finalised request is no longer listed, so approve refuses locally');
      assert.equal(again.stderr, 'error: not_pending\n');
      const stale = await app(authority, ['deny', approvalId]);
      assert.deepEqual([stale.code, stale.stderr], [67, 'error: authority:request_invalid\n']);
    });
  });

  it('presence failures: no Hello proof -> presence_unavailable (final), a proof from the wrong key -> presence_mismatch (final), a build with no usable Hello key -> exit 69 with an enroll hint and nothing sent', async () => {
    await withAuthority(async (authority, hello) => {
      const unavailable = await submit(authority, { operationId: 'op-u', idempotencyKey: 'idem-u' });
      const noProof = await app(authority, ['approve', unavailable], { hello, presence: 'unavailable' });
      assert.deepEqual([noProof.code, noProof.stderr], [67, 'error: authority:presence_unavailable\n']);
      assert.deepEqual(await status(authority, unavailable), { ok: false, code: 'presence_unavailable' });

      const mismatch = await submit(authority, { operationId: 'op-m', idempotencyKey: 'idem-m' });
      const wrongKey = await app(authority, ['approve', mismatch], { hello: makeHelloKey() });
      assert.deepEqual([wrongKey.code, wrongKey.stderr], [67, 'error: authority:presence_mismatch\n']);
      assert.deepEqual(await status(authority, mismatch), { ok: false, code: 'presence_mismatch' });

      const kept = await submit(authority, { operationId: 'op-k', idempotencyKey: 'idem-k' });
      const noSigner = await app(authority, ['approve', kept]); // test-faults build without --test-fake-key = a signer that is never ready
      assert.deepEqual([noSigner.code, noSigner.stderr.split('\n')[0]], [69, 'error: presence_signer_unavailable']);
      assert.match(noSigner.stderr, /enroll/u, 'the message tells the person to run enroll');
      assert.equal((await status(authority, kept)).state, 'pending', 'nothing was sent: the request is still pending');
    });
  });

  it('non-ASCII and look-alike text is shown as \\u{HEX}, never raw; the digest is still the one the Node contract computes for the exact string', async () => {
    await withAuthority(async (authority, hello) => {
      const args = { label: 'café あ 😀 "q" \\ pаypal', plain: 'ok' };
      const approvalId = await submit(authority, { action: { ...ACTION, args } });
      const { stdout } = await app(authority, ['list']);
      assert.equal(/[^\n\x20-\x7e]/u.test(stdout.replace(/\r/gu, '')), false, 'the output is printable ASCII only');
      assert.ok(stdout.includes('"label" = "caf\\u{E9} \\u{3042} \\u{1F600} \\"q\\" \\\\ p\\u{430}ypal" (string)'), stdout);
      assert.ok(stdout.includes('note: 4 character(s) are shown as'), stdout);
      assert.ok(stdout.includes(`actionDigest: ${computeActionDigest('broker.operation', { ...ACTION, args })}`));
      assert.equal((await app(authority, ['approve', approvalId], { hello })).code, 0, 'and the exact text can be approved');
    });
  });

  describe('a server that lies about what it shows (a same-user proxy in front of the real Authority)', () => {
    /** A framed pipe server named like the approver pipe: answers `list` with tamper(real list reply) and every `decide` with ok, and records every request it receives. */
    async function startProxy(authority, tamper) {
      const proxyRoot = `ALBERA\\ApprovalAuthority\\tprox${randomBytes(4).toString('hex')}`;
      const seen = [];
      const server = net.createServer((socket) => {
        let buffer = Buffer.alloc(0);
        socket.on('error', () => {});
        socket.on('data', async (data) => {
          buffer = Buffer.concat([buffer, data]);
          if (buffer.length < 4 || buffer.length < 4 + buffer.readInt32LE(0)) return;
          const request = JSON.parse(buffer.subarray(4, 4 + buffer.readInt32LE(0)).toString('utf8'));
          seen.push(request);
          const reply = Buffer.from(JSON.stringify(request.verb === 'list' ? tamper(await authority.approver(request)) : { ok: true, state: request.decision === 'approve' ? 'approved' : 'denied' }), 'utf8');
          const header = Buffer.alloc(4);
          header.writeInt32LE(reply.length, 0);
          socket.end(Buffer.concat([header, reply]));
        });
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\${proxyRoot}\\approver\\v1`, resolve); });
      return { proxyRoot, seen, close: () => new Promise((resolve) => server.close(resolve)) };
    }
    const viaProxy = (proxy, args, hello) => runApprover(exe, [...args, '--test-pipe-root', proxy.proxyRoot, '--test-owner-sid', nodeOwner, '--test-pid', String(process.pid), '--test-fake-key', hello.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), '--test-interactive', 'yes'], { stdin: args[0] === 'approve' ? 'yes\n' : '' });
    const withEntry = (change) => (reply) => ({ ...reply, pending: reply.pending.map(change) });

    const tampers = {
      'a changed project (display tampered, digest unchanged)': withEntry((e) => ({ ...e, action: { ...e.action, projectId: 'proj-prod' } })),
      'a changed arg value': withEntry((e) => ({ ...e, action: { ...e.action, args: { ...e.action.args, vmName: 'evil' } } })),
      'a changed action': withEntry((e) => ({ ...e, action: { ...e.action, action: 'environment.destroy' } })),
      'a changed digest (fields untouched)': withEntry((e) => ({ ...e, actionDigest: `sha256:${'0'.repeat(64)}` })),
      'a changed purpose': withEntry((e) => ({ ...e, purpose: 'guest.command', action: { ...e.action, action: 'task.start' } })),
    };
    for (const [label, tamper] of Object.entries(tampers)) {
      it(`${label}: shown as MISMATCH, refused with exit 65, nothing signed or decided`, async () => {
        await withAuthority(async (authority, hello) => {
          const approvalId = await submit(authority);
          const proxy = await startProxy(authority, tamper);
          try {
            const result = await viaProxy(proxy, ['approve', approvalId], hello);
            assert.deepEqual([result.code, result.stderr], [65, 'error: digest_mismatch\n'], result.stdout);
            assert.ok(result.stdout.includes('digest check: MISMATCH') && result.stdout.includes('DO NOT APPROVE'), result.stdout);
            assert.deepEqual(proxy.seen.map((r) => r.verb), ['list'], 'the proxy never received a decide');
            assert.equal((await status(authority, approvalId)).state, 'pending', 'the real Authority was never asked to decide');
            const listing = await viaProxy(proxy, ['list'], hello);
            assert.ok(listing.code === 0 && listing.stdout.includes('MISMATCH'), 'list still shows the request, flagged');
          } finally { await proxy.close(); }
        });
      });
    }

    it('an entry with smuggled fields, a bidi character in an arg or a malformed id is shown as REFUSED and cannot be approved', async () => {
      await withAuthority(async (authority, hello) => {
        const approvalId = await submit(authority);
        const hostile = {
          'an extra key': withEntry((e) => ({ ...e, surprise: 1 })),
          'a bidi character in an arg': withEntry((e) => ({ ...e, action: { ...e.action, args: { ...e.action.args, vmName: 'al‮pha' } } })),
          'a null arg': withEntry((e) => ({ ...e, action: { ...e.action, args: { ...e.action.args, vmName: null } } })),
        };
        for (const [label, tamper] of Object.entries(hostile)) {
          const proxy = await startProxy(authority, tamper);
          try {
            const shown = await viaProxy(proxy, ['list'], hello);
            assert.ok(shown.stdout.includes('REFUSED: invalid_entry') && !shown.stdout.includes('proj-alpha'), `${label}\n${shown.stdout}`);
            const refused = await viaProxy(proxy, ['approve', approvalId], hello);
            assert.deepEqual([refused.code, refused.stderr], [65, 'error: invalid_entry\n'], label);
            assert.deepEqual(proxy.seen.map((r) => r.verb), ['list', 'list'], label);
          } finally { await proxy.close(); }
        }
      });
    });
  });

  describe('the pipe server is verified before a single byte is written', () => {
    it('wrong owner SID, wrong PID: list, approve and deny exit 66 server_identity_mismatch, and the Authority never saw a request', async () => {
      await withAuthority(async (authority, hello) => {
        const approvalId = await submit(authority);
        const wrong = { 'owner SID': { ownerSid: VIRTUAL_ACCOUNT_SID }, 'PID': { pid: authority.child.pid + 4 } };
        for (const [label, expectation] of Object.entries(wrong)) {
          for (const args of [['list'], ['approve', approvalId], ['deny', approvalId]]) {
            const result = await app(authority, args, { hello, ...expectation });
            assert.deepEqual([result.code, result.stdout, result.stderr], [66, '', 'error: server_identity_mismatch\n'], `${label} ${args[0]}`);
          }
        }
        assert.equal((await status(authority, approvalId)).state, 'pending', 'still pending: the denial and the approval never arrived');
        assert.equal((await authority.approver({ v: 1, verb: 'list' })).pending.length, 1);
      });
    });

    it('a squatter on the pipe name receives 0 bytes under the real expectation; with its own identity as the expectation (control) the same squatter is spoken to', async () => {
      await withAuthority(async (authority, hello) => {
        const squatter = { connections: 0, bytes: 0 };
        const sockets = [];
        const server = net.createServer((socket) => { sockets.push(socket); squatter.connections += 1; socket.on('data', (data) => { squatter.bytes += data.length; }); socket.on('error', () => {}); });
        const squatterRoot = `ALBERA\\ApprovalAuthority\\tsq${randomBytes(4).toString('hex')}`;
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\${squatterRoot}\\approver\\v1`, resolve); });
        try {
          // The expectation is the real Authority's PID; the squatter is this test process, so it has another one.
          const refused = await app(authority, ['list'], { hello, pipeRoot: squatterRoot });
          assert.deepEqual([refused.code, refused.stdout, refused.stderr], [66, '', 'error: server_identity_mismatch\n']);
          await new Promise((resolve) => setTimeout(resolve, 300));
          assert.deepEqual(squatter, { connections: 1, bytes: 0 }, 'the squatter was connected to (identification only) but received nothing');

          // Control: expecting the squatter's own owner and PID, the app writes the request and then times out, because the squatter never answers.
          const spoken = await app(authority, ['list'], { hello, pipeRoot: squatterRoot, ownerSid: nodeOwner, pid: process.pid, timeoutMs: 1500 });
          assert.deepEqual([spoken.code, spoken.stderr], [68, 'error: timeout\n']);
          assert.ok(squatter.bytes > 0, 'the identity check, not connectivity, is what kept the first request from the squatter');
        } finally {
          for (const socket of sockets) socket.destroy();
          await new Promise((resolve) => server.close(resolve));
        }
      });
    });

    it('no Authority on the pipe: exit 66 authority_unreachable', async () => {
      const gone = await runApprover(exe, ['list', '--test-pipe-root', 'ALBERA\\ApprovalAuthority\\tnone', '--test-owner-sid', sid, '--test-pid', '4']);
      assert.deepEqual([gone.code, gone.stdout, gone.stderr], [66, '', 'error: authority_unreachable\n']);
    });
  });

  describe('enroll (fake key store; the real Windows Hello is never touched)', () => {
    const fakeKey = (hello) => ['--test-fake-key', fakeKeyArgument(hello)];
    const printed = (stdout) => Object.fromEntries([...stdout.matchAll(/^ {2}"(approver\w+)": "([^"]+)",$/gmu)].map((m) => [m[1], m[2]]));

    it('enroll --show prints the three Authority config values; an Authority configured with exactly those values accepts an approval signed by that key', async () => {
      const hello = makeHelloKey();
      const shown = await runApprover(exe, ['enroll', '--show', ...fakeKey(hello)]);
      assert.deepEqual([shown.code, shown.stderr], [0, '']);
      const values = printed(shown.stdout);
      assert.deepEqual(Object.keys(values).sort(), ['approverKeyId', 'approverPublicKey', 'approverSid']);
      assert.equal(values.approverPublicKey, hello.spki, 'the SPKI of the key, base64');
      assert.equal(values.approverSid, sid, 'the current user SID');
      assert.match(values.approverKeyId, /^hello-[0-9a-f]{16}$/u);
      assert.equal(shown.stdout.includes(fakeKeyArgument(hello)), false, 'no private material');
      const authority = await startAuthority(authorityExe, trusted, { config: makeConfig(values) });
      try {
        const approvalId = await submit(authority);
        const approved = await app(authority, ['approve', approvalId], { hello });
        assert.deepEqual([approved.code, approved.stderr], [0, '']);
        assert.equal((await status(authority, approvalId)).state, 'approved');
      } finally { await authority.stop(); }
    });

    it('enroll creates a key only when there is none, refuses an existing one, and needs a console; --replace needs the typed word', async () => {
      const created = await runApprover(exe, ['enroll', '--test-key-state', 'missing', '--test-interactive', 'yes']);
      assert.equal(created.code, 0, created.stderr);
      assert.deepEqual(Object.keys(printed(created.stdout)).sort(), ['approverKeyId', 'approverPublicKey', 'approverSid']);

      const hello = makeHelloKey();
      const exists = await runApprover(exe, ['enroll', '--test-interactive', 'yes', ...fakeKey(hello)]);
      assert.deepEqual([exists.code, exists.stdout, exists.stderr.split('\n')[0]], [65, '', 'error: already_enrolled']);

      const replaced = await runApprover(exe, ['enroll', '--replace', '--test-interactive', 'yes', ...fakeKey(hello)], { stdin: 'replace\n' });
      assert.equal(replaced.code, 0, replaced.stderr);
      assert.notEqual(printed(replaced.stdout).approverPublicKey, hello.spki, 'a new key replaced the old one');
      const declined = await runApprover(exe, ['enroll', '--replace', '--test-interactive', 'yes', ...fakeKey(hello)], { stdin: 'yes\n' });
      assert.deepEqual([declined.code, declined.stderr], [65, 'error: not_confirmed\n']);

      const noConsole = await runApprover(exe, ['enroll', '--test-key-state', 'missing']); // stdin is a pipe and the test console flag is absent
      assert.deepEqual([noConsole.code, noConsole.stdout, noConsole.stderr], [65, '', 'error: not_interactive\n']);
      const missing = await runApprover(exe, ['enroll', '--show', '--test-key-state', 'missing']);
      assert.deepEqual([missing.code, missing.stdout, missing.stderr.split('\n')[0]], [65, '', 'error: not_enrolled']);
    });

    it('approve with redirected stdin is refused with exit 65 before any connection, even with a valid typed yes on the pipe; the same request approves on a console', async () => {
      await withAuthority(async (authority, hello) => {
        const approvalId = await submit(authority);
        const piped = await app(authority, ['approve', approvalId], { hello, interactive: false, stdin: 'yes\n' });
        assert.deepEqual([piped.code, piped.stdout, piped.stderr.split('\n')[0]], [65, '', 'error: not_interactive']);
        assert.equal((await status(authority, approvalId)).state, 'pending', 'nothing was sent');
        assert.equal((await app(authority, ['approve', approvalId], { hello })).code, 0);
      });
    });
  });

  describe('the shipped build', () => {
    const utf16 = (text) => Buffer.from(text, 'utf16le');

    it('has no test options, no fake signer and no test seam; it contains the Windows Hello signer, which the test-faults build does not; there is no --yes', async () => {
      const bytes = readFileSync(path.join(root, 'shipped', 'AlberaApprover.dll'));
      const control = readFileSync(path.join(root, 'faults', 'AlberaApprover.dll'));
      for (const type of ['FakePresenceSigner', 'FakeKeyStore', 'NotReadyPresenceSigner', 'TestSeam']) {
        assert.equal(bytes.includes(Buffer.from(type, 'utf8')), false, `${type} must not be in the shipped build`);
        assert.equal(control.includes(Buffer.from(type, 'utf8')), true, `${type} is in the test-faults build (control)`);
      }
      for (const type of ['WindowsHelloPresenceSigner', 'WindowsHelloKeyStore', 'KeyCredentialManager']) {
        assert.equal(bytes.includes(Buffer.from(type, 'utf8')), true, `${type} is in the shipped build`);
        assert.equal(control.includes(Buffer.from(type, 'utf8')), false, `${type} must not be in the test-faults build (tests never reach the real Hello)`);
      }
      for (const literal of ['--test-fake-key', '--test-pid', '--test-owner-sid', '--test-pipe-root', '--test-interactive', '--test-key-state']) {
        assert.equal(bytes.includes(utf16(literal)), false, `"${literal}" must not be in the shipped build`);
        assert.equal(control.includes(utf16(literal)), true, `"${literal}" is in the test-faults build (control)`);
      }
      for (const build of [bytes, control]) assert.equal(build.includes(utf16('--yes')), false, 'no --yes option in either build');
      for (const args of [['--test-pid', '1', 'list'], ['list', '--test-fake-key', 'AA=='], ['enroll', '--test-key-state', 'missing'], ['list', '--test-interactive', 'yes'], ['list', 'now'], ['approve'], ['approve', 'x'], ['approve', UNKNOWN_ID, '--yes'], ['enroll', '--yes'], []]) {
        const result = await runApprover(shippedExe, args);
        assert.deepEqual([result.code, result.stdout], [64, ''], args.join(' '));
        assert.match(result.stderr, /^usage: AlberaApprover list \| approve <approvalId> \| deny <approvalId> \| enroll \[--show \| --replace\]/u);
      }
    });

    it('with no Authority service on this machine, list / deny stop at the identity check with exit 66 (nothing is written to anything)', async () => {
      for (const args of [['list'], ['deny', UNKNOWN_ID]]) {
        const result = await runApprover(shippedExe, args);
        assert.equal(result.code, 66, `${args[0]}: ${result.stderr}`);
        assert.match(result.stderr, /^error: (authority_unreachable|server_identity_unavailable|server_identity_mismatch)\n$/u);
        assert.equal(result.stdout, '');
      }
    });

    it('approve and enroll (create / replace) refuse redirected stdin with exit 65 before touching the pipe or Hello, even with "yes" on stdin', async () => {
      const approve = await runApprover(shippedExe, ['approve', UNKNOWN_ID], { stdin: 'yes\n' });
      assert.deepEqual([approve.code, approve.stdout, approve.stderr.split('\n')[0]], [65, '', 'error: not_interactive']);
      for (const args of [['enroll'], ['enroll', '--replace']]) {
        const enroll = await runApprover(shippedExe, args, { stdin: 'replace\n' });
        assert.deepEqual([enroll.code, enroll.stdout, enroll.stderr], [65, '', 'error: not_interactive\n'], args.join(' '));
      }
    });
  });
});
