import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CLAUDE_DISALLOWED_TOOLS } from '../src/runtime/claude-code-driver.mjs';
import { createFakeControlPlaneSecretStore } from '../src/runtime/fake-control-plane-secret-store.mjs';
import { MAIN_AI_FAILURES, MAIN_AI_SYSTEM_PROMPT } from '../src/runtime/main-ai-contract.mjs';
import { buildMainAiArgs, createClaudeMainAi } from '../src/runtime/main-ai-claude.mjs';
import { CREDENTIAL_NAME } from '../src/runtime/room-service-hands.mjs';
import { answers, createFakeClaude, hangs, replyLines } from './helpers/fake-claude-child.mjs';

// The real main AI adapter (src/runtime/main-ai-claude.mjs) over a FAKE child process: no claude, no token of anyone, no network, no real process. What these prove is what the adapter ASKS of the
// child (no tool, an empty MCP configuration, the token only in the environment, the words only on stdin), what it REFUSES to believe (a child that does not prove it has no tool), and which
// process it ends (only the one it started). Whether the real `claude` obeys those flags (`--tools ""`, measurement item M6) is NOT proved here.
const TOKEN = 'TEST-ONLY-oauth-token-0123456789abcdef';
const WORDS = 'sentinel-words-for-stdin-only';
const INPUT = { words: WORDS, state: { computers: [{ computerId: 'pc-01', label: 'Alpha' }], history: [] } };
const REPLY = JSON.stringify({ say: 'Hello.' });
const roots = [];
process.on('exit', () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** A world: a temp folder with a file standing in for the pinned claude, a secret store, and the adapter over a fake child. */
async function world({ script = answers(replyLines(REPLY)), token = TOKEN, guard = true, limits, model, mutateExecutable = false } = {}) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'albera-mainai-')));
  roots.push(base);
  const executable = path.join(base, 'claude.exe');
  writeFileSync(executable, 'not a real claude');
  const sha = createHash('sha256').update(mutateExecutable ? 'something else' : 'not a real claude').digest('hex');
  const secretStore = createFakeControlPlaneSecretStore();
  if (token !== null) await secretStore.save(CREDENTIAL_NAME, token);
  const loads = [];
  const store = { load: async (name) => { loads.push(name); return secretStore.load(name); } };
  const fake = createFakeClaude(script);
  const logs = [];
  const checked = [];
  const runRoot = path.join(base, 'claude-run');
  let n = 0;
  const ai = createClaudeMainAi({
    claude: { executable, executableSha256: sha, model: model ?? null }, secretStore: store, runRoot, claudeGuard: { check: async (file) => { checked.push(file); return guard; } },
    log: (line) => logs.push(line), spawnImpl: fake.spawnImpl, killTreeImpl: fake.killTreeImpl, io: { exists: async () => false }, // the real home above a temp folder may hold a CLAUDE.md
    newRunId: () => `run-${String(++n).padStart(16, '0')}`, limits,
  });
  return { ai, fake, base, runRoot, logs, loads, checked, executable };
}

/** Wait until the fake has been asked to start `count` children (the adapter's steps before the spawn are asynchronous). */
async function spawnedCount(w, count) {
  for (let i = 0; i < 400 && w.fake.spawned.length < count; i += 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.equal(w.fake.spawned.length, count);
}

const leftovers = (w) => { try { return readdirSync(w.runRoot); } catch { return []; } };

test('a turn: the model\'s final text comes back as it is, and nothing is left behind', async () => {
  const w = await world();
  assert.deepEqual(await w.ai.turn(INPUT), { ok: true, text: REPLY });
  assert.deepEqual(leftovers(w), [], 'the run folder is deleted');
  assert.deepEqual(w.logs, ['main-ai ended ok']);
  assert.equal(w.fake.spawned.length, 1);
  assert.deepEqual(w.fake.killed, [], 'a child that exits by itself is not killed');
});

test('what the child is asked: no tool, an empty MCP configuration, no session, no settings, the pinned executable, never a shell', async () => {
  const w = await world({ model: 'claude-test-model' });
  await w.ai.turn(INPUT);
  const [{ executable, args, options, mcpConfig, cwdEntries }] = w.fake.spawned;
  assert.equal(executable, w.executable);
  assert.deepEqual(args, buildMainAiArgs({ mcpConfigPath: args[args.indexOf('--mcp-config') + 1], model: 'claude-test-model' }));
  const at = (flag) => args.indexOf(flag);
  assert.equal(args[at('--tools') + 1], '', '--tools "" removes every built-in tool');
  assert.deepEqual(args.slice(at('--disallowedTools') + 1, at('--disallowedTools') + 1 + CLAUDE_DISALLOWED_TOOLS.length), [...CLAUDE_DISALLOWED_TOOLS], 'the usual names are denied a second time');
  assert.ok(args.includes('-p') && args.includes('--strict-mcp-config') && args.includes('--no-session-persistence') && args.includes('--disable-slash-commands'));
  assert.equal(args[at('--setting-sources') + 1], '');
  assert.ok(!args.includes('--allowedTools'), 'nothing is allowed by name: there is nothing to allow');
  assert.equal(args[at('--model') + 1], 'claude-test-model');
  assert.equal(args[at('--append-system-prompt') + 1], MAIN_AI_SYSTEM_PROMPT);
  assert.deepEqual(JSON.parse(mcpConfig), { mcpServers: {} }, 'the MCP configuration lists no server');
  assert.deepEqual([options.shell, options.windowsHide, options.stdio], [false, true, ['pipe', 'pipe', 'ignore']]);
  assert.deepEqual(cwdEntries, [], 'the work folder was empty when the child started');
  assert.equal(path.dirname(path.dirname(options.cwd)), w.runRoot, 'the work folder is inside this turn\'s own run folder');
});

test('the token reaches the child\'s environment only; the words reach its stdin only; neither is in the command line', async () => {
  const w = await world();
  const before = { key: process.env.ANTHROPIC_API_KEY, auth: process.env.ANTHROPIC_AUTH_TOKEN };
  process.env.ANTHROPIC_API_KEY = 'TEST-ONLY-api-key-must-not-be-passed';
  process.env.ANTHROPIC_AUTH_TOKEN = 'TEST-ONLY-auth-must-not-be-passed';
  try { await w.ai.turn(INPUT); } finally {
    for (const [name, value] of [['ANTHROPIC_API_KEY', before.key], ['ANTHROPIC_AUTH_TOKEN', before.auth]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
  const [{ args, options, child }] = w.fake.spawned;
  assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.ok(!args.join('\n').includes(TOKEN) && !args.join('\n').includes(WORDS));
  assert.deepEqual(Object.keys(options.env).filter((key) => !['PATH', 'SystemRoot', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS'].includes(key)), [], 'an allowlist: nothing of this process\'s environment');
  assert.ok(!JSON.stringify(options.env).includes('must-not-be-passed'));
  const sent = JSON.parse(child.input.trim());
  assert.equal(sent.type, 'user');
  assert.deepEqual(JSON.parse(sent.message.content), { words: WORDS, computers: INPUT.state.computers, history: [] });
  assert.ok(!w.logs.join('\n').includes(TOKEN) && !w.logs.join('\n').includes(WORDS), 'the log carries codes only');
});

test('a missing token is credential_missing, and nothing is made or started; the guard is asked first', async () => {
  const w = await world({ token: null });
  assert.deepEqual(await w.ai.turn(INPUT), { ok: false, code: 'credential_missing' });
  assert.deepEqual([w.fake.spawned.length, leftovers(w), w.checked], [0, [], [w.executable]]);
  assert.deepEqual(w.logs, ['main-ai ended code=credential_missing']);
});

test('an executable that is not trusted never sees the token: the secret store is not even opened', async () => {
  const w = await world({ guard: false });
  assert.deepEqual(await w.ai.turn(INPUT), { ok: false, code: 'claude_untrusted' });
  assert.deepEqual([w.loads, w.fake.spawned.length, leftovers(w)], [[], 0, []]);
  const throwing = createClaudeMainAi({ claude: { executable: w.executable, executableSha256: 'a'.repeat(64), model: null }, secretStore: { load: async () => { throw new Error('x'); } }, runRoot: w.runRoot, claudeGuard: { check: async () => { throw new Error('boom'); } } });
  assert.deepEqual(await throwing.turn(INPUT), { ok: false, code: 'claude_untrusted' }, 'a guard that cannot answer is "not trusted"');
});

test('a different executable (SHA-256 mismatch) is refused before anything starts, and the folder is removed', async () => {
  const w = await world({ mutateExecutable: true });
  assert.deepEqual(await w.ai.turn(INPUT), { ok: false, code: 'executable_unavailable' });
  assert.deepEqual([w.fake.spawned.length, leftovers(w)], [0, []]);
});

test('the init message must PROVE no tool and no MCP server: a tool, an MCP server, a missing list, or no init at all stops the child (its own PID) with a fixed code', async () => {
  const cases = [
    ['a tool is listed', { init: { tools: ['Bash'] } }, 'unexpected_capability'],
    ['an MCP server is listed', { init: { mcp_servers: [{ name: 'x', status: 'connected' }] } }, 'unexpected_capability'],
    ['the tools list is missing', { init: { tools: undefined } }, 'capability_unverified'],
    ['the MCP list is missing', { init: { mcp_servers: undefined } }, 'capability_unverified'],
    ['the tools list is not a list', { init: { tools: 'none' } }, 'capability_unverified'],
  ];
  for (const [label, patch, code] of cases) {
    const w = await world({ script: answers(replyLines(REPLY, patch)) });
    assert.deepEqual(await w.ai.turn(INPUT), { ok: false, code }, label);
    assert.deepEqual(w.fake.killed, [w.fake.spawned[0].child.pid], `${label}: the child this adapter started was stopped, nothing else`);
    assert.deepEqual(leftovers(w), [], label);
  }
});

test('a reply that comes before any init, and a child that never sends init, are not believed: capability_unverified, child stopped', async () => {
  const [, assistant, result] = replyLines(REPLY);
  const before = await world({ script: answers([assistant, result]) });
  assert.deepEqual(await before.ai.turn(INPUT), { ok: false, code: 'capability_unverified' });
  assert.equal(before.fake.killed.length, 1);

  const silent = await world({ script: hangs(), limits: { initMs: 30, turnMs: 5000 } });
  assert.deepEqual(await silent.ai.turn(INPUT), { ok: false, code: 'capability_unverified' });
  assert.deepEqual(silent.fake.killed, [silent.fake.spawned[0].child.pid]);

  const exits = await world({ script: async (child) => { await child.gotInput; child.exit(1); } });
  assert.deepEqual(await exits.ai.turn(INPUT), { ok: false, code: 'capability_unverified' }, 'a child that ends without proving anything');
});

test('any tool use ends the run with unexpected_tool_use, even after a valid init', async () => {
  const lines = [replyLines(REPLY)[0], { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }, ...replyLines(REPLY).slice(1)];
  const w = await world({ script: answers(lines) });
  assert.deepEqual(await w.ai.turn(INPUT), { ok: false, code: 'unexpected_tool_use' });
  assert.deepEqual(w.fake.killed, [w.fake.spawned[0].child.pid]);
});

test('the time limit ends the child by its own PID and says timeout; the folder goes too', async () => {
  const w = await world({ script: async (child) => { await child.gotInput; child.say(replyLines(REPLY)[0]); }, limits: { turnMs: 40 } }); // proves itself, then never answers
  assert.deepEqual(await w.ai.turn(INPUT), { ok: false, code: 'timeout' });
  assert.deepEqual(w.fake.killed, [w.fake.spawned[0].child.pid]);
  assert.deepEqual(leftovers(w), []);
});

test('one turn at a time (busy); stop() ends the running turn; close() ends it, waits, and refuses new turns', async () => {
  const w = await world({ script: async (child) => { await child.gotInput; child.say(replyLines(REPLY)[0]); }, limits: { turnMs: 5000 } });
  const first = w.ai.turn(INPUT);
  assert.deepEqual(await w.ai.turn(INPUT), { ok: false, code: 'busy' });
  await spawnedCount(w, 1);
  w.ai.stop();
  assert.deepEqual(await first, { ok: false, code: 'stopped' });
  assert.deepEqual(w.fake.killed, [w.fake.spawned[0].child.pid]);

  const second = w.ai.turn(INPUT);
  await spawnedCount(w, 2);
  await w.ai.close();
  assert.deepEqual(await second, { ok: false, code: 'stopped' });
  assert.deepEqual(await w.ai.turn(INPUT), { ok: false, code: 'closed' });
  assert.deepEqual(w.fake.killed, w.fake.spawned.map((s) => s.child.pid), 'exactly the children it started, once each');
  assert.deepEqual(leftovers(w), []);
});

test('an error result is claude_error, a missing result is no_reply, an oversized output is output_too_large; each stops cleanly', async () => {
  const error = await world({ script: answers(replyLines('x', { result: { is_error: true, subtype: 'error_during_execution', result: 'rate limit reached for sk-ant-whatever' } })) });
  assert.deepEqual(await error.ai.turn(INPUT), { ok: false, code: 'claude_error' }, 'the child\'s text is not passed on');
  assert.ok(!error.logs.join('\n').includes('rate limit'));

  const none = await world({ script: async (child) => { await child.gotInput; child.say(replyLines(REPLY)[0]); child.exit(0); } }); // proves itself, then ends without a result
  assert.deepEqual(await none.ai.turn(INPUT), { ok: false, code: 'no_reply' });

  const big = await world({ script: async (child) => { await child.gotInput; child.say(replyLines(REPLY)[0]); child.stdout.write('x'.repeat(2048)); }, limits: { maxOutputBytes: 1024, turnMs: 5000 } });
  assert.deepEqual(await big.ai.turn(INPUT), { ok: false, code: 'output_too_large' });
  assert.equal(big.fake.killed.length, 1);
});

test('a spawn that throws is spawn_failed; every failure code the adapter can give is one the screen has a fixed name for', async () => {
  const w = await world();
  const failing = createClaudeMainAi({
    claude: { executable: w.executable, executableSha256: createHash('sha256').update('not a real claude').digest('hex'), model: null }, secretStore: { load: async () => Buffer.from(TOKEN, 'latin1') },
    runRoot: w.runRoot, claudeGuard: { check: async () => true }, spawnImpl: () => { throw new Error('EACCES C:\\secret\\path'); }, io: { exists: async () => false },
  });
  const result = await failing.turn(INPUT);
  assert.deepEqual(result, { ok: false, code: 'spawn_failed' });
  for (const code of ['busy', 'closed', 'stopped', 'timeout', 'claude_untrusted', 'credential_missing', 'executable_unavailable', 'capability_unverified', 'unexpected_capability', 'unexpected_tool_use', 'output_too_large', 'claude_error', 'no_reply']) {
    assert.ok(MAIN_AI_FAILURES.includes(code), code);
  }
});

test('the source ends processes by the PID it started and never by name', () => {
  const source = readFileSync(new URL('../src/runtime/main-ai-claude.mjs', import.meta.url), 'utf8').split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line)).join('\n');
  assert.doesNotMatch(source, /taskkill|\/IM\b|Stop-Process|pkill|killall|process\.kill|GetProcessesByName|shell:\s*true/iu);
  assert.match(source, /terminateWindowsTree\(child\.pid/u);
});
