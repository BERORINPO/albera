import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { promisify } from 'node:util';
import { createMemoryFlowJournal } from '../src/runtime/approved-operation-journal.mjs';
import { createAgentFleet } from '../src/runtime/agent-fleet.mjs';
import { createAgentStatusBoard } from '../src/runtime/agent-status-board.mjs';
import { MODEL_PRICES } from '../src/runtime/desktop-agent-loop.mjs';
import { createFakeComputerUseClient, fakeReply, fakeText, fakeToolUse } from '../src/runtime/fake-computer-use-client.mjs';
import { createFakeDesktopBrokerClient } from '../src/runtime/fake-desktop-broker-client.mjs';
import { HyperVDesktopDriver } from '../src/runtime/hyperv-desktop-driver.mjs';
import { RUNTIME_HELP, parseRuntimeArgs } from '../src/runtime/entry.mjs';
import { cleanParams } from '../src/runtime/room-contract.mjs';
import { createRoomHost } from '../src/runtime/room-host.mjs';
import { createWindowsDesktopBrokerClient } from '../src/runtime/windows-desktop-broker-client.mjs';
import {
  GATED_OUT_OF_SCOPE, GATED_OUT_OF_SCOPE_LINE, MAX_APPROVAL_SETTINGS_BYTES, REAL_APPROVAL_DEPS, checkJobsAgainstSettings, loadApprovalSettings, openRoomApproval, parseApprovalSettings,
  refuseGatedOutOfScope, takeRoomApprovalArgs,
} from '../src/runtime/room-approval-wiring.mjs';
import { createTestAuthority, signedReceipt, stableUuid } from '../scripts/issue-22-approval-authority-fixture.mjs';

// Wiring of the room's start gate (#115 follow-up, step A3) and of its desktop path through the Host Broker (ADR-002 "Amendment 2026-11-03", option C). Everything here is injected: no pipe, no service,
// no database, no helper process, no Hyper-V, no VM, no model API. The clients are fakes that record what the wiring handed them, so these tests prove the BINDING (which pipe, which expectation, which
// journal, which Broker object carries the screens and the input), not the clients themselves (those have their own tests) and not a real Broker or Authority.
const ABS = (name) => path.resolve(path.sep, 'albera-test', name);
const VM_A_GUID = '11111111-2222-4333-8444-555555555555';
const SECRET_MARKER = 'TOPSECRET-do-not-print';

const HELPER_SHA = 'e'.repeat(64);
const BROKER_EXPECT = { serviceName: 'AlberaHostBroker' }; // service-name mode only: no PID, and no image hash (the Control Plane's identity cannot open the Broker's process)
const DESKTOP = { helperPath: ABS('pipe-client.exe'), helperSha256: HELPER_SHA };
// A settings file the gated room accepts: the Broker by service name, the pinned helper, no attestation.
const settingsObject = (patch = {}) => ({
  version: 1,
  projectId: 'project-1',
  broker: { pipeName: 'ALBERA_HostBroker', expect: BROKER_EXPECT },
  authority: { pipeRoot: 'ALBERA\\ApprovalAuthority', expect: { serviceName: 'AlberaApprovalAuthority' } },
  journal: ABS('operations.sqlite'),
  computers: { 'albera-computer-a': 'computer-a', 'vm-b': 'computer-b' },
  desktop: DESKTOP,
  attestation: null,
  ...patch,
});
const attestationObject = (patch = {}) => ({ keyFile: ABS('broker-attestation.pem'), keyId: 'albera-broker-1', cloneRoot: ABS('clones'), ...patch });
const text = (patch) => JSON.stringify(settingsObject(patch));
const codeOf = (fn) => { try { fn(); } catch (error) { return error.message; } return 'no error'; };
const JOBS = [{ vmId: 'albera-computer-a', task: 'open notepad and write hello' }, { vmId: 'vm-b', task: 'rename the report' }];

// ---- the settings file ----

test('settings: a valid file parses to a frozen shape; attestation may be null or absent; a computer may be a bare computerId or name its Hyper-V VM', () => {
  const plain = parseApprovalSettings(text());
  assert.equal(plain.version, 1);
  assert.equal(plain.projectId, 'project-1');
  assert.deepEqual(plain.broker, { pipeName: 'ALBERA_HostBroker', expect: BROKER_EXPECT });
  assert.deepEqual(plain.authority, { pipeRoot: 'ALBERA\\ApprovalAuthority', expect: { serviceName: 'AlberaApprovalAuthority' } });
  assert.deepEqual(plain.desktop, DESKTOP);
  assert.equal(plain.attestation, null);
  assert.deepEqual([...plain.computers], [['albera-computer-a', { computerId: 'computer-a' }], ['vm-b', { computerId: 'computer-b' }]]);
  assert.ok(Object.isFrozen(plain));
  const { attestation, desktop, ...withoutKey } = settingsObject();
  assert.equal(attestation, null);
  assert.ok(desktop);
  const minimal = parseApprovalSettings(JSON.stringify(withoutKey));
  assert.deepEqual([minimal.attestation, minimal.desktop], [null, null], 'approval-check needs neither: both may be absent (the gated room asks for "desktop" itself)');
  assert.equal(parseApprovalSettings(JSON.stringify({ ...withoutKey, desktop: null })).desktop, null);
  const full = parseApprovalSettings(text({ attestation: attestationObject(), computers: { 'albera-computer-a': { computerId: 'computer-a', vmId: VM_A_GUID, expectedGeneration: 3 }, 'vm-b': 'computer-b' } }));
  assert.deepEqual(full.attestation, attestationObject());
  assert.deepEqual(full.computers.get('albera-computer-a'), { computerId: 'computer-a', vmId: VM_A_GUID, expectedGeneration: 3 });
  assert.deepEqual(full.computers.get('vm-b'), { computerId: 'computer-b' });
  assert.equal(parseApprovalSettings(`﻿${text()}`).projectId, 'project-1', 'a BOM is tolerated');
});

test('settings: every bad field is refused with its own fixed code, and the error never carries the file content', () => {
  const bad = (patch) => text({ ...patch });
  const wrongAttestation = (patch) => bad({ attestation: attestationObject(patch) });
  const table = [
    ['not json', '{ nope', 'runtime_room_approval_not_json'],
    ['array root', '[]', 'runtime_room_approval_invalid'],
    ['null root', 'null', 'runtime_room_approval_invalid'],
    ['too big', ' '.repeat(MAX_APPROVAL_SETTINGS_BYTES + 1), 'runtime_room_approval_too_big'],
    ['unknown top key', bad({ journalPassword: SECRET_MARKER }), 'runtime_room_approval_unknown_key'],
    ['version 2', bad({ version: 2 }), 'runtime_room_approval_version'],
    ['no version', bad({ version: undefined }), 'runtime_room_approval_version'],
    ['project missing', bad({ projectId: undefined }), 'runtime_room_approval_project'],
    ['project with a space', bad({ projectId: 'my project' }), 'runtime_room_approval_project'],
    ['broker missing', bad({ broker: undefined }), 'runtime_room_approval_broker'],
    ['broker unknown key', bad({ broker: { ...settingsObject().broker, token: SECRET_MARKER } }), 'runtime_room_approval_broker'],
    ['broker pipe name with a path', bad({ broker: { ...settingsObject().broker, pipeName: '..\\evil' } }), 'runtime_room_approval_broker'],
    ['broker pipe name missing', bad({ broker: { expect: { serviceName: 'AlberaHostBroker' } } }), 'runtime_room_approval_broker'],
    ['broker image hash in capitals', bad({ broker: { ...settingsObject().broker, expect: { ...BROKER_EXPECT, imageSha256: 'B'.repeat(64) } } }), 'runtime_room_approval_broker'],
    ['broker image hash of 63 characters', bad({ broker: { ...settingsObject().broker, expect: { ...BROKER_EXPECT, imageSha256: 'b'.repeat(63) } } }), 'runtime_room_approval_broker'],
    ['broker image hash that is a number', bad({ broker: { ...settingsObject().broker, expect: { ...BROKER_EXPECT, imageSha256: 7 } } }), 'runtime_room_approval_broker'],
    ['broker expect missing', bad({ broker: { pipeName: 'ALBERA_HostBroker' } }), 'runtime_room_approval_broker'],
    ['broker expect with pid and service', bad({ broker: { pipeName: 'ALBERA_HostBroker', expect: { serviceName: 'AlberaHostBroker', pid: 4 } } }), 'runtime_room_approval_broker'],
    ['broker expect unknown key', bad({ broker: { pipeName: 'ALBERA_HostBroker', expect: { serviceName: 'AlberaHostBroker', owner: 'x' } } }), 'runtime_room_approval_broker'],
    ['authority missing', bad({ authority: undefined }), 'runtime_room_approval_authority'],
    ['authority pipe root with an empty segment', bad({ authority: { ...settingsObject().authority, pipeRoot: 'ALBERA\\\\Authority' } }), 'runtime_room_approval_authority'],
    ['authority pipe root with dots', bad({ authority: { ...settingsObject().authority, pipeRoot: '..\\x' } }), 'runtime_room_approval_authority'],
    ['authority expect bad service name', bad({ authority: { ...settingsObject().authority, expect: { serviceName: 'a b' } } }), 'runtime_room_approval_authority'],
    ['authority unknown key', bad({ authority: { ...settingsObject().authority, cert: SECRET_MARKER } }), 'runtime_room_approval_authority'],
    ['journal relative', bad({ journal: 'operations.sqlite' }), 'runtime_room_approval_journal'],
    ['journal not normalized', bad({ journal: `${ABS('x')}${path.sep}..${path.sep}operations.sqlite` }), 'runtime_room_approval_journal'],
    ['journal is a drive root', bad({ journal: path.parse(ABS('x')).root }), 'runtime_room_approval_journal'],
    ['journal not a string', bad({ journal: 7 }), 'runtime_room_approval_journal'],
    ['computers empty', bad({ computers: {} }), 'runtime_room_approval_computers'],
    ['computers missing', bad({ computers: undefined }), 'runtime_room_approval_computers'],
    ['computers an array', bad({ computers: ['albera-computer-a'] }), 'runtime_room_approval_computers'],
    ['computers nine', bad({ computers: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`vm-${i}`, `computer-${i}`])) }), 'runtime_room_approval_computers'],
    ['computers bad vm name', bad({ computers: { 'vm a': 'computer-a' } }), 'runtime_room_approval_computers'],
    ['computers vm name starts with an underscore', bad({ computers: { _hidden: 'computer-a' } }), 'runtime_room_approval_computers'],
    ['computers bad computer id', bad({ computers: { 'albera-computer-a': 'computer a' } }), 'runtime_room_approval_computers'],
    ['computers computer id not a string', bad({ computers: { 'albera-computer-a': 5 } }), 'runtime_room_approval_computers'],
    ['computers object without computerId', bad({ computers: { 'albera-computer-a': { vmId: VM_A_GUID, expectedGeneration: 1 } } }), 'runtime_room_approval_computers'],
    ['computers object unknown key', bad({ computers: { 'albera-computer-a': { computerId: 'computer-a', note: 'x' } } }), 'runtime_room_approval_computers'],
    ['vmId without a generation', bad({ attestation: attestationObject(), computers: { 'albera-computer-a': { computerId: 'computer-a', vmId: VM_A_GUID } } }), 'runtime_room_approval_computers'],
    ['generation without a vmId', bad({ attestation: attestationObject(), computers: { 'albera-computer-a': { computerId: 'computer-a', expectedGeneration: 1 } } }), 'runtime_room_approval_computers'],
    ['vmId in capitals', bad({ attestation: attestationObject(), computers: { 'albera-computer-a': { computerId: 'computer-a', vmId: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', expectedGeneration: 1 } } }), 'runtime_room_approval_computers'],
    ['generation zero', bad({ attestation: attestationObject(), computers: { 'albera-computer-a': { computerId: 'computer-a', vmId: VM_A_GUID, expectedGeneration: 0 } } }), 'runtime_room_approval_computers'],
    ['generation a fraction', bad({ attestation: attestationObject(), computers: { 'albera-computer-a': { computerId: 'computer-a', vmId: VM_A_GUID, expectedGeneration: 1.5 } } }), 'runtime_room_approval_computers'],
    ['an attested VM whose name is not albera-<computerId> (its checkpoint would be of another VM)', bad({ attestation: attestationObject(), computers: { 'vm-x': { computerId: 'computer-a', vmId: VM_A_GUID, expectedGeneration: 1 } } }), 'runtime_room_approval_computers'],
    ['two VM names for one computer id', bad({ computers: { 'albera-computer-a': 'computer-a', 'vm-b': 'computer-a' } }), 'runtime_room_approval_computers'],
    ['a vmId without attestation', bad({ computers: { 'albera-computer-a': { computerId: 'computer-a', vmId: VM_A_GUID, expectedGeneration: 1 } } }), 'runtime_room_approval_computers'],
    ['desktop a string', bad({ desktop: 'on' }), 'runtime_room_approval_desktop'],
    ['desktop an array', bad({ desktop: [] }), 'runtime_room_approval_desktop'],
    ['desktop without the helper hash', bad({ desktop: { helperPath: DESKTOP.helperPath } }), 'runtime_room_approval_desktop'],
    ['desktop without the helper path', bad({ desktop: { helperSha256: HELPER_SHA } }), 'runtime_room_approval_desktop'],
    ['desktop unknown key', bad({ desktop: { ...DESKTOP, pipeName: 'x' } }), 'runtime_room_approval_desktop'],
    ['desktop holding a secret', bad({ desktop: { ...DESKTOP, password: SECRET_MARKER } }), 'runtime_room_approval_desktop'],
    ['desktop helper path relative', bad({ desktop: { ...DESKTOP, helperPath: 'pipe-client.exe' } }), 'runtime_room_approval_desktop'],
    ['desktop helper path not normalized', bad({ desktop: { ...DESKTOP, helperPath: `${ABS('x')}${path.sep}..${path.sep}pipe-client.exe` } }), 'runtime_room_approval_desktop'],
    ['desktop helper path on a UNC share', bad({ desktop: { ...DESKTOP, helperPath: '\\\\server\\share\\pipe-client.exe' } }), 'runtime_room_approval_desktop'],
    ['desktop helper hash in capitals', bad({ desktop: { ...DESKTOP, helperSha256: 'E'.repeat(64) } }), 'runtime_room_approval_desktop'],
    ['desktop helper hash too short', bad({ desktop: { ...DESKTOP, helperSha256: 'e'.repeat(63) } }), 'runtime_room_approval_desktop'],
    ['desktop helper hash not a string', bad({ desktop: { ...DESKTOP, helperSha256: 7 } }), 'runtime_room_approval_desktop'],
    ['attestation a string', bad({ attestation: 'on' }), 'runtime_room_approval_attestation'],
    ['attestation an array', bad({ attestation: [] }), 'runtime_room_approval_attestation'],
    ['attestation key file relative', wrongAttestation({ keyFile: 'broker.pem' }), 'runtime_room_approval_attestation'],
    ['attestation clone root relative', wrongAttestation({ cloneRoot: 'clones' }), 'runtime_room_approval_attestation'],
    ['attestation key file not normalized', wrongAttestation({ keyFile: `${ABS('x')}${path.sep}..${path.sep}broker.pem` }), 'runtime_room_approval_attestation'],
    ['attestation key file on a UNC share', wrongAttestation({ keyFile: '\\\\server\\share\\broker.pem' }), 'runtime_room_approval_attestation'],
    ['attestation clone root not normalized', wrongAttestation({ cloneRoot: `${ABS('x')}${path.sep}..${path.sep}clones` }), 'runtime_room_approval_attestation'],
    ['attestation key id with a space', wrongAttestation({ keyId: 'my key' }), 'runtime_room_approval_attestation'],
    ['attestation key id missing', wrongAttestation({ keyId: undefined }), 'runtime_room_approval_attestation'],
    ['attestation key file missing', wrongAttestation({ keyFile: undefined }), 'runtime_room_approval_attestation'],
    ['attestation unknown key (golden images are not needed)', wrongAttestation({ goldenImages: {} }), 'runtime_room_approval_attestation'],
    ['attestation holding the key itself', wrongAttestation({ privateKey: SECRET_MARKER }), 'runtime_room_approval_attestation'],
  ];
  for (const [label, body, code] of table) {
    const message = codeOf(() => parseApprovalSettings(body));
    assert.equal(message, code, label);
    assert.ok(!message.includes(SECRET_MARKER) && !message.includes('albera-test'), `${label}: the error is a fixed code`);
  }
  assert.equal(codeOf(() => parseApprovalSettings(7)), 'runtime_room_approval_too_big');
});

test('the shipped example parses (its Windows paths swapped for this OS\'s) and holds only placeholder values and paths, never key material', () => {
  const raw = readFileSync(new URL('../examples/albera.approval.example.json', import.meta.url), 'utf8');
  assert.doesNotMatch(raw, /BEGIN|PRIVATE KEY|password|secret|token/i);
  const example = JSON.parse(raw);
  const swapped = { ...example, journal: ABS('operations.sqlite'), desktop: { ...example.desktop, helperPath: ABS('pipe-client.exe') } };
  const parsed = parseApprovalSettings(JSON.stringify(swapped));
  assert.deepEqual([...parsed.computers.keys()], ['albera-clone-01', 'albera-clone-02']);
  assert.equal(parsed.attestation, null, 'the gated room refuses an attestation, so the example has none');
  assert.deepEqual([parsed.broker.expect, parsed.desktop.helperSha256], [{ serviceName: 'AlberaHostBroker' }, example.desktop.helperSha256], 'by service name, no image hash');
});

test('settings: a prototype-polluting key is just an unknown key or a bad VM name', () => {
  assert.equal(codeOf(() => parseApprovalSettings('{"__proto__": {"x": 1}, "version": 1}')), 'runtime_room_approval_unknown_key');
  assert.equal(codeOf(() => parseApprovalSettings(text({ computers: JSON.parse('{"__proto__": "computer-a"}') }))), 'runtime_room_approval_computers');
});

test('loadApprovalSettings: a regular small file; anything else is unreadable and the error does not name the path', () => {
  const io = (stat, content = text()) => ({ statSync: () => stat, readFileSync: () => content });
  assert.equal(loadApprovalSettings(ABS('a.json'), io({ isFile: () => true, size: 100 })).projectId, 'project-1');
  for (const [label, fake] of [
    ['a directory', io({ isFile: () => false, size: 0 })],
    ['too big', io({ isFile: () => true, size: MAX_APPROVAL_SETTINGS_BYTES + 1 })],
    ['stat throws', { statSync: () => { throw new Error(`ENOENT ${SECRET_MARKER}`); }, readFileSync: () => text() }],
    ['read throws', { statSync: () => ({ isFile: () => true, size: 1 }), readFileSync: () => { throw new Error(SECRET_MARKER); } }],
  ]) {
    const message = codeOf(() => loadApprovalSettings(ABS('secret-dir/a.json'), fake));
    assert.equal(message, 'runtime_room_approval_unreadable', label);
    assert.ok(!message.includes(SECRET_MARKER) && !message.includes('secret-dir'));
  }
  assert.equal(codeOf(() => loadApprovalSettings(ABS('a.json'), io({ isFile: () => true, size: 3 }, '{ nope'))), 'runtime_room_approval_not_json');
});

test('jobs against the settings: a VM that is not in "computers" and a task that cannot be a task.start are refused', () => {
  const settings = parseApprovalSettings(text());
  assert.doesNotThrow(() => checkJobsAgainstSettings(settings, JOBS));
  assert.equal(codeOf(() => checkJobsAgainstSettings(settings, [...JOBS, { vmId: 'vm-c', task: 'x' }])), 'runtime_room_approval_vm_unmapped');
  for (const task of ['', 'x'.repeat(257), 'bad\u0007text', 'あ'.repeat(86)]) {
    assert.equal(codeOf(() => checkJobsAgainstSettings(settings, [{ vmId: 'albera-computer-a', task }])), 'runtime_room_approval_task_not_startable', JSON.stringify(task.slice(0, 8)));
  }
  assert.doesNotThrow(() => checkJobsAgainstSettings(settings, [{ vmId: 'albera-computer-a', task: 'あ'.repeat(85) }]), '85 x 3 bytes = 255');
});

// ---- the command line ----

test('--require-start-approval and --approval come as a pair; each alone, twice, or without a value is refused with a fixed code', () => {
  const job = ['--job', 'vm-a=do the thing'];
  assert.deepEqual(takeRoomApprovalArgs([...job]), { rest: job, approvalFile: null });
  assert.deepEqual(takeRoomApprovalArgs([...job, '--require-start-approval', '--approval', 'a.json']), { rest: job, approvalFile: 'a.json' });
  assert.deepEqual(takeRoomApprovalArgs(['--approval', 'a.json', ...job, '--require-start-approval']), { rest: job, approvalFile: 'a.json' });
  const refused = (args) => codeOf(() => takeRoomApprovalArgs(args));
  assert.equal(refused([...job, '--require-start-approval']), 'runtime_room_start_approval_needs_settings');
  assert.equal(refused([...job, '--approval', 'a.json']), 'runtime_room_approval_needs_start_approval');
  assert.equal(refused([...job, '--require-start-approval', '--require-start-approval', '--approval', 'a.json']), 'runtime_option_must_be_unique');
  assert.equal(refused([...job, '--require-start-approval', '--approval', 'a.json', '--approval', 'b.json']), 'runtime_option_must_be_unique');
  assert.equal(refused([...job, '--require-start-approval', '--approval']), 'runtime_option_requires_value');
  assert.equal(refused([...job, '--require-start-approval', '--approval', '--job']), 'runtime_option_requires_value');
  assert.equal(refused([...job, '--require-start-approval', '--approval', '']), 'runtime_option_requires_value');
});

test('room options: the pair is parsed for --job and --workspace rooms; the demo takes neither; the rest of the room options are unchanged', () => {
  const base = ['room', '--job', 'vm-a=do the thing'];
  const plain = parseRuntimeArgs(base);
  assert.equal(plain.requireStartApproval, undefined);
  assert.equal(plain.approvalFile, undefined);
  const gated = parseRuntimeArgs([...base, '--require-start-approval', '--approval', 'albera.approval.json']);
  assert.equal(gated.requireStartApproval, true);
  assert.equal(gated.approvalFile, 'albera.approval.json');
  assert.deepEqual(gated.jobs, plain.jobs);
  assert.equal(parseRuntimeArgs(['room', '--approval', 'a.json', '--require-start-approval', '--job', 'vm-a=x']).jobs.length, 1);
  const workspace = parseRuntimeArgs(['room', '--workspace', 'w.json', '--require-start-approval', '--approval', 'a.json']);
  assert.deepEqual([workspace.workspaceFile, workspace.requireStartApproval, workspace.approvalFile], ['w.json', true, 'a.json']);
  assert.throws(() => parseRuntimeArgs([...base, '--require-start-approval']), /runtime_room_start_approval_needs_settings/);
  assert.throws(() => parseRuntimeArgs([...base, '--approval', 'a.json']), /runtime_room_approval_needs_start_approval/);
  assert.throws(() => parseRuntimeArgs(['room', '--demo', '--require-start-approval', '--approval', 'a.json']), /invalid_runtime_option/);
  assert.throws(() => parseRuntimeArgs(['room', '--workspace', 'w.json', '--approval', 'a.json']), /runtime_room_approval_needs_start_approval/);
  assert.throws(() => parseRuntimeArgs(['fleet', '--job', 'vm-a=x', '--approval', 'a.json']), /invalid_runtime_option|runtime_option/, 'fleet does not take it');
});

test('help describes the gated form; it names no service and carries no stub text', () => {
  assert.match(RUNTIME_HELP, /--require-start-approval --approval <albera\.approval\.json>/);
  assert.match(RUNTIME_HELP, /examples\/albera\.approval\.example\.json/);
  assert.doesNotMatch(RUNTIME_HELP, /not available yet|do not exist yet|runtime_room_start_approval_unavailable/);
});

// ---- the composition ----

/**
 * Fakes for everything outside the process. `world` records what the wiring handed them. The desktop client is the Fake of the desktop Broker client, and the claim client plays the Broker's side
 * effect of recording a task.start claim: it makes the desktop lease for that operation (`world.desktop.grantLease`).
 */
function makeWorld({ approval = 'approve', storeFails = false, clientFails = false } = {}) {
  const authority = createTestAuthority();
  const desktop = createFakeDesktopBrokerClient({ computers: ['computer-a', 'computer-b'] });
  const world = {
    clock: 1_800_000_000_000, calls: [], stores: [], closed: 0, fields: new Map(), claims: [], submissions: [], opened: [], journal: createMemoryFlowJournal(),
    desktop, desktopOptions: [], desktopClosed: 0,
  };
  const seconds = () => Math.floor(world.clock / 1000);
  world.deps = {
    async sendBrokerFence(options) {
      world.calls.push(['fence', options]);
      return { ok: true, brokerEpoch: 1, leaseGeneration: 7, leaseId: 'lease-1', brokerChallenge: randomBytes(16).toString('base64url') };
    },
    async sendBrokerRequest(options) {
      world.calls.push(['claim', options]);
      world.claims.push(options);
      if (options.action?.action === 'task.start') {
        const submitted = world.submissions.findLast((s) => s.action.computerId === options.action.computerId && s.action.args.task === options.action.args.task);
        desktop.grantLease(options.action.computerId, submitted.operationId);
      }
      return { ok: true, state: 'UNKNOWN', action: options.action?.action };
    },
    async sendBrokerInspect(options) { world.calls.push(['inspect', options]); return { ok: false, code: 'denied' }; },
    async submitApproval(options) {
      world.calls.push(['submit', options]);
      world.submissions.push(options);
      const approvalId = stableUuid(`${options.operationId}/${options.idempotencyKey}`);
      world.fields.set(approvalId, options);
      return { ok: true, approvalId, state: 'pending', expiresAt: seconds() + 60 };
    },
    async getApprovalStatus(options) {
      world.calls.push(['status', options]);
      if (approval === 'deny') return { ok: false, code: 'human_denied' };
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
      const store = { flowJournal: () => world.journal, close: () => { world.closed += 1; } };
      world.stores.push(store);
      return store;
    },
    createDesktopClient(options) {
      world.desktopOptions.push(options);
      if (clientFails) throw new TypeError(`invalid ${SECRET_MARKER}`);
      return {
        captureVmScreen: (request) => desktop.captureVmScreen(request),
        sendVmInput: (request) => desktop.sendVmInput(request),
        close: async () => { world.desktopClosed += 1; await desktop.close(); },
      };
    },
    newOperationId: (() => { let n = 0; return () => `room-start-${(n += 1)}`; })(),
    now: () => world.clock,
    sleep: async (ms) => { world.clock += ms; },
  };
  return world;
}

const fileIo = (files) => ({
  statSync: (file) => {
    if (!Object.hasOwn(files, file)) throw new Error('ENOENT');
    return { isFile: () => true, size: files[file].length };
  },
  readFileSync: (file) => files[file],
});
const SETTINGS_FILE = ABS('albera.approval.json');
const open = (world, { files, jobs = JOBS, patch = {} } = {}) => openRoomApproval({
  approvalFile: SETTINGS_FILE, jobs, io: fileIo(files ?? { [SETTINGS_FILE]: text(patch) }), deps: world.deps,
});

test('the gate asks a person for exactly { task }; the real clients are bound to the configured pipes and expectations; the flow writes to the durable journal', async () => {
  const world = makeWorld();
  const approval = await open(world);
  assert.deepEqual(world.opened, [ABS('operations.sqlite')]);
  assert.match(approval.notice, /Hands start only after approval/);
  assert.match(approval.notice, /Host Broker desktop pipe/);
  assert.deepEqual(await approval.gate.startApproved({ vmId: 'albera-computer-a', task: 'open notepad and write hello' }), { ok: true, operationId: 'room-start-1' });
  const [fence, submit, status, claim] = world.calls;
  const broker = { pipeName: 'ALBERA_HostBroker', expect: BROKER_EXPECT };
  const authority = { pipeRoot: 'ALBERA\\ApprovalAuthority', expect: { serviceName: 'AlberaApprovalAuthority' } };
  assert.deepEqual(world.calls.map(([name]) => name), ['fence', 'submit', 'status', 'claim']);
  assert.deepEqual(fence, ['fence', { ...broker, computerId: 'computer-a' }]);
  assert.equal(submit[1].pipeRoot, authority.pipeRoot);
  assert.deepEqual(submit[1].expect, authority.expect);
  assert.deepEqual(submit[1].action, { action: 'task.start', projectId: 'project-1', computerId: 'computer-a', args: { task: 'open notepad and write hello' } });
  assert.equal(submit[1].purpose, 'guest.command');
  assert.equal(submit[1].attestation, undefined, 'a person is asked: nothing is attested');
  assert.deepEqual([status[1].pipeRoot, status[1].expect], [authority.pipeRoot, authority.expect]);
  assert.deepEqual([claim[1].pipeName, claim[1].expect], [broker.pipeName, broker.expect]);
  assert.deepEqual(claim[1].action, submit[1].action, 'the claim carries the DTO that was approved');
  const record = world.journal.get('room-start-1');
  assert.equal(record.phase, 'CLAIMED', 'the operation is in the store the settings name');
  assert.equal(world.closed, 0);
  approval.close();
  approval.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(world.closed >= 1, 'close() closes the store (and tolerates a second call)');
  assert.ok(world.desktopClosed >= 1 && world.desktop.isClosed(), 'and the desktop client, whose helper processes end with it');
});

test('each start is a fresh operation with its own computer', async () => {
  const world = makeWorld();
  const approval = await open(world);
  assert.deepEqual(await approval.gate.startApproved({ vmId: 'albera-computer-a', task: 'one' }), { ok: true, operationId: 'room-start-1' });
  assert.deepEqual(await approval.gate.startApproved({ vmId: 'vm-b', task: 'two' }), { ok: true, operationId: 'room-start-2' });
  assert.deepEqual(world.submissions.map((s) => [s.operationId, s.action.computerId]), [['room-start-1', 'computer-a'], ['room-start-2', 'computer-b']]);
});

test('the default operation ids are random, valid and new each time (real defaults, no injection)', async () => {
  const seen = new Set();
  for (let i = 0; i < 5; i += 1) {
    const world = makeWorld();
    delete world.deps.newOperationId; // the wiring's own default
    const approval = await open(world);
    await approval.gate.startApproved({ vmId: 'albera-computer-a', task: 'x' });
    const id = world.submissions[0].operationId;
    assert.match(id, /^start-[0-9a-f]{16}$/);
    seen.add(id);
  }
  assert.equal(seen.size, 5);
});

test('a denied approval is start_denied and nothing is claimed', async () => {
  const world = makeWorld({ approval: 'deny' });
  const approval = await open(world);
  assert.deepEqual(await approval.gate.startApproved({ vmId: 'albera-computer-a', task: 'x' }), { ok: false, code: 'start_denied' });
  assert.equal(world.claims.length, 0);
});

test('a VM that is not in "computers" is refused before ANY request and before the store is opened; so is a task that cannot be a task.start', async () => {
  const world = makeWorld();
  await assert.rejects(open(world, { jobs: [...JOBS, { vmId: 'vm-unknown', task: 'x' }] }), { message: 'runtime_room_approval_vm_unmapped' });
  await assert.rejects(open(world, { jobs: [{ vmId: 'albera-computer-a', task: 'x'.repeat(300) }] }), { message: 'runtime_room_approval_task_not_startable' });
  assert.deepEqual([world.opened, world.calls, world.desktopOptions], [[], [], []], 'nothing was opened, requested or built');
  // and the gate itself refuses a VM later on (a card on a VM the map does not know) without a single request
  const approval = await open(world);
  assert.deepEqual(await approval.gate.startApproved({ vmId: 'vm-unknown', task: 'x' }), { ok: false, code: 'vm_unknown' });
  assert.deepEqual(world.calls, []);
});

test('a store that cannot be opened is a fixed code that names nothing; settings errors come first and open nothing', async () => {
  const world = makeWorld({ storeFails: true });
  const error = await open(world).catch((e) => e);
  assert.equal(error.message, 'runtime_room_approval_journal_unavailable');
  assert.ok(!error.message.includes(SECRET_MARKER));
  const fresh = makeWorld();
  await assert.rejects(open(fresh, { files: {} }), { message: 'runtime_room_approval_unreadable' });
  await assert.rejects(open(fresh, { files: { [SETTINGS_FILE]: '{ nope' } }), { message: 'runtime_room_approval_not_json' });
  assert.deepEqual(fresh.opened, []);
});

test('a flow that cannot be built closes the store it opened', async () => {
  const world = makeWorld();
  world.deps.now = 'not a function';
  await assert.rejects(open(world), { message: 'runtime_room_approval_wiring_failed' });
  assert.equal(world.closed, 1);
});

test('initial jobs: every job is requested through the room host start path, with exactly its own task; nothing else is called', async () => {
  const world = makeWorld();
  const approval = await open(world);
  const requested = [];
  const answers = await approval.requestInitialStarts({ requestStart: async (vmId, task) => { requested.push([vmId, task]); return 'pending_approval'; } });
  assert.deepEqual(requested, JOBS.map(({ vmId, task }) => [vmId, task]));
  assert.deepEqual(answers, ['pending_approval', 'pending_approval']);
  assert.deepEqual(world.calls, [], 'requesting is the host\'s business; the gate has not been asked by the wiring itself');
});

// ---- what the gated room does not have (ADR-002 "Amendment 2026-11-03", "Out of scope for the first gated run") ----

test('a task.start checkpoint attestation is refused at start with the fixed out-of-scope code, before the store is opened, a client is built or any request is made', async () => {
  const attested = { attestation: attestationObject(), computers: { 'albera-computer-a': { computerId: 'computer-a', vmId: VM_A_GUID, expectedGeneration: 3 }, 'vm-b': 'computer-b' } };
  const world = makeWorld();
  const error = await open(world, { patch: attested }).catch((e) => e);
  assert.equal(error.message, GATED_OUT_OF_SCOPE);
  assert.deepEqual([world.opened, world.desktopOptions, world.calls], [[], [], []]);
});

test('refuseGatedOutOfScope: guest capture, done checks (a checks file or a workspace\'s checks) and the guest password file are refused with the same code; a plain room passes', () => {
  const plain = { jobs: JOBS, guestCapture: [], checks: {}, checksFile: null, guestPasswordFile: null };
  assert.doesNotThrow(() => refuseGatedOutOfScope(plain));
  assert.doesNotThrow(() => refuseGatedOutOfScope({ jobs: JOBS }));
  for (const [label, patch] of [
    ['guest capture', { guestCapture: ['vm-b'] }], ['a checks file', { checksFile: ABS('checks.json') }],
    ['workspace checks', { checks: { 'vm-b': [{ kind: 'file_exists', path: 'C:\\x' }] } }], ['a guest password file', { guestPasswordFile: ABS('pw.txt') }],
  ]) assert.equal(codeOf(() => refuseGatedOutOfScope({ ...plain, ...patch })), GATED_OUT_OF_SCOPE, label);
  assert.match(GATED_OUT_OF_SCOPE_LINE, /^runtime_room_gated_out_of_scope: guest capture, done checks, the guest helper and task\.start checkpoint attestation are not available with --require-start-approval/);
  assert.equal(GATED_OUT_OF_SCOPE_LINE.includes('\n'), false, 'one line');
});

// ---- the desktop path: the room's screens and input go through the desktop Broker client, and nothing else ----

const CLICK = { action: 'left_click', coordinate: [10, 20] };
const aiLease = (operationId, vmId = 'albera-computer-a', generation = 1) => ({
  desktopSessionId: operationId, ownerType: 'AI', ownerId: `albera-agent-${vmId}`, generation, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});
const failureOf = async (promise) => { try { await promise; } catch (error) { return error; } return assert.fail('expected a rejection'); };

test('the desktop client is made from the settings: the Broker\'s pipe name (the client adds _desktop), its service name and no image hash, and the pinned helper; nothing is sent yet', async () => {
  const world = makeWorld();
  const approval = await open(world);
  assert.deepEqual(world.desktopOptions, [{ pipeName: 'ALBERA_HostBroker', expect: { serviceName: 'AlberaHostBroker' }, helperPath: DESKTOP.helperPath, helperSha256: HELPER_SHA }]);
  assert.equal(Object.hasOwn(world.desktopOptions[0].expect, 'imageSha256'), false);
  assert.deepEqual([world.desktop.captures, world.desktop.inputs], [[], []]);
  assert.deepEqual(Object.keys(approval.desktopBroker).sort(), ['captureVmScreen', 'sendVmInput'], 'exactly the two calls HyperVDesktopDriver takes from a Broker');
  assert.ok(Object.isFrozen(approval.desktopBroker));
});

test('the real desktop client factory accepts what the settings give it (no start: the client is lazy), and is the default', async () => {
  assert.equal(REAL_APPROVAL_DEPS.createDesktopClient, createWindowsDesktopBrokerClient);
  const world = makeWorld();
  delete world.deps.createDesktopClient; // the wiring's own
  const approval = await open(world);
  assert.deepEqual(Object.keys(approval.desktopBroker).sort(), ['captureVmScreen', 'sendVmInput']);
  approval.close();
});

test('the gated room needs the desktop settings and a Broker expected by service name: no desktop section, an { ownerSid, pid } expectation, or an image hash (the helper could never verify it as the Control Plane), or options the client refuses are runtime_room_approval_desktop before the store is opened', async () => {
  const cases = [
    ['no desktop section', { desktop: undefined }],
    ['a null desktop section', { desktop: null }],
    ['{ ownerSid, pid } instead of a service name', { broker: { pipeName: 'ALBERA_HostBroker', expect: { ownerSid: 'S-1-5-21-1-2-3-4', pid: 4242 } } }],
    ['an image hash next to the service name', { broker: { pipeName: 'ALBERA_HostBroker', expect: { serviceName: 'AlberaHostBroker', imageSha256: 'b'.repeat(64) } } }],
    ['{ ownerSid, pid } with an image hash', { broker: { pipeName: 'ALBERA_HostBroker', expect: { ownerSid: 'S-1-5-21-1-2-3-4', pid: 4242, imageSha256: 'b'.repeat(64) } } }],
  ];
  for (const [label, patch] of cases) {
    const world = makeWorld();
    const error = await open(world, { patch }).catch((e) => e);
    assert.equal(error.message, 'runtime_room_approval_desktop', label);
    assert.deepEqual([world.opened, world.calls, world.desktopOptions], [[], [], []], label);
  }
  const world = makeWorld({ clientFails: true });
  const error = await open(world).catch((e) => e);
  assert.equal(error.message, 'runtime_room_approval_desktop', 'the client refused its options');
  assert.ok(!error.message.includes(SECRET_MARKER));
  assert.deepEqual(world.opened, [], 'and the store was not opened');
  // approval-check does not need any of it: the same file without the section still parses
  assert.equal(parseApprovalSettings(text({ desktop: undefined, broker: { pipeName: 'ALBERA_HostBroker', expect: { serviceName: 'AlberaHostBroker' } } })).desktop, null);
});

test('a store that cannot be opened closes the desktop client that was already made', async () => {
  const world = makeWorld({ storeFails: true });
  await assert.rejects(open(world), { message: 'runtime_room_approval_journal_unavailable' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(world.desktopClosed, 1);
});

test('the Broker object maps VM names to computer ids; a lease reaches the Broker as its operation id alone (the Node job number is not the Broker\'s generation); an unknown VM sends nothing; only the approved operation may drive', async () => {
  const world = makeWorld();
  const { desktopBroker, gate } = await open(world);
  const png = await desktopBroker.captureVmScreen({ vmId: 'albera-computer-a', width: 640, height: 480 });
  assert.ok(png.length > 0);
  assert.deepEqual(world.desktop.captures, [{ computerId: 'computer-a', width: 640, height: 480 }]);
  const lease = aiLease('room-start-1', 'albera-computer-a', 5); // the Node-side job number is 5; the Broker's lease will be generation 1
  assert.equal((await failureOf(desktopBroker.sendVmInput({ vmId: 'albera-computer-a', action: CLICK, lease }))).brokerCode, 'denied', 'no claim, no lease');
  assert.deepEqual(await gate.startApproved({ vmId: 'albera-computer-a', task: 'x' }), { ok: true, operationId: 'room-start-1' }); // the Broker records the claim and makes the lease
  assert.deepEqual(await desktopBroker.sendVmInput({ vmId: 'albera-computer-a', action: CLICK, lease }), { ok: true });
  assert.deepEqual(world.desktop.inputs.map(({ computerId, operationId, leaseGeneration }) => ({ computerId, operationId, leaseGeneration })), [{ computerId: 'computer-a', operationId: 'room-start-1', leaseGeneration: null }]);
  const unknown = await failureOf(desktopBroker.captureVmScreen({ vmId: 'vm-unknown', width: 640, height: 480 }));
  assert.deepEqual([unknown.code, unknown.outcome], ['desktop_vm_not_found', 'not_applied']);
  const unknownInput = await failureOf(desktopBroker.sendVmInput({ vmId: 'vm-unknown', action: CLICK, lease }));
  assert.deepEqual([unknownInput.code, unknownInput.outcome], ['desktop_vm_not_found', 'not_applied']);
  assert.equal(world.desktop.captures.length, 1);
  assert.equal(world.desktop.inputs.length, 1);
  // the other computer's VM has no lease: the operation of computer-a does not open it
  assert.equal((await failureOf(desktopBroker.sendVmInput({ vmId: 'vm-b', action: CLICK, lease }))).brokerCode, 'denied');
});

test('a stale operation id is refused by the Broker: a newer start on the same computer replaces the lease, the older operation can no longer drive', async () => {
  const world = makeWorld();
  const { desktopBroker, gate } = await open(world);
  const first = await gate.startApproved({ vmId: 'albera-computer-a', task: 'one' });
  const second = await gate.startApproved({ vmId: 'albera-computer-a', task: 'two' });
  const other = await gate.startApproved({ vmId: 'vm-b', task: 'three' });
  assert.deepEqual([first.operationId, second.operationId, other.operationId], ['room-start-1', 'room-start-2', 'room-start-3']);
  const denied = await failureOf(desktopBroker.sendVmInput({ vmId: 'albera-computer-a', action: CLICK, lease: aiLease(first.operationId) }));
  assert.deepEqual([denied.code, denied.outcome, denied.brokerCode], ['desktop_unavailable', 'unknown', 'denied']);
  assert.deepEqual(await desktopBroker.sendVmInput({ vmId: 'albera-computer-a', action: CLICK, lease: aiLease(second.operationId) }), { ok: true });
  assert.deepEqual(await desktopBroker.sendVmInput({ vmId: 'vm-b', action: CLICK, lease: aiLease(other.operationId, 'vm-b') }), { ok: true });
  assert.deepEqual(world.desktop.inputs.map(({ computerId, operationId }) => [computerId, operationId]), [['computer-a', 'room-start-2'], ['computer-b', 'room-start-3']]);
});

test('a human takeover on the Node side stops the AI\'s input before the Broker is asked; the human\'s view-only lease still captures', async () => {
  const world = makeWorld();
  const { desktopBroker, gate } = await open(world);
  const { operationId } = await gate.startApproved({ vmId: 'albera-computer-a', task: 'x' });
  const mine = aiLease(operationId);
  let current = mine;
  const driver = new HyperVDesktopDriver({ broker: desktopBroker, resolveCurrentLease: async () => current });
  assert.deepEqual(await driver.act({ vmId: 'albera-computer-a', lease: mine, action: CLICK }), { ok: true });
  assert.equal(world.desktop.inputs.length, 1);
  const human = { ...mine, ownerType: 'HUMAN', ownerId: 'room-viewer', generation: 2 };
  current = human; // the person took the desktop
  const stopped = await failureOf(driver.act({ vmId: 'albera-computer-a', lease: mine, action: CLICK }));
  assert.deepEqual([stopped.code, stopped.outcome], ['desktop_lease_stale', 'not_applied']);
  assert.equal(world.desktop.inputs.length, 1, 'the Broker was never asked');
  assert.ok((await driver.capture({ vmId: 'albera-computer-a', lease: human })).png.length > 0);
  assert.equal(world.desktop.captures.length, 1);
});

// A gated room as the CLI builds it (entry.mjs): the wiring's gate and Broker object, a fleet with no initial jobs, the room host. The AI is the scripted Fake; the desktop client is the Fake.
const untilTrue = async (condition, what) => {
  for (let i = 0; i < 400; i += 1) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail(`timed out waiting for ${what}`);
};

test('a gated room over the Fake desktop client: every screen and input of the approved hands goes through the Broker object, the hands\' desktop session is the approved operation, and no Hyper-V prototype is built', async (t) => {
  const world = makeWorld();
  const approval = await open(world);
  const board = createAgentStatusBoard();
  const entries = [];
  let room;
  const fleet = createAgentFleet({
    jobs: [], vmIds: JOBS.map((job) => job.vmId), keepAlive: true, board,
    createDriver: (vmId, lease) => new HyperVDesktopDriver({ broker: approval.desktopBroker, resolveCurrentLease: async () => lease }),
    createClient: () => createFakeComputerUseClient([fakeReply([fakeToolUse('mouse_move', { coordinate: [7, 9] })]), fakeText('DONE: moved')]),
    limits: { maxSteps: 10, maxUsd: 10, maxMs: 3_600_000 }, prices: MODEL_PRICES['claude-haiku-5-5'], totalMaxUsd: 100,
    onEvent: (vmId, event) => room?.recordFleetEvent(vmId, event),
  });
  const journal = {
    record: ({ vmId, actor, code, params }) => { const entry = Object.freeze({ seq: entries.length + 1, at: Date.now(), vmId, actor, code, params: cleanParams(params) }); entries.push(entry); return entry; },
    recordFleetEvent: () => null, since: (seq) => entries.filter((entry) => entry.seq > seq), lastSeq: () => entries.length,
  };
  const director = { tick: () => ({ acts: [], ledger: [] }), decide: () => ({ ok: false, code: 'card_unknown' }) };
  room = createRoomHost({
    vms: JOBS.map(({ vmId, task }) => ({ vmId, label: vmId, task })), board, journal, director, fleet, startGate: approval.gate, captureIntervalMs: 60_000, tickMs: 60_000,
    driver: (resolveCurrentLease) => new HyperVDesktopDriver({ broker: approval.desktopBroker, resolveCurrentLease }),
  });
  const running = fleet.run();
  await room.listen(0);
  t.after(async () => { fleet.close(); await running; await room.close(); approval.close(); });
  assert.deepEqual(await approval.requestInitialStarts(room), ['pending_approval', 'pending_approval']);
  await untilTrue(() => JOBS.every((job) => board.snapshot()[job.vmId]?.state === 'done'), 'both hands to finish');
  const operations = Object.fromEntries(world.submissions.map((submitted) => [submitted.action.computerId, submitted.operationId]));
  assert.deepEqual(world.desktop.inputs.map(({ computerId, operationId, leaseGeneration }) => ({ computerId, operationId, leaseGeneration })).sort((a, b) => a.computerId.localeCompare(b.computerId)), [
    { computerId: 'computer-a', operationId: operations['computer-a'], leaseGeneration: null },
    { computerId: 'computer-b', operationId: operations['computer-b'], leaseGeneration: null },
  ], 'one move each, on the computer the VM maps to, named by the approved operation, joining the Broker\'s current lease');
  assert.ok(world.desktop.captures.length >= 2 && world.desktop.captures.every(({ computerId }) => ['computer-a', 'computer-b'].includes(computerId)), 'the screens came through the Broker object');
  assert.deepEqual(entries.filter((entry) => entry.code === 'start_approved' || entry.code === 'start_refused').map((entry) => entry.code), ['start_approved', 'start_approved']);
});

test('source guard: a gated room takes its Broker from the wiring and the same-user Hyper-V prototype only when ungated; the wiring imports no Hyper-V module and starts no process', () => {
  const read = (name) => readFileSync(new URL(`../src/runtime/${name}`, import.meta.url), 'utf8');
  const entry = read('entry.mjs');
  const room = entry.slice(entry.indexOf('async function runRoom('), entry.indexOf('async function main()'));
  assert.match(room, /const broker = approval \? approval\.desktopBroker : createHyperVDesktopBrokerPrototype\(\{ guestScreens \}\);/);
  assert.equal([...room.matchAll(/createHyperVDesktopBrokerPrototype\(/g)].length, 1, 'no second way to a prototype in the room');
  assert.equal([...room.matchAll(/guestScreensOf\(/g)].length, 1);
  assert.ok(room.indexOf('refuseGatedOutOfScope(') > 0 && room.indexOf('refuseGatedOutOfScope(') < room.indexOf('process.env.ANTHROPIC_API_KEY'), 'the out-of-scope refusal comes before the API key is read');
  const wiring = read('room-approval-wiring.mjs');
  assert.deepEqual(wiring.match(/^import .*from '\.\/[^']*hyperv[^']*';$/gm), null, 'no import of a Hyper-V module');
  assert.equal(/child_process|\bspawn\b|ANTHROPIC/.test(wiring), false);
});

// ---- the command in a child process: the refusal happens before anything is requested ----

const run = promisify(execFile);
const ENTRY = fileURLToPath(new URL('../src/runtime/entry.mjs', import.meta.url));

test('the real command refuses a bad settings file with exit 2 and a fixed code, before any request (no key material in the environment is used)', async () => {
  const env = { ...process.env, ANTHROPIC_API_KEY: 'sk-test-not-a-real-key' };
  const attempt = (args) => run(process.execPath, [ENTRY, 'room', '--job', 'vm-a=do the thing', '--require-start-approval', ...args], { env, timeout: 30_000 }).then(
    () => ({ code: 0, stderr: '' }), (error) => ({ code: error.code, stderr: String(error.stderr) }),
  );
  const missing = await attempt(['--approval', ABS('definitely-missing.json')]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /runtime_room_approval_unreadable/);
  assert.ok(!missing.stderr.includes('definitely-missing'));
  const alone = await run(process.execPath, [ENTRY, 'room', '--job', 'vm-a=do the thing', '--require-start-approval'], { env }).then(() => ({ code: 0, stderr: '' }), (error) => ({ code: error.code, stderr: String(error.stderr) }));
  assert.equal(alone.code, 2);
  assert.match(alone.stderr, /runtime_room_start_approval_needs_settings/);
});

const scratch = mkdtempSync(path.join(os.tmpdir(), 'albera-gated-room-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
// Node's own "SQLite is an experimental feature" warning may come first; `lines` are the room's.
const attemptRoom = (args, env) => run(process.execPath, [ENTRY, 'room', ...args], { env, timeout: 30_000 }).then(
  () => ({ code: 0, stderr: '', lines: [] }), (error) => ({ code: error.code, stderr: String(error.stderr), lines: String(error.stderr).split('\n').filter((line) => line.startsWith('ALBERA')) }),
);

test('the real command refuses what the gated room cannot do through the Broker yet with exit 1 and one fixed line, before the API key or any file is looked at', async () => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // the refusal comes first: no key is needed (and none is read)
  const password = path.join(scratch, 'guest-password.txt');
  writeFileSync(password, 'not a real password\n');
  const workspace = path.join(scratch, 'albera.workspace.json');
  writeFileSync(workspace, JSON.stringify({ version: 1, name: 'checked', vms: [{ vm: 'vm-a', task: 'do the thing', checks: [{ kind: 'file_exists', path: 'C:\\x.txt' }] }] }));
  const gated = ['--require-start-approval', '--approval', path.join(scratch, 'never-read.json')];
  const cases = [
    ['--checks', ['--job', 'vm-a=do the thing', '--checks', path.join(scratch, 'checks.json'), '--guest-password-file', password, ...gated]],
    ['--guest-capture', ['--job', 'vm-a=do the thing', '--guest-capture', 'vm-a', '--guest-password-file', password, ...gated]],
    ['a workspace with checks', ['--workspace', workspace, '--guest-password-file', password, ...gated]],
  ];
  for (const [label, args] of cases) {
    const result = await attemptRoom(args, env);
    assert.equal(result.code, 1, label);
    assert.deepEqual(result.lines, [`ALBERA Runtime room: ${GATED_OUT_OF_SCOPE_LINE}`], label);
    assert.ok(!result.stderr.includes('ANTHROPIC') && !result.stderr.includes('never-read'), `${label}: nothing else was looked at`);
  }
  // without the gate the same options are not refused for this reason (the prototype path is unchanged): it gets as far as asking for the key
  const ungated = await attemptRoom(['--job', 'vm-a=do the thing', '--guest-capture', 'vm-a', '--guest-password-file', password], env);
  assert.equal(ungated.code, 1);
  assert.match(ungated.stderr, /ANTHROPIC_API_KEY/);
  assert.ok(!ungated.stderr.includes('runtime_room_gated_out_of_scope'));
});

test('the real command refuses a settings file with a task.start checkpoint attestation with the same exit 1 and line, before anything is requested or opened', async () => {
  const settingsFile = path.join(scratch, 'albera.approval.json');
  writeFileSync(settingsFile, JSON.stringify(settingsObject({
    journal: path.join(scratch, 'operations.sqlite'), desktop: { ...DESKTOP, helperPath: path.join(scratch, 'pipe-client.exe') },
    computers: { 'vm-a': 'computer-a' }, attestation: { keyFile: path.join(scratch, 'key.pem'), keyId: 'albera-broker-1', cloneRoot: scratch },
  })));
  const env = { ...process.env, ANTHROPIC_API_KEY: 'sk-test-not-a-real-key' }; // a placeholder: the command stops before it could be used
  const result = await attemptRoom(['--job', 'vm-a=do the thing', '--require-start-approval', '--approval', settingsFile], env);
  assert.equal(result.code, 1);
  assert.deepEqual(result.lines, [`ALBERA Runtime room: ${GATED_OUT_OF_SCOPE_LINE}`]);
  assert.ok(!result.stderr.includes(scratch), 'no path is printed');
});

test('the real command without the desktop settings is a settings error (exit 2), not a start', async () => {
  const settingsFile = path.join(scratch, 'no-desktop.approval.json');
  const { desktop, ...withoutDesktop } = settingsObject({ journal: path.join(scratch, 'operations.sqlite'), computers: { 'vm-a': 'computer-a' } });
  assert.ok(desktop);
  writeFileSync(settingsFile, JSON.stringify(withoutDesktop));
  const result = await attemptRoom(['--job', 'vm-a=do the thing', '--require-start-approval', '--approval', settingsFile], { ...process.env, ANTHROPIC_API_KEY: 'sk-test-not-a-real-key' });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /runtime_room_approval_desktop/);
  assert.ok(!result.stderr.includes(scratch), 'no path is printed');
});
