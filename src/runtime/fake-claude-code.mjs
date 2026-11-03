import { spawn } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// Fake of the `claude` executable for claude-code-driver.mjs (test double; nothing here talks to Anthropic or reads any credential). Run it as
//   node fake-claude-code.mjs <script.json> <the arguments the driver gives claude>
// so the driver's `executable` is node and its `executableArgs` are [this file, script.json]. It does what the driver relies on from Claude Code:
//   - reads the `--mcp-config` file, starts the albera_desktop MCP server named there (the real server module with a Fake desktop client) and speaks MCP to it over stdio;
//   - waits for the user message (stream-json) on stdin, then plays the script, writing stream-json lines (`system` init, `assistant` tool_use, `user` tool_result, `result`);
//   - after `result` it waits for stdin to end and exits 0, like `claude -p --input-format stream-json`.
// Script: { "recordTo": "<abs file>", "init": { ...fields replacing the generated init }, "steps": [ ... ] }. Steps:
//   { "say": text } | { "sayEnv": NAME }            assistant text (sayEnv: the value of an environment variable of THIS process, to prove redaction)
//   { "tool": name, "input": {...} }                 tool_use + a real tools/call on the MCP server + tool_result (name without the mcp__ prefix)
//   { "toolRaw": fullName, "input": {...} }          a tool_use of any name, no call (what a model asking for Bash would produce)
//   { "result": text, "isError"?, "subtype"?, "linger"? }   the final result line; "linger": keep running after stdin ends
//   { "sleepMs": n } | { "hang": true } | { "exit": code } | { "rawLine": text }
// `recordTo` receives { argv, env, cwd, task, mcpPid, toolResults } when the script ends or the process is told to end, for the test to inspect.

const [scriptFile, ...argv] = process.argv.slice(2);
const script = JSON.parse(readFileSync(scriptFile, 'utf8'));
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const record = { argv, env: { ...process.env }, cwd: process.cwd(), task: null, mcpPid: null, toolResults: [] };
// Written to a side file and renamed into place, so a test that reads the record after the driver killed this process never sees a half-written file.
const save = () => { if (!script.recordTo) return; const tmp = `${script.recordTo}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(record)); renameSync(tmp, script.recordTo); };
process.once('SIGTERM', () => { save(); process.exit(143); });

function startMcp() {
  const config = JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.albera_desktop;
  const child = spawn(config.command, config.args, { env: config.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  record.mcpPid = child.pid;
  save();
  const waiting = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on('line', (line) => { const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); });
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return { child, request, notify: (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`) };
}

async function main() {
  const mcp = startMcp();
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude-code', version: '0' } });
  mcp.notify('notifications/initialized');
  const listed = (await mcp.request('tools/list', {})).result.tools.map((tool) => `mcp__albera_desktop__${tool.name}`);
  const task = await new Promise((resolve) => { createInterface({ input: process.stdin }).once('line', resolve); });
  record.task = JSON.parse(task).message.content;
  emit({ type: 'system', subtype: 'init', session_id: 'fake-session', tools: listed, mcp_servers: [{ name: 'albera_desktop', status: 'connected' }], ...(script.init ?? {}) });
  let n = 0;
  for (const step of script.steps) {
    if (step.say !== undefined || step.sayEnv !== undefined) emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: step.say ?? process.env[step.sayEnv] }] } });
    else if (step.tool !== undefined || step.toolRaw !== undefined) {
      const id = `toolu_${++n}`;
      const name = step.toolRaw ?? `mcp__albera_desktop__${step.tool}`;
      emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: step.input ?? {} }] } });
      if (step.tool !== undefined) {
        const reply = await mcp.request('tools/call', { name: step.tool, arguments: step.input ?? {} });
        record.toolResults.push(reply.result ?? reply.error);
        emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: reply.result?.content ?? [], is_error: reply.result?.isError === true }] } });
      }
    } else if (step.rawLine !== undefined) process.stdout.write(`${step.rawLine}\n`);
    else if (step.sleepMs !== undefined) await new Promise((resolve) => { setTimeout(resolve, step.sleepMs); });
    else if (step.hang) { save(); await new Promise(() => setInterval(() => {}, 1000)); }
    else if (step.exit !== undefined) { save(); process.exit(step.exit); }
    else if (step.result !== undefined) {
      emit({ type: 'result', subtype: step.subtype ?? 'success', is_error: step.isError === true, result: step.result, session_id: 'fake-session', num_turns: n + 1 });
      save();
      if (step.linger) await new Promise(() => setInterval(() => {}, 1000));
      await new Promise((resolve) => { process.stdin.once('end', resolve); process.stdin.resume(); });
    }
  }
  save();
  mcp.child.stdin.end();
  process.exit(0);
}

main().catch(() => process.exit(70));
