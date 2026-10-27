import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { GatewayError, RuntimeGateway, RUNTIME_PROVIDERS, resolveProviderExecutable } from '../src/runtime/gateway.mjs';

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-runtime-'));
  const cwd = path.join(root, 'project');
  await mkdir(cwd);
  const gateway = new RuntimeGateway({
    roots: [root],
    authorize: async () => true,
    resolveExecutableImpl: async () => process.execPath,
    ...options,
  });
  return { root, cwd, gateway, dispose: async () => { await gateway.close({ timeoutMs: 100 }); await rm(root, { recursive: true, force: true }); } };
}
async function waitFor(predicate, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition_not_reached');
}
class FakeChild extends EventEmitter {
  pid = undefined;
  exitCode = null;
  signalCode = null;
  killed = false;
  kill(signal) { this.killed = true; this.signalCode = signal; this.exitCode = null; queueMicrotask(() => this.emit('close', null, signal)); return true; }
}

test('providers are an explicit fixed allowlist and unknown names do not resolve', async () => {
  assert.deepEqual(RUNTIME_PROVIDERS, { claude: 'claude', codex: 'codex', opencode: 'opencode' });
  assert.equal(await resolveProviderExecutable('other', { pathValue: '' }), null);
});

test('default authorization denies start and caller booleans cannot grant execution', async (t) => {
  const f = await fixture({ authorize: undefined });
  t.after(f.dispose);
  await assert.rejects(f.gateway.start({ provider: 'claude', cwd: f.cwd, confirmed: true }), (error) => error instanceof GatewayError && error.code === 'confirmation_required');
  assert.equal(f.gateway.list().length, 0);
});

test('host authorization receives the exact canonical executable, cwd and argv before spawn', async (t) => {
  const seen = [];
  let spawnCount = 0;
  const f = await fixture({
    authorize: async (request) => { seen.push(request); return true; },
    spawnImpl: () => { spawnCount++; return new FakeChild(); },
  });
  t.after(f.dispose);
  const args = ['--print', 'fixture prompt'];
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, args });
  assert.equal(spawnCount, 1);
  assert.deepEqual(seen[0], {
    action: 'start', provider: 'claude', executable: process.execPath, cwd: f.cwd, args,
    platform: process.platform, maxDurationMs: 15 * 60 * 1000, maxActive: 4,
  });
  assert.equal(Object.isFrozen(seen[0]), true);
  assert.equal(Object.isFrozen(seen[0].args), true);
  assert.equal(run.status, 'starting');
  assert.equal('confirmed' in run, false);
});

test('authorization callback errors fail closed and expose only a stable error code', async (t) => {
  const f = await fixture({ authorize: () => { throw new Error('private authorization detail'); } });
  t.after(f.dispose);
  await assert.rejects(f.gateway.start({ provider: 'claude', cwd: f.cwd }), (error) => error.code === 'authorization_failed' && !error.message.includes('private'));
});

test('missing or invalid executable fails closed before authorization or spawn', async (t) => {
  let authorized = false;
  let spawned = false;
  const f = await fixture({
    authorize: async () => { authorized = true; return true; },
    resolveExecutableImpl: async () => path.join(os.tmpdir(), 'albera-executable-that-does-not-exist'),
    spawnImpl: () => { spawned = true; return new FakeChild(); },
  });
  t.after(f.dispose);
  await assert.rejects(f.gateway.start({ provider: 'claude', cwd: f.cwd }), (error) => error.code === 'executable_unavailable');
  assert.equal(authorized, false);
  assert.equal(spawned, false);
});

test('unknown provider, malformed argv, NUL and oversized argv are rejected before spawn', async (t) => {
  let spawnCount = 0;
  const f = await fixture({ spawnImpl: () => { spawnCount++; return new FakeChild(); } });
  t.after(f.dispose);
  for (const input of [
    { provider: 'gemini', cwd: f.cwd },
    { provider: 'claude', cwd: f.cwd, args: ['bad\0arg'] },
    { provider: 'claude', cwd: f.cwd, args: ['x'.repeat(33 * 1024)] },
    { provider: 'claude', cwd: f.cwd, args: ['valid', 42] },
  ]) await assert.rejects(f.gateway.start(input), GatewayError);
  assert.equal(spawnCount, 0);
});

test('cwd must be an existing canonical directory contained by an allowed root', async (t) => {
  const f = await fixture({ spawnImpl: () => new FakeChild() });
  t.after(f.dispose);
  await assert.rejects(f.gateway.start({ provider: 'claude', cwd: os.tmpdir() }), (error) => error.code === 'cwd_not_allowed');
  await assert.rejects(f.gateway.start({ provider: 'claude', cwd: path.join(f.root, 'missing') }), (error) => error.code === 'cwd_not_allowed');
  const link = path.join(f.root, 'escape');
  try {
    await symlink(os.tmpdir(), link, 'junction');
    await assert.rejects(f.gateway.start({ provider: 'claude', cwd: link }), (error) => error.code === 'cwd_not_allowed');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    t.diagnostic('symlink escape case skipped: this Windows environment does not permit junction creation');
  }
});

test('spawn uses an absolute executable, argv, shell:false and a minimized provider environment', async (t) => {
  let captured;
  const originalSecret = process.env.AWS_SECRET_ACCESS_KEY;
  const restoreSecret = () => {
    if (originalSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = originalSecret;
  };
  process.env.AWS_SECRET_ACCESS_KEY = 'should-not-be-inherited';
  try {
    const f = await fixture({ spawnImpl: (_exe, _args, options) => { captured = options; return new FakeChild(); } });
    t.after(async () => { await f.dispose(); restoreSecret(); });
    await f.gateway.start({ provider: 'codex', cwd: f.cwd, args: ['--help'] });
    assert.equal(captured.shell, false);
    assert.equal(captured.detached, process.platform !== 'win32');
    assert.equal(captured.stdio, 'ignore');
    assert.equal('AWS_SECRET_ACCESS_KEY' in captured.env, false);
  } finally { restoreSecret(); }
});

test('active-run reservation prevents concurrent starts above the configured limit', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture({
    maxActive: 1,
    authorize: async () => { await gate; return true; },
    spawnImpl: () => new FakeChild(),
  });
  t.after(f.dispose);
  const first = f.gateway.start({ provider: 'claude', cwd: f.cwd });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.gateway.start({ provider: 'codex', cwd: f.cwd }), (error) => error.code === 'capacity');
  release();
  await first;
});

test('invalid concurrency and run-time caps fail configuration instead of silently widening limits', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-runtime-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const options of [{ maxActive: 0 }, { maxActive: 5 }, { maxActive: 1.5 }, { runTimeoutMs: 0 }, { runTimeoutMs: 3600001 }]) {
    assert.throws(() => new RuntimeGateway({ roots: [root], ...options }), TypeError);
  }
});

test('records and lifecycle events are bounded and never include argv, cwd or secret values', async (t) => {
  const children = [];
  const secret = 'synthetic-secret-do-not-log';
  const f = await fixture({ spawnImpl: () => { const child = new FakeChild(); children.push(child); queueMicrotask(() => child.emit('spawn')); return child; } });
  t.after(f.dispose);
  for (let i = 0; i < 140; i++) {
    const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, args: [secret] });
    const child = children.at(-1);
    child.emit('close', 0, null);
    assert.equal(f.gateway.get(run.id).status, 'exited');
  }
  assert.ok(f.gateway.list().length <= 64);
  const first = f.gateway.events({ limit: 100 });
  const second = f.gateway.events({ after: first.at(-1).id, limit: 100 });
  const third = f.gateway.events({ after: second.at(-1).id, limit: 100 });
  const events = [...first, ...second, ...third];
  assert.equal(events.length, 256);
  assert.ok(!JSON.stringify(events).includes(secret));
  assert.ok(!JSON.stringify(events).includes(f.cwd));
  assert.deepEqual(Object.keys(events[0]).sort(), ['at', 'id', 'provider', 'runId', 'type']);
});

test('run duration timeout requests stop and repeated stop is idempotent', async (t) => {
  const f = await fixture({
    runTimeoutMs: 30,
    spawnImpl: () => { const child = new FakeChild(); queueMicrotask(() => child.emit('spawn')); return child; },
    signalTreeImpl: (_pid, signal, child) => child.kill(signal),
  });
  t.after(f.dispose);
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd });
  await waitFor(() => f.gateway.get(run.id).status === 'stopped');
  assert.deepEqual(f.gateway.events().map((event) => event.type), ['started', 'stop_requested', 'stopped']);
});

test('timeout falls back to terminating the direct child if process-tree termination fails', async (t) => {
  const f = await fixture({
    runTimeoutMs: 30,
    spawnImpl: () => {
      const child = new FakeChild();
      child.pid = 424242;
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    signalTreeImpl: () => { throw new Error('synthetic signal adapter failure'); },
  });
  t.after(f.dispose);
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd });
  await waitFor(() => f.gateway.get(run.id).status === 'failed');
  assert.equal(f.gateway.get(run.id).treeStopConfirmed, false);
  assert.deepEqual(f.gateway.events().map((event) => event.type), ['started', 'stop_requested', 'stop_failed', 'failed']);
  assert.deepEqual(await f.gateway.close({ timeoutMs: 10 }), [run.id]);
});

test('manual stop requires separate authorization; denied stop leaves the run active', async (t) => {
  const f = await fixture({
    authorize: async ({ action }) => action !== 'stop',
    spawnImpl: () => { const child = new FakeChild(); queueMicrotask(() => child.emit('spawn')); return child; },
  });
  t.after(f.dispose);
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd });
  await waitFor(() => f.gateway.get(run.id).status === 'running');
  await assert.rejects(f.gateway.stop(run.id), (error) => error.code === 'confirmation_required');
  assert.equal(f.gateway.get(run.id).status, 'running');
});

test('concurrent stop requests send one termination signal', async (t) => {
  let stopApprovals = 0;
  let signals = 0;
  const f = await fixture({
    authorize: async ({ action }) => { if (action === 'stop') stopApprovals++; return true; },
    spawnImpl: () => {
      const child = new FakeChild();
      const kill = child.kill.bind(child);
      child.kill = (signal) => { if (signal === 'SIGTERM') signals++; return kill(signal); };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  t.after(f.dispose);
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd });
  await waitFor(() => f.gateway.get(run.id).status === 'running');
  await Promise.all([f.gateway.stop(run.id), f.gateway.stop(run.id)]);
  await waitFor(() => f.gateway.get(run.id).status === 'stopped');
  assert.equal(stopApprovals, 2);
  assert.equal(signals, 1);
});

test('executable resolver accepts only the fixed provider command and executable files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-provider-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = path.join(root, process.platform === 'win32' ? 'claude.exe' : 'claude');
  await writeFile(command, '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') await chmod(command, 0o755);
  const found = await resolveProviderExecutable('claude', { pathValue: root });
  assert.equal(found, await import('node:fs/promises').then(({ realpath }) => realpath(command)));
  assert.equal(await resolveProviderExecutable('codex', { pathValue: root }), null);
  if (process.platform === 'win32') {
    await writeFile(path.join(root, 'codex.cmd'), '@echo off\r\nexit /b 0\r\n');
    assert.equal(await resolveProviderExecutable('codex', { pathValue: root }), null);
  }
});

test('local helper process integration: starts, reports lifecycle only, stops, and closes without an AI CLI', async (t) => {
  const f = await fixture({
    resolveExecutableImpl: async () => process.execPath,
    authorize: async () => true,
  });
  t.after(f.dispose);
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, args: ['-e', 'setInterval(() => {}, 1000)'] });
  await waitFor(() => f.gateway.get(run.id).status === 'running');
  const returned = JSON.stringify({ run: f.gateway.get(run.id), events: f.gateway.events() });
  assert.ok(!returned.includes(f.cwd));
  assert.ok(!returned.includes('setInterval'));
  const stopped = await f.gateway.stop(run.id);
  assert.ok(['stopping', 'stopped'].includes(stopped.status));
  await waitFor(() => f.gateway.get(run.id).status === 'stopped');
  assert.deepEqual(await f.gateway.close(), []);
});

test('local helper process integration: abnormal exit is represented without output capture', async (t) => {
  const f = await fixture({ resolveExecutableImpl: async () => process.execPath });
  t.after(f.dispose);
  const run = await f.gateway.start({ provider: 'codex', cwd: f.cwd, args: ['-e', 'process.exit(7)'] });
  await waitFor(() => f.gateway.get(run.id).status === 'exited');
  assert.equal(f.gateway.get(run.id).exitCode, 7);
  assert.deepEqual(f.gateway.events().map((event) => event.type), ['started', 'exited']);
  assert.ok(!JSON.stringify(f.gateway.events()).includes('process.exit'));
});

test('orderly host close stops active children even when interactive stop approval is denied', async (t) => {
  const f = await fixture({
    authorize: async ({ action }) => action === 'start',
    resolveExecutableImpl: async () => process.execPath,
  });
  t.after(f.dispose);
  const run = await f.gateway.start({ provider: 'opencode', cwd: f.cwd, args: ['-e', 'setInterval(() => {}, 1000)'] });
  await waitFor(() => f.gateway.get(run.id).status === 'running');
  assert.deepEqual(await f.gateway.close({ timeoutMs: 5000 }), []);
  assert.equal(f.gateway.get(run.id).status, 'stopped');
});

test('local helper process tree integration: stopping the approved helper stops its child too', async (t) => {
  const f = await fixture({ resolveExecutableImpl: async () => process.execPath });
  const childPidPath = path.join(f.root, 'child-pid.txt');
  const heartbeatPath = path.join(f.root, 'child-heartbeat.txt');
  let childPid;
  t.after(async () => {
    await f.dispose();
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* helper child already exited */ } }
  });
  const heartbeatCode = `let n=0;const fs=require('node:fs');setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeatPath)},String(++n)),50)`;
  const parentCode = `const{spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(heartbeatCode)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(childPidPath)},String(c.pid));setInterval(()=>{},1000)`;
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, args: ['-e', parentCode] });
  await waitFor(() => f.gateway.get(run.id).status === 'running');
  await waitFor(() => {
    try { childPid = Number(readFileSync(childPidPath, 'utf8')); return Number.isInteger(childPid) && childPid > 0; }
    catch { return false; }
  });
  await waitFor(() => { try { return Number(readFileSync(heartbeatPath, 'utf8')) > 0; } catch { return false; } });
  await f.gateway.stop(run.id);
  await waitFor(() => f.gateway.get(run.id).status === 'stopped');
  assert.equal(f.gateway.get(run.id).treeStopConfirmed, true);
  const stoppedAt = Number(await readFile(heartbeatPath, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(Number(await readFile(heartbeatPath, 'utf8')), stoppedAt);
});
