import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { createMemoryFlowJournal } from '../src/runtime/approved-operation-journal.mjs';
import { CHECK_ACTION, CHECK_PURPOSE, parseApprovalCheckArgs, runApprovalCheck, runApprovalCheckCommand } from '../src/runtime/approval-check.mjs';
import { RUNTIME_HELP, parseRuntimeArgs } from '../src/runtime/entry.mjs';
import { createTestAuthority, signedReceipt, stableUuid } from '../scripts/issue-22-approval-authority-fixture.mjs';

// `albera-runtime approval-check`: the first harmless request after the host install. Everything outside the process is a fake: no pipe, no helper, no service,
// no database, no Hello. The fakes record what the command handed them, so these tests prove the BINDING (settings -> which pipes, which expectation, which action,
// whether the helper path reaches every client), the printout and the exit code - not the clients (own tests) and not a real Broker, Authority or approval.
const SETTINGS_FILE = path.resolve(path.sep, 'albera-test', 'albera.approval.json');
const HELPER = path.resolve(path.sep, 'albera-test', 'pipe-client', 'helper.exe');
const SECRET_MARKER = 'TOPSECRET-do-not-print';
const settingsText = (patch = {}) => JSON.stringify({
  version: 1,
  projectId: 'albera-host',
  broker: { pipeName: 'ALBERA_HostBroker', expect: { serviceName: 'AlberaHostBroker' } },
  authority: { pipeRoot: 'ALBERA\\ApprovalAuthority', expect: { serviceName: 'AlberaApprovalAuthority' } },
  journal: path.resolve(path.sep, 'albera-test', 'operations.sqlite'),
  computers: { 'albera-clone-01': 'clone-01', 'other-vm': 'clone-02' },
  attestation: null,
  ...patch,
});
const fileIo = (text = settingsText()) => ({
  statSync: (file) => { if (file !== SETTINGS_FILE) throw new Error('ENOENT'); return { isFile: () => true, size: text.length }; },
  readFileSync: () => text,
});

/** `approval`: 'approve' (after one pending poll), 'deny', 'expire', 'policy' (approved at submit time). */
function makeWorld({ approval = 'approve', storeFails = false, claimReply = null } = {}) {
  const authority = createTestAuthority();
  const world = { clock: 1_800_000_000_000, calls: [], fields: new Map(), claims: [], opened: [], closed: 0, polls: 0, journal: createMemoryFlowJournal(), lines: [] };
  const seconds = () => Math.floor(world.clock / 1000);
  world.out = (line) => world.lines.push(line);
  world.deps = {
    async sendBrokerFence(options) {
      world.calls.push(['fence', options]);
      return { ok: true, brokerEpoch: 1, leaseGeneration: 7, leaseId: 'lease-1', brokerChallenge: randomBytes(16).toString('base64url') };
    },
    async sendBrokerRequest(options) { world.calls.push(['claim', options]); world.claims.push(options); return claimReply ?? { ok: true, state: 'UNKNOWN', action: CHECK_ACTION }; },
    async sendBrokerInspect(options) { world.calls.push(['inspect', options]); return { ok: false, code: 'denied' }; },
    async submitApproval(options) {
      world.calls.push(['submit', options]);
      const approvalId = stableUuid(`${options.operationId}/${options.idempotencyKey}`);
      world.fields.set(approvalId, options);
      return { ok: true, approvalId, state: approval === 'policy' ? 'approved' : 'pending', expiresAt: seconds() + 120 };
    },
    async getApprovalStatus(options) {
      world.calls.push(['status', options]);
      world.polls += 1;
      if (approval === 'deny') return { ok: false, code: 'human_denied' };
      if (approval === 'expire') return { ok: false, code: 'request_expired' };
      if (approval === 'approve' && world.polls === 1) return { ok: true, state: 'pending', expiresAt: seconds() + 100 };
      const f = world.fields.get(options.approvalId);
      return {
        ok: true, state: 'approved',
        ...signedReceipt({
          authority, name: f.idempotencyKey, now: seconds(), ttlSeconds: 120, approvalId: options.approvalId, operationId: f.operationId, idempotencyKey: f.idempotencyKey,
          leaseId: f.leaseId, projectId: f.action.projectId, computerId: f.action.computerId,
          fence: { brokerEpoch: f.brokerEpoch, leaseGeneration: f.leaseGeneration, brokerChallenge: f.brokerChallenge },
          purpose: f.purpose, action: f.action.action, args: f.action.args,
        }),
      };
    },
    async openStore(file) {
      world.opened.push(file);
      if (storeFails) throw new Error(`EPERM ${SECRET_MARKER}`);
      return { flowJournal: () => world.journal, close: () => { world.closed += 1; } };
    },
    newCheckOperationId: () => 'check-test-1',
    now: () => world.clock,
    sleep: async (ms) => { world.clock += ms; },
  };
  return world;
}
const run = (world, options = {}) => runApprovalCheck({ approvalFile: SETTINGS_FILE, ...options }, { io: fileIo(), deps: world.deps, out: world.out });

test('approved by a person: fence, submit, a pending poll, approve, claim; exit 0; the person is told the approval id and the commands', async () => {
  const world = makeWorld();
  const { exitCode, result } = await run(world);
  assert.equal(exitCode, 0);
  assert.equal(result.status, 'claimed');
  assert.deepEqual(world.calls.map(([name]) => name), ['fence', 'submit', 'status', 'status', 'claim']);
  const approvalId = stableUuid('check-test-1/check-test-1.c1');
  assert.equal(result.approvalId, approvalId);
  const text = world.lines.join('\n');
  assert.match(text, new RegExp(`approvalId: ${approvalId}`, 'u'));
  assert.match(text, /AlberaApprover\.exe list/u);
  assert.match(text, new RegExp(`AlberaApprover\\.exe approve ${approvalId}`, 'u'));
  assert.match(text, /status: claimed \(Broker state UNKNOWN\)/u);
  assert.match(text, /changes nothing/u);
  assert.ok(world.lines.indexOf(`approvalId: ${approvalId}`) < world.lines.findIndex((line) => line.startsWith('status:')), 'the id is shown while the flow waits, not after it');
});

test('exactly one synthetic.noop broker.operation, for the first computer of the settings, through the configured pipes and expectations; the claim is { receipt, signature } only', async () => {
  const world = makeWorld();
  await run(world);
  const [fence, submit, , , claim] = world.calls;
  const broker = { pipeName: 'ALBERA_HostBroker', expect: { serviceName: 'AlberaHostBroker' } };
  assert.deepEqual(fence, ['fence', { ...broker, computerId: 'clone-01' }]);
  assert.equal(submit[1].purpose, CHECK_PURPOSE);
  assert.deepEqual(submit[1].action, { action: CHECK_ACTION, projectId: 'albera-host', computerId: 'clone-01', args: {} });
  assert.equal(submit[1].pipeRoot, 'ALBERA\\ApprovalAuthority');
  assert.deepEqual(submit[1].expect, { serviceName: 'AlberaApprovalAuthority' });
  assert.equal(submit[1].attestation, undefined);
  assert.deepEqual([claim[1].pipeName, claim[1].expect], [broker.pipeName, broker.expect]);
  assert.deepEqual(Object.keys(claim[1]).sort(), ['expect', 'pipeName', 'receipt', 'signature'], 'a broker.operation claim carries no action DTO');
  assert.equal(world.calls.filter(([name]) => name === 'submit').length, 1);
  assert.equal(world.journal.get('check-test-1').phase, 'CLAIMED', 'the operation is in the store the settings name');
  assert.deepEqual(world.opened, [path.resolve(path.sep, 'albera-test', 'operations.sqlite')]);
});

test('the printout never contains the receipt, the signature or the challenge', async () => {
  const world = makeWorld();
  await run(world);
  const claim = world.claims[0];
  const fence = world.calls[0];
  assert.ok(claim.receipt.length > 20 && claim.signature.length > 20);
  const text = world.lines.join('\n');
  for (const secret of [claim.receipt, claim.signature, world.fields.values().next().value.brokerChallenge]) assert.equal(text.includes(secret), false);
  assert.equal(fence[0], 'fence');
});

test('a person denies: status denied, the code is shown, exit 1, nothing is claimed', async () => {
  const world = makeWorld({ approval: 'deny' });
  const { exitCode, result } = await run(world);
  assert.equal(exitCode, 1);
  assert.equal(result.status, 'denied');
  assert.equal(world.claims.length, 0);
  assert.match(world.lines.join('\n'), /status: denied \(code human_denied\)/u);
});

test('nobody decides in time: status expired, exit 1, nothing is claimed', async () => {
  const world = makeWorld({ approval: 'expire' });
  const { exitCode, result } = await run(world);
  assert.equal(exitCode, 1);
  assert.equal(result.status, 'expired');
  assert.equal(world.claims.length, 0);
  assert.match(world.lines.join('\n'), /status: expired \(code request_expired\)/u);
});

test('the Authority answers approved at submit time (policy): the person is not asked for commands, the claim still happens', async () => {
  const world = makeWorld({ approval: 'policy' });
  const { exitCode } = await run(world);
  assert.equal(exitCode, 0);
  const text = world.lines.join('\n');
  assert.match(text, /approved it without a person/u);
  assert.doesNotMatch(text, /AlberaApprover\.exe approve/u);
});

test('a Broker that refuses the claim: exit 1, never reported as claimed', async () => {
  const world = makeWorld({ claimReply: { ok: false, code: 'denied' } });
  const { exitCode, result } = await run(world);
  assert.equal(exitCode, 1);
  assert.notEqual(result.status, 'claimed');
});

test('--helper reaches all five clients; without it no helperPath is passed', async () => {
  const withHelper = makeWorld();
  await run(withHelper, { helperPath: HELPER });
  assert.ok(withHelper.calls.length >= 5);
  for (const [name, options] of withHelper.calls) assert.equal(options.helperPath, HELPER, `${name} uses the helper copy`);
  const without = makeWorld();
  await run(without);
  for (const [, options] of without.calls) assert.equal('helperPath' in options, false);
});

test('the store is closed on every outcome; a store that cannot open is a fixed code that does not leak the error', async () => {
  for (const approval of ['approve', 'deny', 'expire']) {
    const world = makeWorld({ approval });
    await run(world);
    assert.equal(world.closed, 1, approval);
  }
  const broken = makeWorld({ storeFails: true });
  await assert.rejects(run(broken), (error) => error.message === 'runtime_approval_check_journal_unavailable' && !error.message.includes(SECRET_MARKER));
  assert.deepEqual(broken.calls, [], 'nothing is requested when the journal cannot be opened');
});

test('a bad settings file is refused with the settings loader code before the store is opened or anything is requested', async () => {
  const world = makeWorld();
  await assert.rejects(runApprovalCheck({ approvalFile: SETTINGS_FILE }, { io: fileIo('{"version": 2}'), deps: world.deps, out: world.out }), { message: /^runtime_room_approval_/u });
  await assert.rejects(runApprovalCheck({ approvalFile: path.resolve(path.sep, 'albera-test', 'missing.json') }, { io: fileIo(), deps: world.deps, out: world.out }), { message: 'runtime_room_approval_unreadable' });
  assert.deepEqual([world.opened, world.calls, world.lines], [[], [], []]);
});

test('the command prints only a fixed code on failure and sets exit code 2; it prints nothing from the file', async () => {
  const errors = [];
  const original = { error: console.error, exitCode: process.exitCode };
  console.error = (line) => errors.push(String(line));
  try {
    await runApprovalCheckCommand({ approvalFile: SETTINGS_FILE, helperPath: null }, { io: fileIo(settingsText({ projectId: `${SECRET_MARKER} has spaces` })), deps: makeWorld().deps, out: () => {} });
    assert.equal(process.exitCode, 2);
    assert.deepEqual(errors, ['ALBERA Runtime approval-check: runtime_room_approval_project']);
    assert.equal(errors.join('').includes(SECRET_MARKER), false);
    errors.length = 0;
    await runApprovalCheckCommand({ approvalFile: SETTINGS_FILE, helperPath: null }, { io: fileIo(), deps: { ...makeWorld().deps, newCheckOperationId: () => { throw new Error(`boom ${SECRET_MARKER}`); } }, out: () => {} });
    assert.deepEqual(errors, ['ALBERA Runtime approval-check: runtime_approval_check_failed']);
  } finally {
    console.error = original.error;
    process.exitCode = original.exitCode;
  }
});

test('the command exits 0 for a claimed operation', async () => {
  const original = process.exitCode;
  try {
    process.exitCode = undefined;
    const world = makeWorld();
    await runApprovalCheckCommand({ approvalFile: SETTINGS_FILE, helperPath: null }, { io: fileIo(), deps: world.deps, out: world.out });
    assert.equal(process.exitCode, 0);
  } finally { process.exitCode = original; }
});

// ---- arguments and help ----

test('arguments: --approval is required, --helper must be absolute, each at most once, nothing else is accepted', () => {
  assert.deepEqual({ ...parseApprovalCheckArgs(['--approval', 'a.json']) }, { command: 'approval-check', approvalFile: 'a.json', helperPath: null, help: false });
  assert.equal(parseApprovalCheckArgs(['--approval', 'a.json', '--helper', HELPER]).helperPath, HELPER);
  assert.equal(parseApprovalCheckArgs(['--help']).help, true);
  assert.throws(() => parseApprovalCheckArgs([]), /runtime_approval_check_needs_approval/u);
  assert.throws(() => parseApprovalCheckArgs(['--approval', 'a.json', '--helper', 'relative.exe']), /runtime_approval_check_helper_must_be_absolute/u);
  assert.throws(() => parseApprovalCheckArgs(['--approval', 'a.json', '--approval', 'b.json']), /runtime_option_must_be_unique/u);
  assert.throws(() => parseApprovalCheckArgs(['--approval']), /runtime_option_requires_value/u);
  assert.throws(() => parseApprovalCheckArgs(['--approval', '--helper']), /runtime_option_requires_value/u);
  assert.throws(() => parseApprovalCheckArgs(['--approval', 'a.json', '--yes']), /invalid_runtime_option/u);
  assert.throws(() => parseApprovalCheckArgs(['--approval', 'a.json', '--operation', 'x']), /invalid_runtime_option/u, 'the action is fixed: there is no way to name another one');
});

test('albera-runtime knows the command and its help describes it without naming a program of the Broker or Authority projects', () => {
  assert.equal(parseRuntimeArgs(['approval-check', '--approval', 'a.json']).command, 'approval-check');
  assert.match(RUNTIME_HELP, /albera-runtime approval-check --approval <albera\.approval\.json>/u);
  assert.match(RUNTIME_HELP, /synthetic\.noop/u);
  assert.match(RUNTIME_HELP, /host-install\.md/u);
});

test('the command module takes no secrets and starts no process of its own (source guard)', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/runtime/approval-check.mjs', import.meta.url), 'utf8');
  assert.equal(/child_process|process\.env|readFileSync|writeFile|apiKey|password/iu.test(source), false);
  assert.equal(/'--(?:yes|approve|decision)'/u.test(source), false, 'there is no flag that approves anything');
});
