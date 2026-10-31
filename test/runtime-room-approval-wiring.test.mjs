import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';
import { createMemoryFlowJournal } from '../src/runtime/approved-operation-journal.mjs';
import { createTaskStartAttestation, signTaskStartAttestation } from '../src/runtime/broker-contract/task-start-attestation.mjs';
import { RUNTIME_HELP, parseRuntimeArgs } from '../src/runtime/entry.mjs';
import {
  MAX_APPROVAL_SETTINGS_BYTES, checkJobsAgainstSettings, loadApprovalSettings, openRoomApproval, parseApprovalSettings, takeRoomApprovalArgs,
} from '../src/runtime/room-approval-wiring.mjs';
import { createTestAuthority, signedReceipt, stableUuid } from '../scripts/issue-22-approval-authority-fixture.mjs';

// Wiring of the room's start gate (#115 follow-up, step A3). Everything here is injected: no pipe, no service, no database, no Hyper-V, no real key file.
// Keys are generated in memory. The clients are fakes that record what the wiring handed them, so these tests prove the BINDING (which pipe, which expectation,
// which journal, which attestation port), not the clients themselves (those have their own tests) and not a real Broker or Authority.
const ABS = (name) => path.resolve(path.sep, 'albera-test', name);
const VM_A_GUID = '11111111-2222-4333-8444-555555555555';
const SECRET_MARKER = 'TOPSECRET-do-not-print';

const settingsObject = (patch = {}) => ({
  version: 1,
  projectId: 'project-1',
  broker: { pipeName: 'ALBERA_HostBroker', expect: { serviceName: 'AlberaHostBroker' } },
  authority: { pipeRoot: 'ALBERA\\ApprovalAuthority', expect: { serviceName: 'AlberaApprovalAuthority' } },
  journal: ABS('operations.sqlite'),
  computers: { 'albera-computer-a': 'computer-a', 'vm-b': 'computer-b' },
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
  assert.deepEqual(plain.broker, { pipeName: 'ALBERA_HostBroker', expect: { serviceName: 'AlberaHostBroker' } });
  assert.deepEqual(plain.authority, { pipeRoot: 'ALBERA\\ApprovalAuthority', expect: { serviceName: 'AlberaApprovalAuthority' } });
  assert.equal(plain.attestation, null);
  assert.deepEqual([...plain.computers], [['albera-computer-a', { computerId: 'computer-a' }], ['vm-b', { computerId: 'computer-b' }]]);
  assert.ok(Object.isFrozen(plain));
  const { attestation, ...withoutKey } = settingsObject();
  assert.equal(attestation, null);
  assert.equal(parseApprovalSettings(JSON.stringify(withoutKey)).attestation, null);
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
  const swapped = { ...example, journal: ABS('operations.sqlite'), attestation: { ...example.attestation, keyFile: ABS('key.pem'), cloneRoot: ABS('clones') } };
  const parsed = parseApprovalSettings(JSON.stringify(swapped));
  assert.deepEqual([...parsed.computers.keys()], ['albera-clone-01', 'albera-clone-02']);
  assert.equal(parsed.attestation.keyId, 'albera-broker-1');
  const { attestation, ...withoutAttestation } = swapped;
  assert.ok(attestation);
  assert.equal(codeOf(() => parseApprovalSettings(JSON.stringify(withoutAttestation))), 'runtime_room_approval_computers', 'the example\'s vmId needs the attestation block');
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

/** Fakes for everything outside the process. `world` records what the wiring handed them. */
function makeWorld({ approval = 'approve', attest = null, storeFails = false, prototypeNull = false } = {}) {
  const authority = createTestAuthority();
  const brokerKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const world = {
    clock: 1_800_000_000_000, calls: [], stores: [], closed: 0, prototypes: [], keysRead: [], fields: new Map(), claims: [], submissions: [], opened: [], asked: [], journal: createMemoryFlowJournal(),
  };
  const seconds = () => Math.floor(world.clock / 1000);
  world.deps = {
    async sendBrokerFence(options) {
      world.calls.push(['fence', options]);
      return { ok: true, brokerEpoch: 1, leaseGeneration: 7, leaseId: 'lease-1', brokerChallenge: randomBytes(16).toString('base64url') };
    },
    async sendBrokerRequest(options) { world.calls.push(['claim', options]); world.claims.push(options); return { ok: true, state: 'UNKNOWN', action: options.action?.action }; },
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
    createPrototype(options) {
      world.prototypes.push(options);
      return {
        async attestTaskStart(ask) {
          world.asked.push(ask);
          if (prototypeNull) return null;
          return signTaskStartAttestation(createTaskStartAttestation({
            network: 'none', ...ask, checkpointId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', checkpointType: 'production', observedAt: seconds(),
          }), options.attestationSigner);
        },
      };
    },
    createKey: (pem) => { world.keysRead.push(pem); if (pem.includes('NOT A KEY')) throw new Error(SECRET_MARKER); return brokerKey.privateKey; },
    newOperationId: (() => { let n = 0; return () => `room-start-${(n += 1)}`; })(),
    now: () => world.clock,
    sleep: async (ms) => { world.clock += ms; },
  };
  world.attest = attest;
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

test('no attestation: the gate asks a person for exactly { task }; the real clients are bound to the configured pipes and expectations; the flow writes to the durable journal', async () => {
  const world = makeWorld();
  const approval = await open(world);
  assert.deepEqual(world.opened, [ABS('operations.sqlite')]);
  assert.equal(approval.attested, false);
  assert.equal(world.prototypes.length, 0, 'no prototype is built without "attestation"');
  assert.match(approval.notice, /Hands start only after approval/);
  assert.doesNotMatch(approval.notice, /checkpoint/);
  assert.deepEqual(await approval.gate.startApproved({ vmId: 'albera-computer-a', task: 'open notepad and write hello' }), { ok: true });
  const [fence, submit, status, claim] = world.calls;
  const broker = { pipeName: 'ALBERA_HostBroker', expect: { serviceName: 'AlberaHostBroker' } };
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
  assert.ok(world.closed >= 1, 'close() closes the store (and tolerates a second call)');
});

test('each start is a fresh operation with its own computer', async () => {
  const world = makeWorld();
  const approval = await open(world);
  assert.deepEqual(await approval.gate.startApproved({ vmId: 'albera-computer-a', task: 'one' }), { ok: true });
  assert.deepEqual(await approval.gate.startApproved({ vmId: 'vm-b', task: 'two' }), { ok: true });
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
  assert.deepEqual([world.opened, world.calls, world.prototypes], [[], [], []]);
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

// ---- attestation ----

const KEY_FILE = ABS('broker-attestation.pem');
const attestedPatch = (extra = {}) => ({
  attestation: attestationObject(),
  computers: { 'albera-computer-a': { computerId: 'computer-a', vmId: VM_A_GUID, expectedGeneration: 3 }, 'vm-b': 'computer-b', ...extra },
});
const attestedFiles = (patch = attestedPatch()) => ({ [SETTINGS_FILE]: text(patch), [KEY_FILE]: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n' });

test('attestation configured: the Hyper-V prototype gets the signer and clone root, its attestTaskStart is the flow\'s port, and the statement goes to the Authority unchanged', async () => {
  const world = makeWorld();
  const approval = await open(world, { files: attestedFiles() });
  assert.equal(approval.attested, true);
  assert.match(approval.notice, /Broker checkpoint may let the policy approve/);
  assert.deepEqual(world.keysRead, ['-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n']);
  assert.equal(world.prototypes.length, 1);
  const [options] = world.prototypes;
  assert.deepEqual(Object.keys(options).sort(), ['attestationSigner', 'cloneRoot', 'goldenImages']);
  assert.equal(options.cloneRoot, ABS('clones'));
  assert.deepEqual(options.goldenImages, {});
  assert.equal(options.attestationSigner.keyId, 'albera-broker-1');
  assert.equal(typeof options.attestationSigner.sign, 'function');

  assert.deepEqual(await approval.gate.startApproved({ vmId: 'albera-computer-a', task: 'open notepad' }), { ok: true });
  assert.deepEqual(world.calls.map(([name]) => name), ['fence', 'submit', 'status', 'claim'], 'the prototype is asked inside the flow, between fence and submit');
  assert.equal(world.asked.length, 1);
  const submit = world.submissions[0];
  assert.deepEqual(world.asked[0], {
    computerId: 'computer-a', projectId: 'project-1', leaseId: 'lease-1', leaseGeneration: 7, generation: 3, vmId: VM_A_GUID, operationId: 'room-start-1',
    actionDigest: computeActionDigest('guest.command', submit.action), // #133: the attestation is bound to the action the Authority signs
  });
  assert.deepEqual(submit.action.args, { task: 'open notepad', vmId: VM_A_GUID, expectedGeneration: 3 });
  assert.equal(submit.attestation.attestation.operationId, 'room-start-1');
  assert.equal(submit.attestation.attestation.checkpointType, 'production');
  assert.equal(world.journal.get('room-start-1').approval.attestationDigest, submit.attestation.digest);
});

test('attestation configured but this VM names no Hyper-V VM: a person is asked, with { task } alone, and the prototype is never asked', async () => {
  const world = makeWorld();
  const approval = await open(world, { files: attestedFiles() });
  assert.deepEqual(await approval.gate.startApproved({ vmId: 'vm-b', task: 'rename the report' }), { ok: true });
  assert.deepEqual(world.asked, []);
  assert.equal(world.submissions[0].attestation, undefined);
  assert.deepEqual(world.submissions[0].action.args, { task: 'rename the report' });
});

test('attestation configured but the prototype gives none (returns null): the submit goes without it and a person is asked', async () => {
  const world = makeWorld({ prototypeNull: true });
  const approval = await open(world, { files: attestedFiles() });
  assert.deepEqual(await approval.gate.startApproved({ vmId: 'albera-computer-a', task: 'open notepad' }), { ok: true });
  assert.equal(world.asked.length, 1);
  assert.equal(world.submissions[0].attestation, undefined);
  assert.deepEqual(world.submissions[0].action.args, { task: 'open notepad', vmId: VM_A_GUID, expectedGeneration: 3 }, 'the person sees which VM is meant');
});

test('attestation key problems are a fixed code before the store is opened: unreadable file, too big, not a key, not an EC P-256 key', async () => {
  const cases = [
    ['no key file', { [SETTINGS_FILE]: text(attestedPatch()) }],
    ['key file too big', { ...attestedFiles(), [KEY_FILE]: 'x'.repeat(5000) }],
    ['not a key', { ...attestedFiles(), [KEY_FILE]: 'NOT A KEY' }],
  ];
  for (const [label, files] of cases) {
    const world = makeWorld();
    const error = await open(world, { files }).catch((e) => e);
    assert.equal(error.message, 'runtime_room_approval_attestation_unavailable', label);
    assert.ok(!error.message.includes(SECRET_MARKER));
    assert.deepEqual([world.opened, world.prototypes, world.calls], [[], [], []], label);
  }
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const world = makeWorld();
  world.deps.createKey = () => rsa;
  await assert.rejects(open(world, { files: attestedFiles() }), { message: 'runtime_room_approval_attestation_unavailable' });
  assert.deepEqual(world.opened, [], 'an RSA key is refused by the signer before anything is opened');
});

test('the real default key reader accepts a PKCS#8 PEM P-256 key made in memory (nothing read from disk)', async () => {
  const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const world = makeWorld();
  delete world.deps.createKey; // the wiring's own reader
  const approval = await open(world, { files: { ...attestedFiles(), [KEY_FILE]: pem } });
  assert.equal(approval.attested, true);
  assert.equal(world.prototypes[0].attestationSigner.keyId, 'albera-broker-1');
  assert.match(world.prototypes[0].attestationSigner.publicKeySpki, /^[A-Za-z0-9+/]+=*$/);
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
