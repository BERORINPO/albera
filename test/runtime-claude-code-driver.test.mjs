import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildClaudeArgs, buildClaudeEnvironment, CLAUDE_ALLOWED_TOOLS, CLAUDE_DISALLOWED_TOOLS, createClaudeCodeDriver, HANDS_SYSTEM_PROMPT, MCP_CONFIG_FILE,
} from '../src/runtime/claude-code-driver.mjs';

// The driver against the Fake claude (src/runtime/fake-claude-code.mjs): REAL child processes (node as the "claude" executable, the real MCP server module with the Fake desktop client as its
// grandchild), no real claude, no token that means anything, no VM. What these prove is the driver's own behavior and process handling; they say nothing about Claude Code itself.
const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.resolve(here, '../src/runtime/fake-claude-code.mjs');
const MCP_ENTRY = path.resolve(here, '../src/runtime/fake-albera-desktop-mcp-main.mjs');
const TOKEN = `sk-test-${'t0k3n'.repeat(8)}`;
const roots = [];
process.on('exit', () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function workspace(script) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'albera-cc-')));
  roots.push(base);
  const workDir = path.join(base, 'work');
  const configDir = path.join(base, 'config');
  mkdirSync(workDir);
  mkdirSync(configDir);
  const recordTo = path.join(base, 'record.json');
  const scriptFile = path.join(base, 'script.json');
  writeFileSync(scriptFile, JSON.stringify({ recordTo, ...script }));
  return { base, workDir, configDir, recordTo, scriptFile, calls: () => readLines(path.join(configDir, 'tmp', 'mcp-calls.jsonl')), record: () => JSON.parse(readFileSync(recordTo, 'utf8')) };
}

function readLines(file) {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

function driverOptions(ws, overrides = {}) {
  return {
    executable: process.execPath, executableArgs: [FAKE_CLAUDE, ws.scriptFile], task: 'Open Notepad and type hello', oauthToken: TOKEN, workDir: ws.workDir, configDir: ws.configDir,
    mcpServer: { command: process.execPath, args: [MCP_ENTRY, '--computer', 'computer-1', '--operation', 'op-1', '--screen', '128x96'] },
    limits: { maxMs: 30_000, maxToolCalls: 10 }, exitGraceMs: 3000,
    io: { exists: async () => false }, // the real home has a CLAUDE.md above the temp folder; the ancestor check has its own test
    ...overrides,
  };
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function gone(pid, ms = 5000) {
  for (let waited = 0; waited < ms; waited += 50) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  return false;
}

// ---- command line and environment ----

test('launch: the measured flags, the tool lists, no secret in argv, and nothing that skips a permission', () => {
  const args = buildClaudeArgs({ mcpConfigPath: 'C:\\c\\albera-mcp.json', model: 'claude-haiku-5-5' });
  assert.deepEqual(args.slice(0, 11), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--mcp-config']);
  assert.equal(args[11], 'C:\\c\\albera-mcp.json');
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  assert.deepEqual(allowed, ['mcp__albera_desktop__screenshot', 'mcp__albera_desktop__click', 'mcp__albera_desktop__move', 'mcp__albera_desktop__key', 'mcp__albera_desktop__type', 'mcp__albera_desktop__scroll']);
  assert.deepEqual(allowed, [...CLAUDE_ALLOWED_TOOLS]);
  assert.deepEqual(args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--model')), [...CLAUDE_DISALLOWED_TOOLS]);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--model') + 1], 'claude-haiku-5-5');
  assert.equal(args.at(-2), '--append-system-prompt');
  assert.equal(args.at(-1), HANDS_SYSTEM_PROMPT);
  for (const bad of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--bare', '--add-dir']) assert.ok(!args.includes(bad), bad);
  assert.ok(!buildClaudeArgs({ mcpConfigPath: 'x' }).includes('--model'));
  for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite']) assert.ok(CLAUDE_DISALLOWED_TOOLS.includes(tool), tool);
});

test('launch: the environment is an allowlist; HOME, USERPROFILE and CLAUDE_CONFIG_DIR are the empty config folder', () => {
  const env = buildClaudeEnvironment({ oauthToken: TOKEN, configDir: 'C:\\cfg', tempDir: 'C:\\cfg\\tmp', platform: 'win32', systemRoot: 'C:\\Windows' });
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']);
  assert.equal(`${env.HOMEDRIVE}${env.HOMEPATH}`, 'C:\\cfg', 'HOMEDRIVE + HOMEPATH is the config folder, not the real profile');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.deepEqual([env.HOME, env.USERPROFILE, env.CLAUDE_CONFIG_DIR], ['C:\\cfg', 'C:\\cfg', 'C:\\cfg']);
  assert.equal(env.PATH, 'C:\\Windows\\System32;C:\\Windows');
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  assert.ok(!('SystemRoot' in buildClaudeEnvironment({ oauthToken: TOKEN, configDir: '/c', tempDir: '/c/tmp', platform: 'linux', systemRoot: '/x' })));
});

test('options: relative paths, a missing or odd token, bad limits and a bad model are refused with a fixed message that holds no value', () => {
  const ws = workspace({ steps: [] });
  const good = driverOptions(ws);
  assert.doesNotThrow(() => createClaudeCodeDriver(good));
  const bad = [
    { executable: 'claude.exe' }, { executableArgs: [1] }, { executableSha256: 'abc' }, { task: '' }, { task: 'a\0b' }, { task: 'x'.repeat(17 * 1024) }, { oauthToken: undefined }, { oauthToken: 'short' },
    { oauthToken: `${TOKEN} with space` }, { oauthToken: `${TOKEN}\n` }, { workDir: 'relative' }, { configDir: `${ws.base}${path.sep}a${path.sep}..${path.sep}config` }, { mcpServer: { command: 'node', args: [] } },
    { mcpServer: { command: process.execPath, args: 'x' } }, { limits: { maxMs: 0, maxToolCalls: 5 } }, { limits: { maxMs: 5000, maxToolCalls: 0 } }, { limits: { maxMs: 5000, maxToolCalls: 5000 } },
    { limits: { maxMs: 99, maxToolCalls: 5 } }, { limits: undefined }, { model: 'bad model!' }, { exitGraceMs: 1 },
  ];
  for (const override of bad) {
    assert.throws(() => createClaudeCodeDriver({ ...good, ...override }), (error) => error instanceof TypeError && error.message === 'invalid_claude_code_driver_options' && !error.message.includes(TOKEN), JSON.stringify(Object.keys(override)));
  }
});

// ---- a whole run ----

test('run: DONE claim end to end - argv and environment seen by the child, the MCP config, the calls that reached the Broker, the counts', async () => {
  const ws = workspace({ steps: [{ say: 'Looking at the screen' }, { tool: 'screenshot' }, { tool: 'click', input: { coordinate: [5, 6] } }, { tool: 'key', input: { key: 'return' } }, { result: 'DONE: notepad is open' }] });
  const events = [];
  const parentEnv = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN, SECRET_PARENT_VALUE: process.env.SECRET_PARENT_VALUE };
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'parent-api-key', ANTHROPIC_AUTH_TOKEN: 'parent-auth-token', SECRET_PARENT_VALUE: 'parent-secret' });
  let result;
  try { result = await createClaudeCodeDriver(driverOptions(ws, { model: 'claude-haiku-5-5', onEvent: (e) => events.push(e) })).run(); }
  finally { for (const [key, value] of Object.entries(parentEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }

  assert.equal(result.outcome, 'claimed_done');
  assert.equal(result.reason, 'end_turn');
  assert.equal(result.claim, 'DONE: notepad is open');
  assert.equal(result.toolCalls, 3);
  assert.deepEqual(result.byTool, { screenshot: 1, click: 1, key: 1 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.treeStopConfirmed, null, 'a child that ended by itself needed no kill');
  assert.deepEqual(events.map((e) => e.type), ['start', 'tool_call', 'tool_call', 'tool_call', 'end']);

  const record = ws.record();
  assert.deepEqual(record.argv, buildClaudeArgs({ mcpConfigPath: path.join(ws.configDir, MCP_CONFIG_FILE), model: 'claude-haiku-5-5' }));
  assert.equal(record.argv[record.argv.indexOf('--setting-sources') + 1], '', 'the empty --setting-sources value survives process creation');
  assert.equal(record.cwd, ws.workDir);
  assert.equal(record.task, 'Open Notepad and type hello');
  assert.equal(record.env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.equal(record.env.HOME, ws.configDir);
  assert.equal(record.env.USERPROFILE, ws.configDir);
  assert.equal(record.env.CLAUDE_CONFIG_DIR, ws.configDir);
  const allowedKeys = new Set(Object.keys(buildClaudeEnvironment({ oauthToken: TOKEN, configDir: 'c', tempDir: 't', platform: process.platform, systemRoot: 'r' })).map((k) => k.toUpperCase()));
  // Windows adds these itself to any child (see buildClaudeEnvironment); none holds a path into the owner's profile except HOMEDRIVE/HOMEPATH, which the driver overrides.
  const addedByWindows = process.platform === 'win32' ? ['LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME', 'WINDIR'] : [];
  for (const key of Object.keys(record.env)) assert.ok(allowedKeys.has(key.toUpperCase()) || addedByWindows.includes(key.toUpperCase()), `unexpected variable ${key}`);
  if (process.platform === 'win32') assert.equal(`${record.env.HOMEDRIVE}${record.env.HOMEPATH}`, ws.configDir);
  assert.ok(!JSON.stringify(record.argv).includes(TOKEN), 'the token is not on the command line');

  const config = JSON.parse(readFileSync(path.join(ws.configDir, MCP_CONFIG_FILE), 'utf8'));
  assert.deepEqual(Object.keys(config.mcpServers), ['albera_desktop']);
  const server = config.mcpServers.albera_desktop;
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args.slice(-4, -2), ['--max-calls', '10']);
  assert.ok(Number(server.args.at(-1)) > Date.now() - 1000, '--expires-at is an epoch ms');
  assert.ok(!readFileSync(path.join(ws.configDir, MCP_CONFIG_FILE), 'utf8').includes(TOKEN), 'the MCP server gets no token from the config');
  assert.deepEqual(Object.keys(server.env).sort(), process.platform === 'win32' ? ['PATH', 'SystemRoot', 'TEMP', 'TMP'] : ['PATH', 'TEMP', 'TMP']);

  const calls = ws.calls();
  assert.deepEqual(calls[0], { capture: { vmId: 'computer-1', width: 128, height: 96 } });
  assert.deepEqual(calls[1].input, { vmId: 'computer-1', action: { action: 'left_click', coordinate: [5, 6] }, lease: { desktopSessionId: 'op-1' } });
  assert.deepEqual(calls[2].input.action, { action: 'key', key: 'return' });
  const shot = record.toolResults[0].content[0];
  assert.deepEqual([shot.type, shot.mimeType], ['image', 'image/png']);
  assert.ok(await gone(record.mcpPid), 'the MCP server ended with the run');
});

test('run: the child never sees this process\'s environment, and the token is nowhere in the result or the events', async () => {
  const ws = workspace({ steps: [{ sayEnv: 'CLAUDE_CODE_OAUTH_TOKEN' }, { result: `DONE with ${TOKEN} inside` }] });
  const events = [];
  process.env.ANTHROPIC_API_KEY = 'parent-api-key';
  let result;
  try { result = await createClaudeCodeDriver(driverOptions(ws, { onEvent: (e) => events.push(e) })).run(); }
  finally { delete process.env.ANTHROPIC_API_KEY; }
  assert.ok(!('ANTHROPIC_API_KEY' in ws.record().env));
  assert.equal(result.outcome, 'claimed_done');
  assert.match(result.claim, /\[redacted\]/u);
  assert.ok(!JSON.stringify([result, events]).includes(TOKEN));
});

test('run: FAILED, and anything that does not start with DONE, are claimed_failed; a claude error result is an error with its subtype', async () => {
  const cases = [
    [{ result: 'FAILED: no Notepad icon' }, 'claimed_failed', 'end_turn', 'FAILED: no Notepad icon'],
    [{ result: 'I finished' }, 'claimed_failed', 'end_turn', 'I finished'],
    [{ result: 'DONE\r\nline two' }, 'claimed_done', 'end_turn', 'DONE line two'],
    [{ result: 'boom', isError: true, subtype: 'error_during_execution' }, 'error', 'claude_error_during_execution', 'boom'],
  ];
  for (const [step, outcome, reason, claim] of cases) {
    const result = await createClaudeCodeDriver(driverOptions(workspace({ steps: [step] }))).run();
    assert.deepEqual([result.outcome, result.reason, result.claim], [outcome, reason, claim]);
  }
});

test('run: a child that exits without a result is an error with its exit code; a line that is not JSON is ignored', async () => {
  const result = await createClaudeCodeDriver(driverOptions(workspace({ steps: [{ rawLine: 'warning: not json' }, { tool: 'screenshot' }, { exit: 3 }] }))).run();
  assert.deepEqual([result.outcome, result.reason, result.exitCode, result.toolCalls], ['error', 'exited_without_result', 3, 1]);
});

test('run: a child that keeps running after its result is stopped by the grace timer, and the claim stands', async () => {
  const ws = workspace({ steps: [{ result: 'DONE: x', linger: true }] });
  const result = await createClaudeCodeDriver(driverOptions(ws, { exitGraceMs: 300 })).run();
  assert.deepEqual([result.outcome, result.claim], ['claimed_done', 'DONE: x']);
  assert.equal(typeof result.treeStopConfirmed, 'boolean', 'the kill was needed and asked for');
  assert.ok(await gone(ws.record().mcpPid), 'the MCP grandchild is gone too');
});

// ---- limits and stops ----

test('limit: tool calls - the call after the last allowed one ends the run, the whole tree is gone, nothing more reaches the Broker', async () => {
  const ws = workspace({ steps: [{ tool: 'screenshot' }, { tool: 'screenshot' }, { tool: 'key', input: { key: 'return' } }, { hang: true }] });
  const events = [];
  const result = await createClaudeCodeDriver(driverOptions(ws, { limits: { maxMs: 30_000, maxToolCalls: 2 }, onEvent: (e) => events.push(e) })).run();
  assert.deepEqual([result.outcome, result.reason], ['limit_reached', 'max_tool_calls']);
  assert.equal(result.toolCalls, 3, 'tool_use requests seen, the over-limit one included');
  assert.equal(typeof result.treeStopConfirmed, 'boolean');
  const pid = events.find((e) => e.type === 'start').pid;
  assert.ok(await gone(pid), 'claude is gone');
  assert.ok(await gone(ws.record().mcpPid), 'the MCP server is gone');
  assert.equal(ws.calls().filter((c) => c.input).length, 0, 'the MCP server\'s own budget refused the third call too');
});

test('limit: time - a child that never finishes is stopped at maxMs', async () => {
  const ws = workspace({ steps: [{ tool: 'screenshot' }, { hang: true }] });
  const started = Date.now();
  const result = await createClaudeCodeDriver(driverOptions(ws, { limits: { maxMs: 1500, maxToolCalls: 10 } })).run();
  assert.deepEqual([result.outcome, result.reason], ['limit_reached', 'max_ms']);
  assert.ok(Date.now() - started < 15_000);
  assert.ok(result.ms >= 1400);
  assert.ok(await gone(ws.record().mcpPid));
});

test('stop: a person\'s stop() ends the run with that reason; a second stop and a stop after the end do nothing more', async () => {
  const ws = workspace({ steps: [{ tool: 'screenshot' }, { hang: true }] });
  const killed = [];
  const events = [];
  const driver = createClaudeCodeDriver(driverOptions(ws, {
    onEvent: (e) => { events.push(e); if (e.type === 'tool_call') { driver.stop('operator'); driver.stop('second'); } },
    killTreeImpl: (child) => { killed.push(child.pid); return Promise.resolve(child.kill('SIGKILL')).then(() => ({ treeConfirmed: false })); },
  }));
  const result = await driver.run();
  assert.deepEqual([result.outcome, result.reason], ['stopped', 'operator']);
  assert.deepEqual(killed, [events.find((e) => e.type === 'start').pid], 'exactly the PID this driver started, once');
  driver.stop('late');
  assert.equal(killed.length, 1, 'a finished child is never signalled again (its PID may belong to someone else)');
});

test('stop: before run() nothing is started', async () => {
  const ws = workspace({ steps: [] });
  let spawned = 0;
  const driver = createClaudeCodeDriver(driverOptions(ws, { spawnImpl: () => { spawned += 1; throw new Error('must not start'); } }));
  driver.stop('operator');
  const result = await driver.run();
  assert.deepEqual([result.outcome, result.reason, spawned], ['stopped', 'operator', 0]);
});

test('stop: a stop that arrives during the preflight (hashing the executable takes seconds) is read again before the spawn - nothing is started', async () => {
  const ws = workspace({ steps: [{ result: 'DONE' }] });
  let spawned = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let inPreflight;
  const entered = new Promise((resolve) => { inPreflight = resolve; });
  const driver = createClaudeCodeDriver(driverOptions(ws, {
    spawnImpl: () => { spawned += 1; throw new Error('must not start'); },
    io: { exists: async () => false, readdir: async (dir) => { inPreflight(); await gate; return (await import('node:fs/promises')).readdir(dir); } },
  }));
  const running = driver.run();
  await entered; // run() is inside its checks and has not decided anything yet
  driver.stop('operator');
  release();
  const result = await running;
  assert.deepEqual([result.outcome, result.reason, spawned], ['stopped', 'operator', 0]);
});

test('run: a driver runs once', async () => {
  const ws = workspace({ steps: [{ result: 'DONE' }] });
  const driver = createClaudeCodeDriver(driverOptions(ws));
  await driver.run();
  await assert.rejects(driver.run(), /already_run/u);
});

// ---- the run is judged from what the stream says ----

test('stream: a tool the driver did not allow ends the run at once (unexpected_tool_use) and the tree is stopped', async () => {
  const ws = workspace({ steps: [{ toolRaw: 'Bash', input: { command: 'dir' } }, { hang: true }] });
  const result = await createClaudeCodeDriver(driverOptions(ws)).run();
  assert.deepEqual([result.outcome, result.reason, result.toolCalls], ['error', 'unexpected_tool_use', 0]);
  assert.ok(await gone(ws.record().mcpPid));
});

test('stream: the init is a self-check - a failed or missing albera_desktop server, any tool outside the six, or any other MCP server ends the run', async () => {
  const failed = workspace({ init: { mcp_servers: [{ name: 'albera_desktop', status: 'failed' }] }, steps: [{ hang: true }] });
  const a = await createClaudeCodeDriver(driverOptions(failed)).run();
  assert.deepEqual([a.outcome, a.reason], ['error', 'mcp_server_failed']);
  const absent = workspace({ init: { mcp_servers: [] }, steps: [{ hang: true }] });
  assert.equal((await createClaudeCodeDriver(driverOptions(absent)).run()).reason, 'mcp_server_failed');
  const extra = workspace({ init: { tools: ['mcp__albera_desktop__screenshot', 'Skill', 'ToolSearch'] }, steps: [{ tool: 'screenshot' }, { hang: true }] });
  const b = await createClaudeCodeDriver(driverOptions(extra)).run();
  assert.deepEqual([b.outcome, b.reason, b.unexpectedTools], ['error', 'unexpected_capability', ['Skill', 'ToolSearch']]);
  const odd = workspace({ init: { tools: ['mcp__albera_desktop__screenshot', 'bad name!', 7] }, steps: [{ hang: true }] });
  const c = await createClaudeCodeDriver(driverOptions(odd)).run();
  assert.deepEqual([c.reason, c.unexpectedTools], ['unexpected_capability', ['invalid_name', 'invalid_name']]);
  const otherServer = workspace({ init: { mcp_servers: [{ name: 'albera_desktop', status: 'connected' }, { name: 'github', status: 'connected' }] }, steps: [{ hang: true }] });
  assert.equal((await createClaudeCodeDriver(driverOptions(otherServer)).run()).reason, 'unexpected_capability');
  const onlyOther = workspace({ init: { mcp_servers: [{ name: 'github', status: 'connected' }] }, steps: [{ hang: true }] });
  assert.equal((await createClaudeCodeDriver(driverOptions(onlyOther)).run()).reason, 'unexpected_capability');
  const twice = workspace({ init: { mcp_servers: [{ name: 'albera_desktop', status: 'connected' }, { name: 'albera_desktop', status: 'connected' }] }, steps: [{ hang: true }] });
  assert.equal((await createClaudeCodeDriver(driverOptions(twice)).run()).reason, 'mcp_server_failed');
  // a subset of the six is fine
  const subset = workspace({ init: { tools: ['mcp__albera_desktop__screenshot', 'mcp__albera_desktop__click'] }, steps: [{ result: 'DONE' }] });
  const d = await createClaudeCodeDriver(driverOptions(subset)).run();
  assert.deepEqual([d.outcome, d.unexpectedTools], ['claimed_done', []]);
});

test('stream: a line longer than the limit ends the run (output_too_large)', async () => {
  const ws = workspace({ steps: [{ rawLine: 'x'.repeat(200_000) }, { hang: true }] });
  const result = await createClaudeCodeDriver(driverOptions(ws, { maxLineBytes: 64 * 1024 })).run();
  assert.deepEqual([result.outcome, result.reason], ['error', 'output_too_large']);
  assert.ok(await gone(ws.record().mcpPid));
});

test('stream: a repeated tool_use id is one call', async () => {
  const ws = workspace({ steps: [{ tool: 'screenshot' }, { result: 'DONE' }] });
  const driver = createClaudeCodeDriver(driverOptions(ws, { limits: { maxMs: 30_000, maxToolCalls: 1 } }));
  assert.equal((await driver.run()).toolCalls, 1);
});

// ---- before anything starts ----

test('preflight: each refusal is a fixed reason and nothing is started', async () => {
  let spawned = 0;
  const spawnImpl = () => { spawned += 1; throw new Error('must not start'); };
  const reason = async (ws, overrides) => (await createClaudeCodeDriver(driverOptions(ws, { spawnImpl, ...overrides })).run());

  const notEmpty = workspace({ steps: [] });
  writeFileSync(path.join(notEmpty.workDir, 'leftover.txt'), 'x');
  assert.deepEqual([(await reason(notEmpty)).outcome, (await reason(notEmpty)).reason], ['error', 'work_dir_not_empty']);

  const inherits = workspace({ steps: [] });
  const hit = path.join(inherits.base, 'CLAUDE.md');
  assert.equal((await reason(inherits, { io: { exists: async (file) => file === hit } })).reason, 'work_dir_inherits_instructions');
  const dotClaude = workspace({ steps: [] });
  const hit2 = path.join(dotClaude.base, '.claude', 'CLAUDE.md');
  assert.equal((await reason(dotClaude, { io: { exists: async (file) => file === hit2 } })).reason, 'work_dir_inherits_instructions');

  const homeClaude = workspace({ steps: [] });
  const claudeHome = path.join(homeClaude.base, 'home', '.claude');
  mkdirSync(claudeHome, { recursive: true });
  assert.equal((await reason(homeClaude, { configDir: claudeHome, io: { exists: async () => false, homedir: () => path.join(homeClaude.base, 'home') } })).reason, 'config_dir_invalid');

  const same = workspace({ steps: [] });
  assert.equal((await reason(same, { configDir: same.workDir })).reason, 'config_dir_invalid');
  const nested = workspace({ steps: [] });
  mkdirSync(path.join(nested.configDir, 'inner'));
  assert.equal((await reason(nested, { workDir: path.join(nested.configDir, 'inner') })).reason, 'config_dir_invalid');

  const dirty = workspace({ steps: [] });
  writeFileSync(path.join(dirty.configDir, 'settings.json'), '{}');
  assert.equal((await reason(dirty)).reason, 'config_dir_not_empty', 'a config folder from an earlier run (or anyone) is not reused');

  const missingDir = workspace({ steps: [] });
  assert.equal((await reason(missingDir, { workDir: path.join(missingDir.base, 'nope') })).reason, 'work_dir_invalid');
  assert.equal((await reason(missingDir, { executable: path.join(missingDir.base, 'claude.exe') })).reason, 'executable_unavailable');
  assert.equal((await reason(missingDir, { executable: missingDir.base })).reason, 'executable_unavailable');
  assert.equal((await reason(missingDir, { executableSha256: '0'.repeat(64) })).reason, 'executable_unavailable');
  assert.equal(spawned, 0);
});

test('spawn failure is an error result, not an exception', async () => {
  const result = await createClaudeCodeDriver(driverOptions(workspace({ steps: [] }), { spawnImpl: () => { throw new Error('EPERM'); } })).run();
  assert.deepEqual([result.outcome, result.reason], ['error', 'spawn_failed']);
});

test('spawn flags: no shell, no window, and a process group of its own off Windows', async () => {
  const ws = workspace({ steps: [{ result: 'DONE' }] });
  const seen = [];
  const { spawn } = await import('node:child_process');
  await createClaudeCodeDriver(driverOptions(ws, { spawnImpl: (exe, args, options) => { seen.push(options); return spawn(exe, args, options); } })).run();
  assert.equal(seen[0].shell, false);
  assert.equal(seen[0].windowsHide, true);
  assert.equal(seen[0].detached, process.platform !== 'win32');
  assert.deepEqual(seen[0].stdio, ['pipe', 'pipe', 'ignore']);
  assert.equal(seen[0].cwd, ws.workDir);
});

test('source: processes are stopped by the PID the driver started, never by image name', () => {
  for (const file of ['claude-code-driver.mjs', 'albera-desktop-mcp.mjs', 'albera-desktop-mcp-server.mjs', 'fake-claude-code.mjs']) {
    const source = readFileSync(path.resolve(here, '../src/runtime', file), 'utf8').split('\n').filter((line) => !/^\s*\/\//u.test(line)).join('\n'); // code, not the comments that explain the rule
    assert.doesNotMatch(source, /taskkill|Stop-Process|pkill|killall|\/IM\b|-Name\b/iu, file);
    assert.doesNotMatch(source, /process\.env\.(?:CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC)/u, `${file} reads no credential from its own environment`);
  }
});
