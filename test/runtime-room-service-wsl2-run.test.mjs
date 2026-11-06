import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it, test } from 'node:test';
import { createGitQuarantine } from '../src/runtime/git-quarantine.mjs';
import { collectWsl2Result, createWsl2Readiness, createWsl2ToolGuard, driverTimeLeftMs, wsl2Refusal, headOfBundle, KEPT_RESULTS, markUnsafeText, MAX_RESULT_BYTES, READY_REFRESH_MS, RESULT_DEADLINE_MS, runWsl2Job, wsl2TargetLookup } from '../src/runtime/room-service-wsl2-run.mjs';
import { SHELL_HANDS } from '../src/runtime/albera-shell-mcp-server.mjs';

// One WSL2 job around the driver, with a fake bridge client and a fake driver. The result path uses REAL git and the real quarantine in temporary folders. No WSL, no token.
const gitPath = path.resolve(execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/u).find((l) => l.trim()).trim());
const work = mkdtempSync(path.join(tmpdir(), 'albera-wsl2-run-'));
const guest = path.join(work, 'guest');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(work, 'none.gitconfig'), GIT_AUTHOR_NAME: 'g', GIT_AUTHOR_EMAIL: 'g@x.invalid', GIT_COMMITTER_NAME: 'g', GIT_COMMITTER_EMAIL: 'g@x.invalid' };
const g = (...args) => execFileSync('git', ['-C', guest, ...args], { env });
const text = (...args) => g(...args).toString('utf8').trim();
const file = (rel, content) => writeFileSync(path.join(guest, rel), content);
const commit = (message) => { g('add', '-A'); g('commit', '-q', '-m', message); return text('rev-parse', 'HEAD'); };
const bundleAll = () => g('bundle', 'create', '-q', '-', '--all');
const OP = 'op-1';
let base;
let changed;
let unchangedBundle;
let changedBundle;
let n = 0;

before(() => {
  writeFileSync(path.join(work, 'none.gitconfig'), '');
  execFileSync('git', ['init', '-q', '-b', 'main', guest], { env });
  file('a.txt', 'one\n');
  base = commit('base');
  unchangedBundle = bundleAll();
  file('a.txt', 'one\ntwo <script>alert(1)</script>\n');
  changed = commit('change');
  changedBundle = bundleAll();
});
after(() => rmSync(work, { recursive: true, force: true }));

function folders() {
  n += 1;
  const runDir = path.join(work, `run-${n}`);
  mkdirSync(runDir);
  return { runDir, resultsRoot: path.join(work, `results-${n}`), quarantine: createGitQuarantine({ git: gitPath, root: path.join(work, `q-${n}`) }) };
}
const bridgeError = (code, outcome = 'refused') => Object.assign(new Error(code), { code, outcome });

function fakeClient(overrides = {}) {
  const calls = [];
  const verb = (name, value) => async (...args) => { calls.push(name); if (overrides[name]) return overrides[name](...args); return value; };
  return { calls, begin: verb('begin'), bundle: verb('bundle', changedBundle), end: verb('end'), stop: verb('stop') };
}
function job({ client = fakeClient(), lease = 'lease', driver = async () => ({ outcome: 'claimed_done', reason: 'done', claim: 'DONE', toolCalls: 1 }), run = { stopRequested: false }, guard = { check: async () => true } } = {}) {
  const { runDir, resultsRoot, quarantine } = folders();
  const notes = [];
  const driverCalls = [];
  const done = runWsl2Job({
    wsl2: { client, guard, quarantine, resultsRoot, shell: { command: 'C:\\node.exe', entryPath: 'C:\\shell.mjs', bridge: { pipeName: 'p', serverSid: 'S-1-5-21-1-2-3-1001', helperPath: 'C:\\helper.exe', helperSha256: 'a'.repeat(64) } } },
    job: { operationId: OP, computerId: 'pc-1', repositoryId: 'repo-1', baseOid: base, lease }, run, runDir, note: (line) => notes.push(line),
    runDriver: async (choice) => { driverCalls.push(choice); return driver(choice, runDir); },
  });
  return { client, done, notes, driverCalls, resultsRoot };
}

test('headOfBundle reads HEAD from the header and nothing else counts', () => {
  assert.equal(headOfBundle(changedBundle), changed);
  assert.equal(headOfBundle(Buffer.from('not a bundle')), null);
  assert.equal(headOfBundle(Buffer.from(`# v2 git bundle\n${'a'.repeat(40)} refs/heads/main\n\nPACK`)), null, 'no HEAD line');
  assert.equal(headOfBundle(Buffer.from(`# v9 git bundle\n${'a'.repeat(40)} HEAD\n\nPACK`)), null, 'an unknown version');
});

describe('the run around the driver', () => {
  it('the order is begin, the driver, bundle, end, and the driver gets the shell hands and no lease', async () => {
    const t = job();
    const { result, collected } = await t.done;
    assert.equal(result.outcome, 'claimed_done');
    assert.deepEqual(t.client.calls, ['begin', 'bundle', 'end']);
    assert.equal(t.driverCalls[0].hands, SHELL_HANDS);
    assert.ok(!t.driverCalls[0].mcpServer.args.includes('lease'));
    assert.ok(t.driverCalls[0].mcpServer.args.includes('--halt-file'));
    assert.equal(collected.ok, true);
    assert.equal(collected.trust, 'agent_reported');
    assert.equal(collected.resultOid, changed);
    assert.deepEqual(collected.files.map((f) => [f.status, f.path]), [['M', 'a.txt']]);
    assert.match(collected.diff, /\+two <script>alert\(1\)<\/script>/u, 'kept as text: the page escapes it');
    assert.ok(existsSync(path.join(t.resultsRoot, `${OP}.bundle`)));
  });

  it('a refused begin ends it with a fixed word, without stop; an unknown answer stops, because a run may exist', async () => {
    const refused = job({ client: fakeClient({ begin: async () => { throw bridgeError('base_moved'); } }) });
    assert.equal((await refused.done).result.reason, 'wsl2_begin_failed');
    assert.deepEqual(refused.client.calls, ['begin']);
    assert.ok(refused.notes.includes('hands wsl2_begin_refused base_moved'));
    const unknown = job({ client: fakeClient({ begin: async () => { throw bridgeError('reply_timeout', 'unknown'); } }) });
    assert.equal((await unknown.done).result.reason, 'wsl2_begin_failed');
    assert.deepEqual(unknown.client.calls, ['begin', 'stop']);
    assert.equal(unknown.driverCalls.length, 0);
  });

  it('a driver that throws still stops the run', async () => {
    const t = job({ driver: async () => { throw new Error('boom'); } });
    assert.equal((await t.done).result.reason, 'hands_failed');
    assert.deepEqual(t.client.calls, ['begin', 'stop']);
    const stuck = job({ driver: async () => { throw new Error('boom'); }, client: fakeClient({ stop: async () => { throw bridgeError('bridge_unavailable', 'not_applied'); } }) });
    assert.deepEqual(await stuck.done.then(({ result }) => [result.reason, result.treeStopConfirmed]), ['stop_unconfirmed', false], 'and if nobody can stop it, the computer stays busy');
  });

  it('a stop asked during the driver stops the run and collects nothing', async () => {
    const run = { stopRequested: false };
    const t = job({ run, driver: async () => { run.stopRequested = true; return { outcome: 'stopped', reason: 'stopped_by_human', claim: '', toolCalls: 0 }; } });
    const { collected } = await t.done;
    assert.equal(collected, null);
    assert.deepEqual(t.client.calls, ['begin', 'stop']);
    assert.equal(run.stopBridge, undefined, 'the handle does not outlive the run');
  });

  it('no_run from end is a failure: what was collected is not shown', async () => {
    const t = job({ client: fakeClient({ end: async () => { throw bridgeError('no_run'); } }) });
    const { collected } = await t.done;
    assert.deepEqual([collected.ok, collected.code], [false, 'run_ended_early']);
    assert.deepEqual(t.client.calls, ['begin', 'bundle', 'end'], 'nothing left to stop');
  });

  it('a bundle that fails says so, and the run is still ended', async () => {
    const t = job({ client: fakeClient({ bundle: async () => { throw bridgeError('bundle_too_large'); } }) });
    const { collected } = await t.done;
    assert.deepEqual([collected.ok, collected.code], [false, 'result_missing']);
    assert.deepEqual(t.client.calls, ['begin', 'bundle', 'end']);
    assert.ok(t.notes.includes('hands wsl2_bundle_failed bundle_too_large'));
  });

  it('an end that fails for another reason falls back to stop', async () => {
    const t = job({ client: fakeClient({ end: async () => { throw bridgeError('unregister_failed'); } }) });
    const { collected } = await t.done;
    assert.equal(collected.ok, false);
    assert.deepEqual(t.client.calls, ['begin', 'bundle', 'end', 'stop']);
  });

  it('the word the shell server halted on reaches the log, and a word that is not one does not', async () => {
    const write = (word) => async (_choice, runDir) => { writeFileSync(path.join(runDir, 'halt'), word); return { outcome: 'failed', reason: 'x', claim: '', toolCalls: 1 }; };
    const named = job({ driver: write('server_identity_mismatch') });
    await named.done;
    assert.ok(named.notes.includes('hands wsl2_shell_halted server_identity_mismatch'));
    const odd = job({ driver: write('C:\\secret path') });
    await odd.done;
    assert.ok(odd.notes.includes('hands wsl2_shell_halted unknown'));
  });
});

describe('the result', () => {
  const collect = (bundle, baseOid = base, operationId = OP) => { const { runDir, resultsRoot, quarantine } = folders(); return { resultsRoot, quarantine, done: collectWsl2Result({ bundle, baseOid, operationId, quarantine, runDir, resultsRoot }) }; };

  it('a job that changed nothing is a result with no change', async () => {
    const { done } = collect(unchangedBundle);
    const result = await done;
    assert.deepEqual([result.ok, result.resultOid, result.files.length, result.diff], [true, base, 0, '']);
  });

  it('a result whose history lacks the base is refused, and no bundle is kept', async () => {
    const { done, resultsRoot } = collect(unchangedBundle, changed);
    const result = await done;
    assert.deepEqual([result.ok, result.code], [false, 'git_failed']);
    assert.ok(!existsSync(resultsRoot));
  });

  it('a forged header, an empty bundle and one over the limit are refused before git', async () => {
    assert.equal((await collect(Buffer.from('junk')).done).code, 'bundle_invalid');
    assert.equal((await collect(Buffer.alloc(0)).done).code, 'result_too_large');
    assert.equal((await collect(Buffer.alloc(MAX_RESULT_BYTES + 1)).done).code, 'result_too_large');
    const forged = Buffer.concat([Buffer.from(`# v2 git bundle\n${'a'.repeat(40)} HEAD\n\n`), Buffer.from('PACK')]);
    assert.equal((await collect(forged).done).code, 'bundle_invalid');
  });

  it('a symlink in the result is refused by the quarantine', async () => {
    const before = text('rev-parse', 'HEAD');
    g('update-index', '--add', '--cacheinfo', `120000,${text('hash-object', '-w', 'a.txt')},link`);
    g('commit', '-q', '-m', 'link');
    const bundle = bundleAll();
    g('reset', '-q', '--hard', before);
    assert.equal((await collect(bundle).done).code, 'symlink');
  });

  it('the quarantine repository goes, and only the newest bundles stay', async () => {
    const { runDir, quarantine, resultsRoot } = folders();
    for (let i = 0; i < KEPT_RESULTS + 2; i += 1) {
      const dir = path.join(runDir, String(i));
      mkdirSync(dir);
      assert.equal((await collectWsl2Result({ bundle: changedBundle, baseOid: base, operationId: `op-${i}`, quarantine, runDir: dir, resultsRoot })).ok, true);
    }
    assert.equal(readdirSync(resultsRoot).length, KEPT_RESULTS);
    assert.deepEqual(readdirSync(path.join(work, `q-${n}`)).filter((name) => name.startsWith('q-')), []);
  });
});

test('readiness: no until the bridge says yes, no after a failure, and one question per refresh', async () => {
  let at = 0;
  const answers = [{ kernelOk: true }, { kernelOk: false }];
  let asked = 0;
  const client = { status: async () => { asked += 1; const next = answers.shift(); if (!next) throw bridgeError('bridge_unavailable', 'not_applied'); return next; } };
  const readiness = createWsl2Readiness({ client, now: () => at });
  assert.equal(readiness.ready(), false, 'before the first answer');
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(readiness.ready(), true);
  assert.equal(asked, 1, 'polling does not ask again inside the refresh');
  at += READY_REFRESH_MS;
  readiness.ready();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(readiness.ready(), false, 'kernel below the floor');
  at += READY_REFRESH_MS;
  readiness.ready();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(readiness.ready(), false, 'the bridge is gone');
});

test('the target is the head the bridge reads; a VM computer has none', async () => {
  const seen = [];
  const lookup = wsl2TargetLookup({ client: { status: async (query) => { seen.push(query); return { kernelOk: true, reason: null, head: 'b'.repeat(40) }; } }, repositoryOf: (id) => (id === 'pc-1' ? 'repo-1' : undefined) });
  assert.deepEqual(await lookup('pc-1'), { repositoryId: 'repo-1', baseOid: 'b'.repeat(40) });
  assert.equal(await lookup('pc-vm'), undefined);
  assert.deepEqual(seen, [{ repositoryId: 'repo-1' }]);
});

test('SEC-001: a stop the bridge answered no_run, before it knew of the run, is sent again once begin has made the run', async () => {
  const run = { stopRequested: false };
  const client = fakeClient({
    begin: async () => { run.stopRequested = true; await run.stopBridge(); },
    stop: (() => { let first = true; return async () => { if (first) { first = false; throw bridgeError('no_run'); } }; })(),
  });
  const t = job({ client, run });
  const { result } = await t.done;
  assert.equal(result.reason, 'stopped_by_human');
  assert.deepEqual(client.calls, ['begin', 'stop', 'stop']);
  assert.equal(t.driverCalls.length, 0);
});

test('a stop asked before begin never reaches the bridge', async () => {
  const t = job({ run: { stopRequested: true } });
  assert.equal((await t.done).result.reason, 'stopped_by_human');
  assert.deepEqual(t.client.calls, []);
});

test('SEC-004: a stop nobody confirmed says so and keeps the computer busy', async () => {
  const client = fakeClient({ end: async () => { throw bridgeError('unregister_failed'); }, stop: async () => { throw bridgeError('bridge_unavailable', 'not_applied'); } });
  const t = job({ client });
  const { result } = await t.done;
  assert.deepEqual([result.reason, result.treeStopConfirmed], ['stop_unconfirmed', false]);
  assert.ok(t.notes.includes('hands wsl2_stop_unconfirmed'));
  assert.deepEqual(client.calls, ['begin', 'bundle', 'end', 'stop', 'stop']);
});

test('SEC-002: what could forge a line or hide a character becomes a visible mark, and an ordinary diff is left alone', () => {
  assert.equal(markUnsafeText('+a\u2028diff --git a/x b/x\r\n'), '+a\u27e6U+2028\u27e7diff --git a/x b/x\r\n', 'a Windows line end is left alone');
  assert.equal(markUnsafeText('a\rb'), 'a\u27e6U+000D\u27e7b');
  assert.equal(markUnsafeText('\u2800\u{1d173}'), '\u27e6U+2800\u27e7\u27e6U+1D173\u27e7');
  assert.equal(markUnsafeText('a\u202eb\u200bc\u{e0041}'), 'a\u27e6U+202E\u27e7b\u27e6U+200B\u27e7c\u27e6U+E0041\u27e7');
  assert.equal(markUnsafeText('\u0085'), '\u27e6U+0085\u27e7');
  const plain = '@@ -1 +1 @@\n-\tone\n+\u65e5\u672c\u8a9e <b>\n';
  assert.equal(markUnsafeText(plain), plain);
});

test('SEC-003: a stop or the deadline ends the reading of a result', async () => {
  const { runDir, resultsRoot, quarantine } = folders();
  const stopped = await collectWsl2Result({ bundle: changedBundle, baseOid: base, operationId: OP, quarantine, runDir, resultsRoot, isStopped: () => true });
  assert.equal(stopped.code, 'cancelled');
  const later = folders();
  let at = 0;
  const late = await collectWsl2Result({ bundle: changedBundle, baseOid: base, operationId: OP, quarantine: later.quarantine, runDir: later.runDir, resultsRoot: later.resultsRoot, now: () => { at += RESULT_DEADLINE_MS; return at; } });
  assert.equal(late.code, 'cancelled');
  assert.ok(!existsSync(later.resultsRoot), 'no bundle is kept');
});

test('a helper or git that is not administrator-only, or an old git, stops the job before the bridge', async () => {
  assert.equal(await wsl2Refusal({ guard: { check: async () => false } }, { lease: 'x' }), 'wsl2_tools_untrusted');
  assert.equal(await wsl2Refusal({ guard: { check: async () => { throw new Error('x'); } } }, { lease: 'x' }), 'wsl2_tools_untrusted');
  assert.equal(await wsl2Refusal({ guard: { check: async () => true } }, { lease: null }), 'wsl2_lease_unavailable');
  assert.equal(await wsl2Refusal({ guard: { check: async () => true } }, { lease: 'x' }), null);
  const yes = { check: async () => true };
  const no = { check: async () => false };
  const gitAt = (major, minor) => async () => ({ major, minor });
  assert.equal(await createWsl2ToolGuard({ checks: [{ guard: yes, file: 'a' }], gitVersion: gitAt(2, 53) }).check(), true);
  assert.equal(await createWsl2ToolGuard({ checks: [{ guard: yes, file: 'a' }], gitVersion: gitAt(3, 0) }).check(), true);
  assert.equal(await createWsl2ToolGuard({ checks: [{ guard: yes, file: 'a' }], gitVersion: gitAt(2, 52) }).check(), false);
  assert.equal(await createWsl2ToolGuard({ checks: [{ guard: yes, file: 'a' }], gitVersion: async () => null }).check(), false);
  assert.equal(await createWsl2ToolGuard({ checks: [{ guard: yes, file: 'a' }, { guard: no, file: 'b' }], gitVersion: gitAt(2, 53) }).check(), false);
});

test('the driver gets what the lease has left, less the time for the result', () => {
  assert.equal(driverTimeLeftMs({ lease: { expiresAt: 1000 } }, 400_000), 420_000);
  assert.equal(driverTimeLeftMs({ lease: { expiresAt: 1000 } }, 990_000), 0);
});
