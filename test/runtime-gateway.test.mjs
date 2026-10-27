import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { createRuntimeApprovalBroker } from '../src/runtime/approval-broker.mjs';
import { buildProviderLaunch, GatewayError, RuntimeGateway, RUNTIME_PROFILES, RUNTIME_PROVIDERS, resolveProviderExecutable } from '../src/runtime/gateway.mjs';

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-runtime-'));
  const cwd = path.join(root, 'project');
  await mkdir(cwd);
  const { buildLaunchImpl = (_provider, profile, prompt) => ({ profile, args: Array.isArray(prompt) ? prompt : [] }), probeVersionImpl = async () => '99.0.0', ...gatewayOptions } = options;
  const gateway = new RuntimeGateway({
    roots: [root],
    authorize: async () => true,
    resolveExecutableImpl: async () => process.execPath,
    probeVersionImpl,
    buildLaunchImpl,
    ...gatewayOptions,
  });
  return { root, cwd, gateway, dispose: async () => { await gateway.close({ timeoutMs: 100 }); await rm(root, { recursive: true, force: true }); } };
}
async function waitFor(predicate, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await predicate();
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

test('read-only provider profile generates fixed Claude argv and refuses unverified providers', async () => {
  assert.deepEqual(buildProviderLaunch('claude', 'fixture prompt'), {
    profile: RUNTIME_PROFILES.readOnly,
    args: ['--restricted', '--safe-mode', '--disallowedTools', 'mcp__*', '--permission-mode', 'plan', '--print', '--max-turns', '1', '--no-session-persistence', 'ALBERA task:\nfixture prompt'],
  });
  assert.equal(Object.isFrozen(buildProviderLaunch('claude', 'fixture prompt')), true);
  assert.equal(Object.isFrozen(buildProviderLaunch('claude', 'fixture prompt').args), true);
  assert.throws(() => buildProviderLaunch('codex', 'fixture prompt'), (error) => error.code === 'profile_unavailable');
  assert.throws(() => buildProviderLaunch('opencode', 'fixture prompt'), (error) => error.code === 'profile_unavailable');
  assert.throws(() => buildProviderLaunch('claude', 'fixture prompt', 'workspace-write'), (error) => error.code === 'unsupported_profile');
  for (const prompt of [undefined, 'bad\0prompt', 'x'.repeat(17 * 1024)]) {
    assert.throws(() => buildProviderLaunch('claude', prompt), (error) => error.code === 'invalid_args');
  }
  assert.equal(buildProviderLaunch('claude', '--dangerously-skip-permissions').args.at(-1), 'ALBERA task:\n--dangerously-skip-permissions');
});

test('streaming read-only profile fixes stream-json transport and keeps prompts out of argv', () => {
  const launch = buildProviderLaunch('claude', 'initial secret', RUNTIME_PROFILES.readOnlyStreaming);
  assert.deepEqual(launch.args, [
    '--restricted', '--safe-mode', '--disallowedTools', 'mcp__*', '--permission-mode', 'plan', '--permission-prompts', 'none',
    '--print', '--max-turns', '1', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json',
  ]);
  assert.equal(launch.inputMode, 'claude-stream-json');
  assert.equal(launch.initialInput, 'ALBERA task:\ninitial secret');
  assert.equal(JSON.stringify(launch.args).includes('initial secret'), false);
});

test('streaming initial input is included in host approval and remains outside argv', async (t) => {
  let approval;
  let spawned;
  const f = await fixture({
    authorize: async (request) => { approval = request; return true; },
    buildLaunchImpl: (provider, profile, prompt) => buildProviderLaunch(provider, prompt, profile),
    spawnImpl: (_executable, args, options) => { spawned = { args, options }; return new FakeChild(); },
  });
  t.after(f.dispose);
  const prompt = 'private initial task';
  await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt, profile: RUNTIME_PROFILES.readOnlyStreaming });
  assert.equal(Object.isFrozen(approval), true);
  assert.equal(approval.initialInput, 'ALBERA task:\nprivate initial task');
  assert.equal(approval.args.includes(prompt), false);
  assert.equal(spawned.options.initialInput, approval.initialInput);
  assert.deepEqual(spawned.args, approval.args);
});

test('trusted approval broker gates streaming provider launch on an explicit one-use decision', async (t) => {
  const broker = createRuntimeApprovalBroker();
  let spawned = false;
  const child = new FakeChild();
  const f = await fixture({
    authorize: broker.authorize,
    buildLaunchImpl: (provider, profile, prompt) => buildProviderLaunch(provider, prompt, profile),
    spawnImpl: () => { spawned = true; queueMicrotask(() => child.emit('spawn')); return child; },
    signalTreeImpl: (_pid, signal, target) => target.kill(signal),
  });
  t.after(async () => { broker.close(); await f.dispose(); });
  const starting = f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'review this task', profile: RUNTIME_PROFILES.readOnlyStreaming });
  await waitFor(() => broker.listPending().length === 1);
  const [approval] = broker.listPending();
  assert.equal(approval.request.action, 'start');
  assert.equal(approval.request.cwd, await realpath(f.cwd));
  assert.equal(approval.request.initialInput, 'ALBERA task:\nreview this task');
  assert.equal(JSON.stringify(approval.request.args).includes('review this task'), false);
  assert.equal(spawned, false);
  assert.equal(broker.decide(approval.id, true), true);
  const run = await starting;
  await waitFor(() => f.gateway.get(run.id).status === 'running');
  assert.equal(spawned, true);
  assert.equal(broker.decide(approval.id, true), false);
  const stopping = f.gateway.stop(run.id);
  await waitFor(() => broker.listPending().length === 1);
  const [stopApproval] = broker.listPending();
  assert.equal(stopApproval.request.action, 'stop');
  assert.equal(stopApproval.request.runId, run.id);
  assert.equal(broker.decide(stopApproval.id, true), true);
  await stopping;
  await waitFor(() => f.gateway.get(run.id).status === 'stopped');
});

test('denying a broker approval prevents Gateway spawn', async (t) => {
  const broker = createRuntimeApprovalBroker();
  let spawned = false;
  let probed = false;
  const f = await fixture({ authorize: broker.authorize, probeVersionImpl: async () => { probed = true; return '99.0.0'; }, spawnImpl: () => { spawned = true; return new FakeChild(); } });
  t.after(async () => { broker.close(); await f.dispose(); });
  const starting = f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'denied task' });
  await waitFor(() => broker.listPending().length === 1);
  const [approval] = broker.listPending();
  assert.equal(broker.decide(approval.id, false), true);
  await assert.rejects(starting, (error) => error.code === 'confirmation_required');
  assert.equal(probed, false);
  assert.equal(spawned, false);
  assert.equal(f.gateway.list().length, 0);
});

test('default Gateway generates the read-only profile and refuses raw request argv', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-profile-'));
  const seen = [];
  let spawnedArgs;
  let resolveCount = 0;
  let spawnCount = 0;
  const gateway = new RuntimeGateway({
    roots: [root],
    authorize: async (request) => { seen.push(request); return true; },
    resolveExecutableImpl: async () => { resolveCount++; return process.execPath; },
    spawnImpl: (_executable, args) => { spawnCount++; spawnedArgs = args; return new FakeChild(); },
    env: { PATH: process.env.PATH },
  });
  t.after(async () => { await gateway.close({ timeoutMs: 100 }); await rm(root, { recursive: true, force: true }); });
  await gateway.start({ provider: 'claude', cwd: root, prompt: 'fixture prompt' });
  assert.equal(seen[0].profile, 'read-only');
  assert.deepEqual(spawnedArgs, buildProviderLaunch('claude', 'fixture prompt').args);
  await assert.rejects(gateway.start({ provider: 'claude', cwd: root, args: ['--dangerously-skip-permissions'] }), (error) => error.code === 'invalid_args');
  await assert.rejects(gateway.start({ provider: 'codex', cwd: root, prompt: 'fixture prompt' }), (error) => error.code === 'profile_unavailable');
  await assert.rejects(gateway.start({ provider: 'opencode', cwd: root, prompt: 'fixture prompt' }), (error) => error.code === 'profile_unavailable');
  assert.equal(seen.length, 1);
  assert.equal(resolveCount, 1);
  assert.equal(spawnCount, 1);
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
    env: { PATH: process.env.PATH },
  });
  t.after(f.dispose);
  const args = ['--print', 'fixture prompt'];
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: args });
  assert.equal(spawnCount, 1);
  assert.deepEqual(seen[0], {
    action: 'start', provider: 'claude', profile: 'read-only', executable: process.execPath, cwd: await realpath(f.cwd), args,
    minimumCliVersion: '2.1.248', versionCheck: true,
    environment: { providerVariables: [], endpointOverrides: [] },
    platform: process.platform, maxDurationMs: 15 * 60 * 1000, maxActive: 4,
  });
  assert.equal(Object.isFrozen(seen[0]), true);
  assert.equal(Object.isFrozen(seen[0].args), true);
  assert.equal(run.status, 'starting');
  assert.equal('confirmed' in run, false);
});

test('Gateway checks the approved CLI version before main spawn and fails closed below the profile minimum', async (t) => {
  const calls = [];
  let spawned = false;
  const f = await fixture({
    authorize: async (request) => { calls.push(['authorize', request.minimumCliVersion, request.versionCheck]); return true; },
    probeVersionImpl: async (executable, options) => { calls.push(['probe', executable, options.platform]); return '2.1.247'; },
    spawnImpl: () => { spawned = true; return new FakeChild(); },
  });
  t.after(f.dispose);
  await assert.rejects(f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'synthetic' }), (error) => error.code === 'cli_version_unavailable');
  assert.deepEqual(calls, [
    ['authorize', '2.1.248', true],
    ['probe', process.execPath, process.platform],
  ]);
  assert.equal(spawned, false);
});

test('Gateway refuses an executable changed while host authorization is pending', async (t) => {
  let authorized;
  let approve;
  let spawned = false;
  const authorizedSignal = new Promise((resolve) => { authorized = resolve; });
  const approvalGate = new Promise((resolve) => { approve = resolve; });
  const f = await fixture({
    resolveExecutableImpl: async () => path.join(f.root, `provider${process.platform === 'win32' ? '.exe' : ''}`),
    authorize: async () => { authorized(); await approvalGate; return true; },
    spawnImpl: () => { spawned = true; return new FakeChild(); },
  });
  t.after(f.dispose);
  const executable = path.join(f.root, `provider${process.platform === 'win32' ? '.exe' : ''}`);
  await writeFile(executable, 'approved executable fixture');
  await chmod(executable, 0o700);

  const start = f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'fixture prompt' });
  await authorizedSignal;
  await writeFile(executable, 'replacement executable fixture with different identity');
  approve();

  await assert.rejects(start, (error) => error.code === 'executable_unavailable');
  assert.equal(spawned, false);
});

test('authorization sees a redacted provider environment summary and spawn uses its pre-approval snapshot', async (t) => {
  let seen;
  let capturedEnvironment;
  let capturedArgs;
  let release;
  const approvalGate = new Promise((resolve) => { release = resolve; });
  const sourceEnvironment = {
    PATH: process.env.PATH,
    ANTHROPIC_API_KEY: 'synthetic-api-secret-before-approval',
    ANTHROPIC_BASE_URL: 'https://user:password@api.example.test:8443/private/path?token=synthetic-query-secret',
    AWS_SECRET_ACCESS_KEY: 'unrelated-secret-must-not-inherit',
  };
  const f = await fixture({
    env: sourceEnvironment,
    authorize: async (request) => { seen = request; await approvalGate; return true; },
    spawnImpl: (_executable, args, options) => { capturedArgs = args; capturedEnvironment = options.env; return new FakeChild(); },
  });
  t.after(f.dispose);

  const sourceArgs = ['--print', 'synthetic prompt'];
  const starting = f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: sourceArgs });
  await waitFor(() => seen);
  assert.deepEqual(seen.args, ['--print', 'synthetic prompt']);
  assert.equal(Object.isFrozen(seen.args), true);
  assert.deepEqual(seen.environment, {
    providerVariables: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
    endpointOverrides: [{ variable: 'ANTHROPIC_BASE_URL', protocol: 'https', host: 'api.example.test:8443' }],
  });
  assert.equal(Object.isFrozen(seen.environment), true);
  assert.equal(Object.isFrozen(seen.environment.providerVariables), true);
  assert.equal(Object.isFrozen(seen.environment.endpointOverrides), true);
  assert.equal(Object.isFrozen(seen.environment.endpointOverrides[0]), true);
  assert.ok(!JSON.stringify(seen.environment).includes('synthetic-api-secret-before-approval'));
  assert.ok(!JSON.stringify(seen.environment).includes('synthetic-query-secret'));
  assert.ok(!JSON.stringify(seen.environment).includes('password'));

  sourceEnvironment.ANTHROPIC_API_KEY = 'synthetic-api-secret-after-approval-request';
  sourceEnvironment.ANTHROPIC_BASE_URL = 'https://changed.example.test';
  sourceArgs[0] = '--dangerously-skip-permissions';
  sourceArgs[1] = 'mutated after approval request';
  release();
  await starting;
  assert.deepEqual(capturedArgs, ['--print', 'synthetic prompt']);
  assert.equal(capturedEnvironment.ANTHROPIC_API_KEY, 'synthetic-api-secret-before-approval');
  assert.equal(capturedEnvironment.ANTHROPIC_BASE_URL, 'https://user:password@api.example.test:8443/private/path?token=synthetic-query-secret');
  assert.equal('AWS_SECRET_ACCESS_KEY' in capturedEnvironment, false);
});

test('authorization callback errors fail closed and expose only a stable error code', async (t) => {
  const f = await fixture({ authorize: () => { throw new Error('private authorization detail'); } });
  t.after(f.dispose);
  await assert.rejects(f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'fixture prompt' }), (error) => error.code === 'authorization_failed' && !error.message.includes('private'));
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
  await assert.rejects(f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'fixture prompt' }), (error) => error.code === 'executable_unavailable');
  assert.equal(authorized, false);
  assert.equal(spawned, false);
});

test('unknown provider, malformed argv, NUL and oversized argv are rejected before spawn', async (t) => {
  let spawnCount = 0;
  const f = await fixture({ spawnImpl: () => { spawnCount++; return new FakeChild(); } });
  t.after(f.dispose);
  for (const input of [
    { provider: 'gemini', cwd: f.cwd },
    { provider: 'claude', cwd: f.cwd, prompt: ['bad\0arg'] },
    { provider: 'claude', cwd: f.cwd, prompt: ['x'.repeat(33 * 1024)] },
    { provider: 'claude', cwd: f.cwd, prompt: ['valid', 42] },
    { provider: 'claude', cwd: f.cwd, args: ['raw argv is not accepted'] },
  ]) await assert.rejects(f.gateway.start(input), GatewayError);
  assert.equal(spawnCount, 0);
});

test('cwd must be an existing canonical directory contained by an allowed root', async (t) => {
  const f = await fixture({ spawnImpl: () => new FakeChild() });
  t.after(f.dispose);
  await assert.rejects(f.gateway.start({ provider: 'claude', cwd: os.tmpdir(), prompt: 'fixture' }), (error) => error.code === 'cwd_not_allowed');
  await assert.rejects(f.gateway.start({ provider: 'claude', cwd: path.join(f.root, 'missing'), prompt: 'fixture' }), (error) => error.code === 'cwd_not_allowed');
  const link = path.join(f.root, 'escape');
  try {
    await symlink(os.tmpdir(), link, 'junction');
    await assert.rejects(f.gateway.start({ provider: 'claude', cwd: link, prompt: 'fixture' }), (error) => error.code === 'cwd_not_allowed');
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
    await f.gateway.start({ provider: 'codex', cwd: f.cwd, prompt: ['--help'] });
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
  const first = f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'fixture' });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.gateway.start({ provider: 'codex', cwd: f.cwd, prompt: 'fixture' }), (error) => error.code === 'capacity');
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
    const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: [secret] });
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

test('Gateway lifecycle subscriptions publish immutable events and unsubscribe idempotently', async (t) => {
  const children = [];
  const f = await fixture({ spawnImpl: () => { const child = new FakeChild(); children.push(child); return child; } });
  t.after(f.dispose);
  const observed = [];
  const unsubscribe = f.gateway.subscribeEvents((event) => observed.push(event));
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'subscription fixture' });
  children[0].emit('spawn');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].runId, run.id);
  assert.equal(observed[0].type, 'started');
  assert.equal(Object.isFrozen(observed[0]), true);
  assert.throws(() => { observed[0].type = 'tampered'; }, TypeError);
  assert.equal(unsubscribe(), true);
  assert.equal(unsubscribe(), false);
  children[0].emit('close', 0, null);
  assert.equal(observed.length, 1);
  assert.deepEqual(f.gateway.events().map((event) => event.type), ['started', 'exited']);
});

test('Gateway lifecycle subscriptions are bounded and observer failures cannot interrupt runs', async (t) => {
  const children = [];
  const f = await fixture({ spawnImpl: () => { const child = new FakeChild(); children.push(child); return child; } });
  t.after(f.dispose);
  let observed = 0;
  const unsubscribers = Array.from({ length: 6 }, () => f.gateway.subscribeEvents(() => { observed++; }));
  unsubscribers.push(f.gateway.subscribeEvents(() => { throw new Error('observer_failure'); }));
  unsubscribers.push(f.gateway.subscribeEvents(async () => { throw new Error('async_observer_failure'); }));
  assert.throws(() => f.gateway.subscribeEvents(() => {}), { name: 'RangeError', message: 'event_listener_capacity' });
  const unsubscribe = unsubscribers.pop();
  assert.equal(unsubscribe(), true);
  assert.equal(unsubscribe(), false);
  unsubscribers.push(f.gateway.subscribeEvents(() => { observed++; }));

  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'bounded subscription fixture' });
  assert.doesNotThrow(() => children[0].emit('spawn'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.gateway.get(run.id).status, 'running');
  assert.equal(observed, 7);
  await Promise.all(unsubscribers.map((remove) => remove()));
});

test('run duration timeout requests stop and repeated stop is idempotent', async (t) => {
  const f = await fixture({
    runTimeoutMs: 30,
    spawnImpl: () => { const child = new FakeChild(); queueMicrotask(() => child.emit('spawn')); return child; },
    signalTreeImpl: (_pid, signal, child) => child.kill(signal),
  });
  t.after(f.dispose);
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'fixture' });
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
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'fixture' });
  await waitFor(() => f.gateway.get(run.id).status === 'failed');
  assert.equal(f.gateway.get(run.id).treeStopConfirmed, false);
  assert.deepEqual(f.gateway.events().map((event) => event.type), ['started', 'stop_requested', 'stop_failed', 'failed']);
  assert.deepEqual(await f.gateway.close({ timeoutMs: 10 }), [run.id]);
});

test('supervised stop records Guardian tree confirmation instead of pipe acceptance', async (t) => {
  const child = new FakeChild();
  child.pid = 424243;
  child.supervised = true;
  child.stopTree = async () => ({ treeConfirmed: false });
  const f = await fixture({ spawnImpl: () => { queueMicrotask(() => child.emit('spawn')); return child; } });
  t.after(f.dispose);
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'fixture' });
  await waitFor(() => f.gateway.get(run.id).status === 'running');
  await f.gateway.stop(run.id);
  assert.equal(f.gateway.get(run.id).treeStopConfirmed, false);
  child.signalCode = 'SIGKILL';
  child.emit('close', null, 'SIGKILL');
  await waitFor(() => f.gateway.get(run.id).status === 'failed');
});

test('supervised stop falls back to the OS process-tree adapter when the Guardian channel fails', async (t) => {
  const child = new FakeChild();
  child.pid = 424244;
  child.supervised = true;
  child.stopTree = async () => { throw new Error('guardian_channel_unavailable'); };
  let fallbackRequest;
  const f = await fixture({
    spawnImpl: () => { queueMicrotask(() => child.emit('spawn')); return child; },
    signalTreeFallbackImpl: async (pid, signal, target) => {
      fallbackRequest = { pid, signal, target };
      target.signalCode = signal;
      queueMicrotask(() => target.emit('close', null, signal));
    },
  });
  t.after(f.dispose);
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'fixture' });
  await waitFor(() => f.gateway.get(run.id).status === 'running');

  await f.gateway.stop(run.id);
  await waitFor(() => f.gateway.get(run.id).status === 'stopped');
  assert.equal(fallbackRequest.pid, child.pid);
  assert.equal(fallbackRequest.signal, 'SIGTERM');
  assert.equal(fallbackRequest.target, child);
  assert.equal(f.gateway.get(run.id).treeStopConfirmed, true);
});

test('failed Guardian and OS stop paths remain explicitly unconfirmed', async (t) => {
  const child = new FakeChild();
  child.pid = 424245;
  child.supervised = true;
  child.stopTree = async () => { throw new Error('guardian_channel_unavailable'); };
  const f = await fixture({
    spawnImpl: () => { queueMicrotask(() => child.emit('spawn')); return child; },
    signalTreeFallbackImpl: async () => { throw new Error('os_tree_stop_failed'); },
  });
  t.after(f.dispose);
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'fixture' });
  await waitFor(() => f.gateway.get(run.id).status === 'running');

  await f.gateway.stop(run.id);
  await waitFor(() => f.gateway.get(run.id).status === 'failed');
  assert.equal(f.gateway.get(run.id).treeStopConfirmed, false);
  assert.ok(f.gateway.events().some((event) => event.type === 'stop_failed'));
});

test('supervised stop avoids OS PID fallback after the Guardian reports provider exit', async (t) => {
  const child = new FakeChild();
  child.pid = 424246;
  child.supervised = true;
  child.stopTree = async () => { child.exitCode = 0; throw new Error('guardian_ack_lost'); };
  let fallbackCalled = false;
  const f = await fixture({
    spawnImpl: () => { queueMicrotask(() => child.emit('spawn')); return child; },
    signalTreeFallbackImpl: async () => { fallbackCalled = true; },
  });
  t.after(f.dispose);
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'fixture' });
  await waitFor(() => f.gateway.get(run.id).status === 'running');

  await f.gateway.stop(run.id);
  await waitFor(() => f.gateway.get(run.id).status === 'failed');
  assert.equal(fallbackCalled, false);
  assert.equal(f.gateway.get(run.id).treeStopConfirmed, false);
});

test('manual stop requires separate authorization; denied stop leaves the run active', async (t) => {
  const f = await fixture({
    authorize: async ({ action }) => action !== 'stop',
    spawnImpl: () => { const child = new FakeChild(); queueMicrotask(() => child.emit('spawn')); return child; },
  });
  t.after(f.dispose);
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'fixture' });
  await waitFor(() => f.gateway.get(run.id).status === 'running');
  await assert.rejects(f.gateway.stop(run.id), (error) => error.code === 'confirmation_required');
  assert.equal(f.gateway.get(run.id).status, 'running');
});

test('follow-up input requires exact host approval, serializes requests, and emits no content', async (t) => {
  const approvals = [];
  const writes = [];
  let inputAllowed = true;
  let releaseApproval;
  const gate = new Promise((resolve) => { releaseApproval = resolve; });
  const f = await fixture({
    authorize: async (request) => {
      approvals.push(request);
      if (request.action === 'input' && approvals.filter((item) => item.action === 'input').length === 1) await gate;
      return request.action !== 'input' || inputAllowed;
    },
    buildLaunchImpl: (_provider, profile, prompt) => ({ profile, args: [], inputMode: 'claude-stream-json', initialInput: prompt }),
    spawnImpl: () => {
      const child = new FakeChild();
      child.writeInput = async (text) => { writes.push(text); };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  t.after(f.dispose);
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'initial task', profile: RUNTIME_PROFILES.readOnlyStreaming });
  await waitFor(() => f.gateway.get(run.id).status === 'running');
  const sending = f.gateway.sendInput(run.id, 'private follow-up');
  await waitFor(() => approvals.filter((item) => item.action === 'input').length === 1);
  await assert.rejects(f.gateway.sendInput(run.id, 'concurrent follow-up'), (error) => error.code === 'input_busy');
  assert.equal(approvals.find((item) => item.action === 'input').text, 'ALBERA follow-up:\nprivate follow-up');
  releaseApproval();
  await sending;
  assert.deepEqual(writes, ['ALBERA follow-up:\nprivate follow-up']);
  const events = JSON.stringify(f.gateway.events());
  assert.match(events, /input_sent/);
  assert.equal(events.includes('private follow-up'), false);
  assert.equal(JSON.stringify(f.gateway.list()).includes('private follow-up'), false);
  inputAllowed = false;
  await assert.rejects(f.gateway.sendInput(run.id, 'denied private text'), (error) => error.code === 'confirmation_required');
  assert.deepEqual(writes, ['ALBERA follow-up:\nprivate follow-up']);
});

test('streaming input transport works with a synthetic helper process and no AI CLI', async (t) => {
  const f = await fixture({
    authorize: async () => true,
    buildLaunchImpl: (_provider, profile) => ({
      profile, args: ['-e', "import fs from 'node:fs';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>fs.appendFileSync(process.argv[1],d));setInterval(()=>{},1000);", path.join(f.root, 'inputs.jsonl')],
      inputMode: 'claude-stream-json', initialInput: 'ALBERA task:\nsynthetic initial',
    }),
  });
  t.after(f.dispose);
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'synthetic initial', profile: RUNTIME_PROFILES.readOnlyStreaming });
  await waitFor(() => f.gateway.get(run.id).status === 'running');
  await f.gateway.sendInput(run.id, 'synthetic second');
  const marker = path.join(f.root, 'inputs.jsonl');
  await waitFor(async () => {
    try { return (await readFile(marker, 'utf8')).trim().split('\n').length === 2; } catch { return false; }
  });
  const messages = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.message.content), ['ALBERA task:\nsynthetic initial', 'ALBERA follow-up:\nsynthetic second']);
  assert.ok(messages.every((message) => message.type === 'user' && message.parent_tool_use_id === null));
  await f.gateway.stop(run.id);
  await waitFor(() => f.gateway.get(run.id).status === 'stopped');
});

test('input approval cannot send after a concurrent stop changes the run state', async (t) => {
  let releaseApproval;
  let inputApprovalSeen;
  const approvalGate = new Promise((resolve) => { releaseApproval = resolve; });
  const inputSeen = new Promise((resolve) => { inputApprovalSeen = resolve; });
  const writes = [];
  const f = await fixture({
    authorize: async ({ action }) => {
      if (action === 'input') { inputApprovalSeen(); await approvalGate; }
      return true;
    },
    buildLaunchImpl: (_provider, profile) => ({ profile, args: [], inputMode: 'claude-stream-json', initialInput: 'ALBERA task:\nrace fixture' }),
    spawnImpl: () => {
      const child = new FakeChild();
      child.writeInput = async (text) => { writes.push(text); };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  t.after(f.dispose);
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'race fixture', profile: RUNTIME_PROFILES.readOnlyStreaming });
  await waitFor(() => f.gateway.get(run.id).status === 'running');
  const sending = f.gateway.sendInput(run.id, 'must not arrive after stop');
  await inputSeen;
  await f.gateway.stop(run.id);
  releaseApproval();
  await assert.rejects(sending, (error) => error.code === 'input_not_ready');
  assert.deepEqual(writes, []);
  await waitFor(() => f.gateway.get(run.id).status === 'stopped');
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
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'fixture' });
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
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: ['-e', 'setInterval(() => {}, 1000)'] });
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
  const run = await f.gateway.start({ provider: 'codex', cwd: f.cwd, prompt: ['-e', 'process.exit(7)'] });
  await waitFor(() => f.gateway.get(run.id).status === 'exited');
  assert.equal(f.gateway.get(run.id).exitCode, 7);
  assert.deepEqual(f.gateway.events().map((event) => event.type), ['started', 'exited']);
  assert.ok(!JSON.stringify(f.gateway.events()).includes('process.exit'));
});

test('local helper process integration: OS tree fallback stops a child when the Guardian channel fails', async (t) => {
  let child;
  const f = await fixture({
    spawnImpl: (executable, args, options) => {
      child = spawn(executable, args, {
        cwd: options.cwd, env: options.env, shell: false,
        detached: process.platform !== 'win32', windowsHide: true, stdio: 'ignore',
      });
      child.supervised = true;
      child.stopTree = async () => { throw new Error('synthetic_guardian_channel_failure'); };
      return child;
    },
  });
  t.after(async () => {
    await f.dispose();
    if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL');
  });
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: ['-e', 'setInterval(() => {}, 1000)'] });
  await waitFor(() => f.gateway.get(run.id).status === 'running');

  await f.gateway.stop(run.id);
  await waitFor(() => f.gateway.get(run.id).status === 'stopped');
  assert.equal(f.gateway.get(run.id).treeStopConfirmed, true);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('orderly host close stops active children even when interactive stop approval is denied', async (t) => {
  const f = await fixture({
    authorize: async ({ action }) => action === 'start',
    resolveExecutableImpl: async () => process.execPath,
  });
  t.after(f.dispose);
  const run = await f.gateway.start({ provider: 'opencode', cwd: f.cwd, prompt: ['-e', 'setInterval(() => {}, 1000)'] });
  await waitFor(() => f.gateway.get(run.id).status === 'running');
  assert.deepEqual(await f.gateway.close({ timeoutMs: 5000 }), []);
  assert.equal(f.gateway.get(run.id).status, 'stopped');
});

test('orderly host close waits for the child close event after an early exit status', async (t) => {
  let child;
  const f = await fixture({
    spawnImpl: () => {
      child = new EventEmitter();
      child.pid = 12345;
      child.exitCode = null;
      child.signalCode = null;
      child.supervised = true;
      child.kill = () => true;
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    signalTreeImpl: async () => {
      child.exitCode = 0;
      setTimeout(() => child.emit('close', 0, null), 25);
      return { treeConfirmed: true };
    },
  });
  t.after(f.dispose);
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: ['-e', 'setInterval(() => {}, 1000)'] });
  await waitFor(() => f.gateway.get(run.id).status === 'running');

  assert.deepEqual(await f.gateway.close({ timeoutMs: 1000 }), []);
  assert.equal(f.gateway.get(run.id).status, 'stopped');
});

test('orderly close invalidates starts awaiting authorization and rejects starts after close', async (t) => {
  let releaseApproval;
  let approvalSeen;
  let spawnCount = 0;
  const approvalGate = new Promise((resolve) => { releaseApproval = resolve; });
  const f = await fixture({
    authorize: async ({ action }) => {
      if (action === 'start') { approvalSeen = true; await approvalGate; }
      return true;
    },
    spawnImpl: () => { spawnCount++; return new FakeChild(); },
  });
  t.after(f.dispose);

  const startResult = f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: ['--print', 'synthetic prompt'] })
    .then((value) => ({ value }), (error) => ({ error }));
  await waitFor(() => approvalSeen);
  assert.deepEqual(await f.gateway.close({ timeoutMs: 10 }), []);
  releaseApproval();
  const outcome = await startResult;
  assert.equal(outcome.error.code, 'gateway_closed');
  assert.equal(spawnCount, 0);
  await assert.rejects(
    f.gateway.start({ provider: 'codex', cwd: f.cwd, prompt: [] }),
    (error) => error.code === 'gateway_closed',
  );
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
  const run = await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: ['-e', parentCode] });
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
