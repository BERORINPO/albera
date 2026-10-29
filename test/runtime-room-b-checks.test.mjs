import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRoomHost } from '../src/runtime/room-host.mjs';
import { createAgentStatusBoard } from '../src/runtime/agent-status-board.mjs';
import { createMockDesktopBroker } from '../src/runtime/mock-desktop-broker.mjs';
import { HyperVDesktopDriver } from '../src/runtime/hyperv-desktop-driver.mjs';
import { checkReport, createFakeGuestChecker, unavailable } from '../src/runtime/fake-guest-checker.mjs';
import { createHyperVGuestChecker, GUEST_CHECK_PWSH_ARGS, GUEST_CHECK_TIMEOUT_MS } from '../src/runtime/hyperv-guest-check-prototype.mjs';
import { cleanParams, validCheck, validCheckReport, validEvent } from '../src/runtime/room-contract.mjs';
import { loadRoomChecks, parseRuntimeArgs, RUNTIME_HELP } from '../src/runtime/entry.mjs';
import { DEMO_CHECKS, startRoomDemo } from '../src/runtime/room-demo.mjs';

const SECRET = 'S3cret-Guest-Pa55word!';
const screen = Object.freeze({ width: 64, height: 48 });
const FILE_A = 'C:\\Users\\Administrator\\Desktop\\room1.txt';
const CHECKS_A = Object.freeze([
  { kind: 'file_exists', path: FILE_A },
  { kind: 'file_text', path: FILE_A, text: 'control room clone 01' },
]);
const VMS = [{ vmId: 'vm-a', label: 'Alpha', task: 'write the file' }, { vmId: 'vm-b', label: 'Beta' }];
const DONE = Object.freeze({ type: 'end', outcome: 'claimed_done', claim: 'DONE: wrote it', steps: 3, usd: 0.01 });

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'albera-checks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function passwordFile(t, text = `${SECRET}\r\n`) {
  const file = path.join(tempDir(t), 'admin-password.txt');
  writeFileSync(file, text);
  return file;
}

/** In-memory pwsh: records every call and answers with `reply(request)` (an object is printed as one JSON line). */
function fakePowerShell(reply) {
  const calls = [];
  const run = async (request) => {
    calls.push(request);
    const out = await reply(JSON.parse(request.input), request);
    if (out && typeof out === 'object' && 'stdout' in out) return out;
    return { stdout: `${JSON.stringify(out)}\r\n` };
  };
  return { calls, run };
}

function fakeJournal(now) {
  const entries = [];
  const add = (vmId, actor, code, params) => {
    const entry = Object.freeze({ seq: entries.length + 1, at: now(), vmId, actor, code, params: cleanParams(params) });
    entries.push(entry);
    return entry;
  };
  return {
    entries,
    record: ({ vmId, actor, code, params }) => add(vmId, actor, code, params),
    recordFleetEvent: (vmId, ev) => {
      if (ev.type === 'step') return add(vmId, 'hands', 'hands_step', { step: ev.step, usd: ev.usd, action: '', note: ev.note ?? '' });
      if (ev.type === 'end') return add(vmId, 'hands', 'hands_ended', { outcome: ev.outcome, claim: ev.claim, steps: ev.steps, usd: ev.usd });
      return null;
    },
    since: (seq) => entries.filter((e) => e.seq > seq),
    all: () => [...entries],
    lastSeq: () => entries.length,
  };
}

const quietDirector = () => ({ tick: () => ({ acts: [], ledger: [] }), decide: () => ({ ok: false, code: 'card_unknown' }) });
const quietFleet = () => ({ startJob: () => ({ ok: true }), stopVm: () => false, async idle() {} });

function makeHost({ checker, checks = { 'vm-a': CHECKS_A }, checkTimeoutMs } = {}) {
  const now = () => Date.parse('2026-10-29T12:00:00.000Z');
  const journal = fakeJournal(now);
  const broker = createMockDesktopBroker(screen);
  const host = createRoomHost({
    vms: VMS, board: createAgentStatusBoard({ now }), journal, director: quietDirector(), fleet: quietFleet(), now,
    checker, checks, ...(checkTimeoutMs ? { checkTimeoutMs } : {}), captureIntervalMs: 60_000, tickMs: 60_000,
    driver: (resolveCurrentLease) => new HyperVDesktopDriver({ broker, resolveCurrentLease, now, screen }),
  });
  return { host, journal };
}

const codes = (journal) => journal.entries.map((e) => `${e.vmId}:${e.code}`);
const checkDone = (journal) => journal.entries.filter((e) => e.code === 'check_done').map((e) => e.params);

// ---- fake checker and the shared report builder ----

test('checkReport: passed only when every finding is ok; missing / differs fail; an error alone is unavailable', () => {
  assert.equal(checkReport(CHECKS_A, ['ok', 'ok']).verdict, 'passed');
  assert.deepEqual(checkReport(CHECKS_A, ['ok', 'differs']).results.map((r) => r.finding), ['ok', 'differs']);
  assert.equal(checkReport(CHECKS_A, ['missing', 'error']).verdict, 'failed');
  assert.deepEqual([checkReport(CHECKS_A, ['ok', 'error']).verdict, checkReport(CHECKS_A, ['ok', 'error']).code], ['unavailable', 'guest_check_error']);
  for (const findings of [['ok'], ['ok', 'yes'], 'ok,ok', null]) assert.deepEqual(checkReport(CHECKS_A, findings), unavailable('guest_check_invalid'));
  // paths in a report always come from the checks given
  assert.deepEqual(checkReport(CHECKS_A, ['ok', 'ok']).results.map((r) => r.path), [FILE_A, FILE_A]);
  for (const findings of [['ok', 'ok'], ['missing', 'ok'], ['ok', 'error']]) assert.ok(validCheckReport(checkReport(CHECKS_A, findings), 2));
});

test('fake checker: reports in order (the last repeats), unknown VMs and bad checks are unavailable', async () => {
  const checker = createFakeGuestChecker({ 'vm-a': [['missing', 'ok'], ['ok', 'ok']] });
  assert.equal((await checker.run('vm-a', CHECKS_A)).verdict, 'failed');
  assert.equal((await checker.run('vm-a', CHECKS_A)).verdict, 'passed');
  assert.equal((await checker.run('vm-a', CHECKS_A)).verdict, 'passed');
  assert.deepEqual(await checker.run('vm-b', CHECKS_A), unavailable('guest_unavailable'));
  assert.deepEqual(await checker.run('vm-a', [{ kind: 'file_exists', path: 'relative.txt' }]), unavailable('guest_check_invalid'));
  assert.deepEqual(await checker.run('bad name', CHECKS_A), unavailable('guest_check_invalid'));
  const lying = createFakeGuestChecker({ 'vm-a': [{ verdict: 'passed', results: [] }] });
  assert.deepEqual(await lying.run('vm-a', CHECKS_A), unavailable('guest_check_invalid'));
  assert.equal(checker.calls.length, 6);
});

// ---- Hyper-V prototype with an in-memory pwsh ----

test('hyperv checker: fixed argv without the password, the request (with the password) only on stdin', async (t) => {
  const pwsh = fakePowerShell(() => ({ ok: true, findings: ['ok', 'ok'] }));
  const checker = createHyperVGuestChecker({ passwordFile: passwordFile(t), runPowerShell: pwsh.run });
  const report = await checker.run('albera-clone-01', CHECKS_A);
  assert.equal(report.verdict, 'passed');
  assert.ok(validCheckReport(report, 2));
  const [call] = pwsh.calls;
  assert.equal(call.command, 'pwsh');
  assert.deepEqual(call.args, GUEST_CHECK_PWSH_ARGS);
  assert.deepEqual(call.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-File']);
  assert.match(call.args[3], /hyperv-guest[\\/]check-io\.ps1$/);
  assert.ok(!call.args.join(' ').includes(SECRET), 'argv never holds the password');
  assert.equal(call.timeoutMs, GUEST_CHECK_TIMEOUT_MS);
  assert.equal(GUEST_CHECK_TIMEOUT_MS, 60_000);
  assert.deepEqual(JSON.parse(call.input), { vmName: 'albera-clone-01', user: 'Administrator', password: SECRET, checks: CHECKS_A });
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('hyperv checker: the password is read at each run (BOM and line break removed)', async (t) => {
  const file = passwordFile(t, `\uFEFFfirst\n`);
  const pwsh = fakePowerShell(() => ({ ok: true, findings: ['ok', 'ok'] }));
  const checker = createHyperVGuestChecker({ passwordFile: file, runPowerShell: pwsh.run });
  await checker.run('vm-a', CHECKS_A);
  writeFileSync(file, 'second');
  await checker.run('vm-a', CHECKS_A);
  assert.deepEqual(pwsh.calls.map((c) => JSON.parse(c.input).password), ['first', 'second']);
});

test('hyperv checker: failures are unavailable with a fixed code, never the VM\'s text', async (t) => {
  const file = passwordFile(t);
  const run = async (reply, checks = CHECKS_A, options = {}) => {
    const pwsh = fakePowerShell(reply);
    const report = await createHyperVGuestChecker({ passwordFile: file, runPowerShell: pwsh.run, ...options }).run('vm-a', checks);
    assert.ok(validCheckReport(report, checks.length), JSON.stringify(report));
    assert.ok(!JSON.stringify(report).includes(SECRET));
    return { report, calls: pwsh.calls };
  };
  for (const code of ['guest_vm_not_found', 'guest_vm_not_running', 'guest_auth_failed', 'guest_unavailable', 'guest_check_invalid']) {
    assert.deepEqual((await run(() => ({ ok: false, code }))).report, unavailable(code));
  }
  assert.deepEqual((await run(() => ({ ok: false, code: `wrong password ${SECRET}` }))).report, unavailable('guest_unavailable'));
  assert.deepEqual((await run(() => ({ stdout: `Exception: logon failed for ${SECRET}` }))).report, unavailable('guest_unavailable'));
  assert.deepEqual((await run(() => ({ stdout: '', timedOut: true }))).report, unavailable('guest_check_timeout'));
  assert.deepEqual((await run(() => { throw new Error(SECRET); })).report, unavailable('guest_unavailable'));
  assert.deepEqual((await run(() => ({ ok: true, findings: ['ok'] }))).report, unavailable('guest_check_invalid'));
  assert.deepEqual((await run(() => ({ ok: true, findings: ['ok', SECRET] }))).report, unavailable('guest_check_invalid'));
  // a VM cannot put its own paths into the report: results are built from the checks the host sent
  const { report } = await run(() => ({ ok: true, findings: ['ok', 'differs'], results: [{ path: 'C:\\evil' }] }));
  assert.deepEqual(report.results.map((r) => r.path), [FILE_A, FILE_A]);
  // bad checks and a bad VM name never start pwsh
  const bad = await run(() => ({ ok: true, findings: ['ok'] }), [{ kind: 'file_exists', path: 'C:\\a\\..\\b' }]);
  assert.deepEqual([bad.report, bad.calls.length], [unavailable('guest_check_invalid'), 0]);
});

test('hyperv checker: a missing, empty or huge password file never starts pwsh', async (t) => {
  const dir = tempDir(t);
  for (const [name, text] of [['missing.txt', null], ['empty.txt', '\r\n'], ['huge.txt', 'x'.repeat(2000)], ['two-lines.txt', 'a\nb']]) {
    const file = path.join(dir, name);
    if (text !== null) writeFileSync(file, text);
    const pwsh = fakePowerShell(() => ({ ok: true, findings: ['ok', 'ok'] }));
    const report = await createHyperVGuestChecker({ passwordFile: file, runPowerShell: pwsh.run }).run('vm-a', CHECKS_A);
    assert.deepEqual([report, pwsh.calls.length], [unavailable('guest_password_unreadable'), 0], name);
  }
  assert.throws(() => createHyperVGuestChecker({}), /guest_password_file_required/);
  assert.throws(() => createHyperVGuestChecker({ passwordFile: 'x', user: 'a b; rm' }), /invalid_guest_check_user/);
});

// ---- host ----

test('host: a DONE claim records check_started before hands_ended, then check_done with the verdict', async () => {
  const { host, journal } = makeHost({ checker: createFakeGuestChecker({ 'vm-a': [['ok', 'ok']] }) });
  host.recordFleetEvent('vm-a', DONE);
  assert.deepEqual(codes(journal), ['vm-a:check_started', 'vm-a:hands_ended']);
  assert.deepEqual(journal.entries[0].params, { count: 2 });
  assert.equal(journal.entries[0].actor, 'bero');
  await host.checksSettled();
  assert.deepEqual(codes(journal), ['vm-a:check_started', 'vm-a:hands_ended', 'vm-a:check_done']);
  assert.deepEqual(checkDone(journal), [{ verdict: 'passed', checks: 2, failed: 0, detail: '' }]);
  assert.equal(journal.entries[2].actor, 'bero');
  await host.close();
});

test('host: other outcomes and VMs without checks change nothing', async () => {
  const checker = createFakeGuestChecker({ 'vm-a': [['ok', 'ok']], 'vm-b': [['ok']] });
  const { host, journal } = makeHost({ checker });
  host.recordFleetEvent('vm-b', DONE);
  host.recordFleetEvent('vm-a', { ...DONE, outcome: 'claimed_failed' });
  host.recordFleetEvent('vm-a', { ...DONE, outcome: 'limit_reached' });
  await host.checksSettled();
  assert.deepEqual(codes(journal), ['vm-b:hands_ended', 'vm-a:hands_ended', 'vm-a:hands_ended']);
  assert.equal(checker.calls.length, 0);
  await host.close();
  const plain = makeHost({ checker: undefined, checks: {} });
  plain.host.recordFleetEvent('vm-a', DONE);
  assert.deepEqual(codes(plain.journal), ['vm-a:hands_ended']);
  await plain.host.close();
});

test('host: failed and unavailable checks record the first problem; a recheck DONE is checked again', async () => {
  const checker = createFakeGuestChecker({ 'vm-a': [['ok', 'differs'], ['missing', 'missing'], ['ok', 'ok']] });
  const { host, journal } = makeHost({ checker });
  for (let i = 0; i < 3; i++) { host.recordFleetEvent('vm-a', DONE); await host.checksSettled(); }
  assert.deepEqual(checkDone(journal), [
    { verdict: 'failed', checks: 2, failed: 1, detail: `${FILE_A}: differs` },
    { verdict: 'failed', checks: 2, failed: 2, detail: `${FILE_A}: missing` },
    { verdict: 'passed', checks: 2, failed: 0, detail: '' },
  ]);
  await host.close();

  const cases = [
    [{ run: async () => { throw new Error(SECRET); } }, 'guest_check_failed'],
    [{ run: async () => ({ verdict: 'passed', results: [] }) }, 'guest_check_invalid'],
    [{ run: async () => unavailable('guest_auth_failed') }, 'guest_auth_failed'],
    [{ run: () => new Promise(() => {}) }, 'guest_check_timeout'],
  ];
  for (const [bad, code] of cases) {
    const made = makeHost({ checker: bad, checkTimeoutMs: 20 });
    made.host.recordFleetEvent('vm-a', DONE);
    await made.host.checksSettled();
    assert.deepEqual(checkDone(made.journal), [{ verdict: 'unavailable', checks: 2, failed: 0, detail: code }], code);
    assert.ok(!JSON.stringify(made.journal.entries).includes(SECRET));
    await made.host.close();
  }
});

test('host: checks of one VM run one at a time, in order', async () => {
  let active = 0;
  let most = 0;
  const order = [];
  const checker = {
    async run(vmId) {
      active++; most = Math.max(most, active);
      order.push(vmId);
      await new Promise((resolve) => { setTimeout(resolve, 15); });
      active--;
      return checkReport(CHECKS_A, order.length === 1 ? ['missing', 'ok'] : ['ok', 'ok']);
    },
  };
  const { host, journal } = makeHost({ checker });
  host.recordFleetEvent('vm-a', DONE);
  host.recordFleetEvent('vm-a', DONE);
  await host.checksSettled();
  assert.equal(most, 1);
  assert.deepEqual(checkDone(journal).map((p) => p.verdict), ['failed', 'passed']);
  await host.close();
});

test('host: bad checks are refused at start; a check finishing after close records nothing', async () => {
  const fake = createFakeGuestChecker({});
  const bad = (checks, checker = fake) => assert.throws(() => makeHost({ checker, checks }), TypeError, JSON.stringify(checks));
  bad({ 'vm-x': CHECKS_A });
  bad({ 'vm-a': [] });
  bad({ 'vm-a': Array.from({ length: 9 }, () => CHECKS_A[0]) });
  bad({ 'vm-a': [{ kind: 'file_exists', path: 'C:\\a', extra: 1 }] });
  bad({ 'vm-a': [{ kind: 'run_script', path: 'C:\\a' }] });
  bad([CHECKS_A]);
  bad({ 'vm-a': CHECKS_A }, null);
  let release;
  const slow = { run: () => new Promise((resolve) => { release = () => resolve(checkReport(CHECKS_A, ['ok', 'ok'])); }) };
  const { host, journal } = makeHost({ checker: slow });
  host.recordFleetEvent('vm-a', DONE);
  await new Promise((resolve) => { setImmediate(resolve); });
  await host.close();
  release();
  await host.checksSettled();
  assert.deepEqual(codes(journal), ['vm-a:check_started', 'vm-a:hands_ended']);
});

test('host: with the Hyper-V checker the password never reaches the ledger, events or state', async (t) => {
  const file = passwordFile(t);
  const replies = [{ ok: true, findings: ['ok', 'differs'] }, { ok: false, code: SECRET }, { stdout: `error: ${SECRET}` }];
  const pwsh = fakePowerShell(() => replies.shift());
  const checker = createHyperVGuestChecker({ passwordFile: file, runPowerShell: pwsh.run });
  const { host, journal } = makeHost({ checker });
  const address = await host.listen(0);
  for (let i = 0; i < 3; i++) { host.recordFleetEvent('vm-a', DONE); await host.checksSettled(); }
  host.tickOnce();
  const origin = new URL(address.url).origin;
  const session = await fetch(`${address.url}api/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrapCode: address.bootstrapCode }) });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const state = await (await fetch(`${address.url}api/state?since=0`, { headers: { Cookie: cookie } })).json();
  assert.ok(state.events.every(validEvent));
  assert.deepEqual(state.events.filter((ev) => ev.entry?.code === 'check_done').map((ev) => ev.entry.params.verdict), ['failed', 'unavailable', 'unavailable']);
  for (const text of [JSON.stringify(state), JSON.stringify(journal.entries)]) assert.ok(!text.includes(SECRET));
  assert.ok(pwsh.calls.every((c) => !c.args.join(' ').includes(SECRET) && !c.command.includes(SECRET)));
  await host.close();
});

// ---- CLI ----

test('room args: --checks and --guest-password-file go together and are kept as paths only', () => {
  const o = parseRuntimeArgs(['room', '--job', 'vm-a=t', '--checks', 'c.json', '--guest-password-file', 'pw.txt']);
  assert.deepEqual([o.command, o.demo, o.checksFile, o.guestPasswordFile, o.jobs.length], ['room', false, 'c.json', 'pw.txt', 1]);
  const plain = parseRuntimeArgs(['room', '--job', 'vm-a=t']);
  assert.deepEqual([plain.checksFile, plain.guestPasswordFile], [null, null]);
  const bad = (args, re) => assert.throws(() => parseRuntimeArgs(['room', ...args]), re, args.join(' '));
  bad(['--job', 'vm-a=t', '--checks', 'c.json'], /runtime_room_checks_need_both_files/);
  bad(['--job', 'vm-a=t', '--guest-password-file', 'pw.txt'], /runtime_room_checks_need_both_files/);
  bad(['--job', 'vm-a=t', '--checks', 'a', '--checks', 'b', '--guest-password-file', 'p'], /runtime_option_must_be_unique/);
  bad(['--job', 'vm-a=t', '--checks', '--guest-password-file', 'p'], /runtime_option_requires_value/);
  bad(['--demo', '--checks', 'c.json', '--guest-password-file', 'p'], /invalid_runtime_option/);
  assert.throws(() => parseRuntimeArgs(['fleet', '--job', 'vm-a=t', '--checks', 'c.json']), /invalid_runtime_option/);
  assert.ok(RUNTIME_HELP.includes('--checks <checks.json> --guest-password-file <file>'));
  assert.deepEqual(parseRuntimeArgs(['room', '--demo']), { command: 'room', demo: true, jobs: [], port: 0, help: false });
});

test('loadRoomChecks: validates the file and refuses unknown VMs, too many or bad checks and a missing password file', (t) => {
  const dir = tempDir(t);
  const pw = passwordFile(t);
  const write = (name, value) => { const file = path.join(dir, name); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const load = (value, { vmIds = ['albera-clone-01', 'vm-b'], guestPasswordFile = pw } = {}) => loadRoomChecks({ checksFile: write('c.json', value), guestPasswordFile, vmIds });
  const good = { 'albera-clone-01': [{ kind: 'file_text', path: 'C:\\Users\\Administrator\\Desktop\\room1.txt', text: 'control room clone 01' }] };
  assert.deepEqual(load(good), good);
  assert.deepEqual(load(`\uFEFF${JSON.stringify(good)}`), good);
  const fails = [
    [{ 'vm-x': good['albera-clone-01'] }, /runtime_room_checks_unknown_vm/],
    [{ 'vm-b': Array.from({ length: 9 }, () => ({ kind: 'file_exists', path: 'C:\\a' })) }, /runtime_room_checks_too_many/],
    [{ 'vm-b': [{ kind: 'file_exists', path: '\\\\server\\share\\a' }] }, /runtime_room_check_invalid/],
    [{ 'vm-b': [{ kind: 'file_exists', path: 'C:\\a', command: 'del' }] }, /runtime_room_check_invalid/],
    [{ 'vm-b': [{ kind: 'dir_has', path: 'C:\\a', name: '..' }] }, /runtime_room_check_invalid/],
    [{ 'vm-b': [] }, /runtime_room_checks_invalid/],
    [{}, /runtime_room_checks_invalid/],
    [[good], /runtime_room_checks_invalid/],
    ['not json', /runtime_room_checks_unreadable/],
    ['x'.repeat(70 * 1024), /runtime_room_checks_unreadable/],
  ];
  for (const [value, re] of fails) assert.throws(() => load(value), re, JSON.stringify(value).slice(0, 80));
  assert.throws(() => load(good, { guestPasswordFile: path.join(dir, 'nope.txt') }), /runtime_room_password_file_missing/);
  assert.throws(() => load(good, { guestPasswordFile: dir }), /runtime_room_password_file_missing/);
  assert.throws(() => loadRoomChecks({ checksFile: path.join(dir, 'none.json'), guestPasswordFile: pw, vmIds: ['vm-b'] }), /runtime_room_checks_unreadable/);
  try { load(good, { guestPasswordFile: path.join(dir, 'nope.txt') }); } catch (error) { assert.ok(!error.message.includes(dir)); }
});

// ---- demo ----

test('demo: the booking form\'s DONE is checked and passes; Tests fails first, then passes', async (t) => {
  for (const list of Object.values(DEMO_CHECKS)) assert.ok(list.every(validCheck));
  const journals = [];
  const modules = {
    journalModule: { createRoomJournal: ({ now }) => { const j = fakeJournal(now); journals.push(j); return j; } },
    figuresModule: { buildFigure: () => null },
    directorModule: { createBeroDirector: () => quietDirector() },
  };
  const demo = await startRoomDemo({ modules, delayMs: 5 });
  t.after(() => demo.close());
  for (let i = 0; i < 400 && demo.fleet.isBusy('demo-form'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await demo.host.checksSettled();
  const form = journals[0].entries.filter((e) => e.vmId === 'demo-form').map((e) => e.code);
  assert.deepEqual(form.slice(-3), ['check_started', 'hands_ended', 'check_done']);
  assert.equal(journals[0].entries.find((e) => e.code === 'check_done').params.verdict, 'passed');
  assert.equal((await demo.checker.run('demo-tests', DEMO_CHECKS['demo-tests'])).verdict, 'failed');
  assert.equal((await demo.checker.run('demo-tests', DEMO_CHECKS['demo-tests'])).verdict, 'passed');
});
