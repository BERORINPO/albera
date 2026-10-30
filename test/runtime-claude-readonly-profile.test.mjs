// Issue #35: repo-supplied hooks / MCP servers / apiKeyHelper must not run under the read-only Claude profiles.
// Evidence for the flag set: docs/claude-cli-readonly-profile-verification.md
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { buildProviderLaunch, RuntimeGateway, RUNTIME_PROFILES } from '../src/runtime/gateway.mjs';
import { PROFILE_MINIMUM_VERSIONS, VERIFIED_CLAUDE_CLI_VERSION } from '../src/runtime/profile-policy.mjs';

const PROFILES = [RUNTIME_PROFILES.readOnly, RUNTIME_PROFILES.readOnlyStreaming];
// Every option the launch may contain was run against the real CLI (2.1.310).
const VERIFIED_FLAGS = new Set([
  '--restricted', '--safe-mode', '--strict-mcp-config', '--disallowedTools', '--permission-mode', '--permission-prompts',
  '--print', '--max-turns', '--no-session-persistence', '--input-format', '--output-format',
]);
const CONFIG_LOADING_FLAGS = ['--mcp-config', '--settings', '--setting-sources', '--add-dir', '--plugin-dir', '--agents', '--bare', '--allowedTools', '--tools', '--dangerously-skip-permissions'];

class FakeChild extends EventEmitter {
  kill() { queueMicrotask(() => this.emit('close', null, 'SIGKILL')); return true; }
}

async function gatewayFixture(options) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-claude-profile-'));
  const cwd = path.join(root, 'project');
  await mkdir(cwd);
  const executable = path.join(root, `provider${process.platform === 'win32' ? '.exe' : ''}`);
  await writeFile(executable, 'synthetic provider executable fixture');
  await chmod(executable, 0o700);
  const gateway = new RuntimeGateway({
    roots: [root],
    authorize: async () => true,
    resolveExecutableImpl: async () => executable,
    buildLaunchImpl: (provider, profile, prompt) => buildProviderLaunch(provider, prompt, profile),
    ...options,
  });
  return { cwd, gateway, dispose: async () => { await gateway.close({ timeoutMs: 100 }); await rm(root, { recursive: true, force: true }); } };
}

test('Claude read-only profiles layer settings, hook and MCP isolation and pass no config-loading flags', () => {
  for (const profile of PROFILES) {
    const { args } = buildProviderLaunch('claude', 'task', profile);
    for (const flag of ['--restricted', '--safe-mode', '--strict-mcp-config']) assert.ok(args.includes(flag), `${profile} lacks ${flag}`);
    // --disallowedTools is variadic: a flag placed after it would be swallowed as a tool name.
    assert.ok(args.indexOf('--strict-mcp-config') < args.indexOf('--disallowedTools'));
    for (const flag of CONFIG_LOADING_FLAGS) assert.equal(args.includes(flag), false, `${profile} must not pass ${flag}`);
    const options = args.filter((arg) => arg.startsWith('--') && !arg.startsWith('ALBERA'));
    for (const flag of options) assert.ok(VERIFIED_FLAGS.has(flag), `unverified flag ${flag}`);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  }
});

test('the version floor equals the verified version for both profiles', () => {
  assert.deepEqual({ ...PROFILE_MINIMUM_VERSIONS }, { 'read-only': VERIFIED_CLAUDE_CLI_VERSION, 'read-only-streaming': VERIFIED_CLAUDE_CLI_VERSION });
  assert.equal(VERIFIED_CLAUDE_CLI_VERSION, '2.1.310');
});

test('Gateway fails closed before spawn when the Claude CLI version is below the verified floor, unknown or unreadable', async (t) => {
  const probes = [async () => '2.1.309', async () => '2.0.999', async () => '', async () => 'unknown', async () => { throw new Error('probe failed'); }];
  for (const profile of PROFILES) {
    for (const probeVersionImpl of probes) {
      let spawned = 0;
      const f = await gatewayFixture({ probeVersionImpl, spawnImpl: () => { spawned++; return new FakeChild(); } });
      t.after(f.dispose);
      await assert.rejects(f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'synthetic', profile }), (error) => error.code === 'cli_version_unavailable');
      assert.equal(spawned, 0);
    }
  }
});

test('Gateway starts the Claude profiles at the verified version with the isolation flags in the spawned argv', async (t) => {
  for (const profile of PROFILES) {
    let spawnedArgs;
    const f = await gatewayFixture({ probeVersionImpl: async () => '2.1.310', spawnImpl: (_executable, args) => { spawnedArgs = args; return new FakeChild(); } });
    t.after(f.dispose);
    await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'synthetic', profile });
    for (const flag of ['--restricted', '--safe-mode', '--strict-mcp-config']) assert.ok(spawnedArgs.includes(flag));
  }
});

test('approval summary names config-location variables for Claude without exposing their values', async (t) => {
  let seen;
  const privateDir = 'C:\\Users\\synthetic-private-user\\.claude-alt';
  const f = await gatewayFixture({
    probeVersionImpl: async () => '2.1.310',
    env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: privateDir, HOME: '/home/synthetic-home', XDG_CONFIG_HOME: '/synthetic/xdg', ANTHROPIC_API_KEY: 'synthetic-key-value', CLAUDE_CODE_OAUTH_TOKEN: 'not-forwarded' },
    authorize: async (request) => { seen = request; return true; },
    spawnImpl: () => new FakeChild(),
  });
  t.after(f.dispose);
  await f.gateway.start({ provider: 'claude', cwd: f.cwd, prompt: 'synthetic' });
  assert.deepEqual(seen.environment.providerVariables, ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'HOME', 'XDG_CONFIG_HOME']);
  const serialized = JSON.stringify(seen.environment);
  for (const value of [privateDir, 'synthetic-home', '/synthetic/xdg', 'synthetic-key-value', 'not-forwarded']) assert.equal(serialized.includes(value), false);
});

// Opt-in contract test against the real CLI. It makes ONE paid one-word call, so it never runs by default.
const realContract = process.env.ALBERA_REAL_CLAUDE_CONTRACT === '1' ? {} : { skip: 'set ALBERA_REAL_CLAUDE_CONTRACT=1 to run the real Claude CLI (one paid one-word call)' };
test('real Claude CLI does not run repo-supplied hooks, MCP servers or apiKeyHelper under the read-only profile', realContract, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'albera-claude-contract-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, '.claude'));
  await writeFile(path.join(dir, 'marker.js'), "require('fs').writeFileSync(require('path').join(__dirname, process.argv[2] + '.marker'), 'ran');\n");
  const hook = (name) => [{ hooks: [{ type: 'command', command: `node marker.js ${name}` }] }];
  await writeFile(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
    apiKeyHelper: 'node marker.js apikeyhelper',
    hooks: { SessionStart: hook('hook-sessionstart'), UserPromptSubmit: hook('hook-userprompt'), Stop: hook('hook-stop') },
  }));
  await writeFile(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { probe: { command: 'node', args: ['marker.js', 'mcp'] } } }));
  const { args } = buildProviderLaunch('claude', 'Reply with the single word: ok');
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: dir, env: process.env, shell: false, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(exitCode, 0);
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.marker')), []);
});
