import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// albera-agent (ADR-012, decision 9). Linux x86-64 C, so these need gcc on such a machine: CI's ubuntu runners have both.
// They use the test build, which runs outside a sandbox and never calls kill(-1).

const SOURCE = path.resolve('src/runtime/wsl2-guest/agent.c');
const hasCompiler = process.platform === 'linux' && process.arch === 'x64' && spawnSync('gcc', ['--version']).status === 0;
const skip = !hasCompiler || process.getuid?.() === 0 ? 'needs gcc on Linux x86-64, as a non-root user' : false;
const OP = { run: 1, read: 2, write: 3, bundle: 4 };
const STATUS = { ok: 0, badPath: 1, tooLarge: 2, io: 3, spawn: 4, failed: 5 };
const FLAG = { truncated: 1, timedOut: 2 };

const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const frame = (op, ...parts) => { const body = Buffer.concat([Buffer.from([op]), ...parts]); return Buffer.concat([u32(body.length), body]); };
const runFrame = (command, seconds = 10) => frame(OP.run, u32(seconds), Buffer.from(command));
const readFrame = (name) => frame(OP.read, Buffer.from(name));
const writeFrame = (name, data) => frame(OP.write, u32(Buffer.byteLength(name)), Buffer.from(name), Buffer.from(data));
const bundleFrame = (name, seconds = 10) => frame(OP.bundle, u32(seconds), Buffer.from(name));

function build(flags = ['-DALBERA_TEST_BUILD']) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'albera-agent-'));
  const out = path.join(dir, 'agent');
  const compiled = spawnSync('gcc', ['-O2', '-static', '-Wall', '-Wextra', '-Werror', ...flags, '-o', out, SOURCE], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const work = path.join(dir, 'work');
  mkdirSync(work);
  return { out, work, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Sends the frames, closes stdin, and returns every response with the exit code. */
function talk(binary, cwd, frames) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    const chunks = [];
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('close', (code) => {
      const all = Buffer.concat(chunks);
      const responses = [];
      for (let at = 0; at < all.length;) {
        const length = all.readUInt32BE(at);
        responses.push({ status: all[at + 4], body: all.subarray(at + 5, at + 4 + length) });
        at += 4 + length;
      }
      resolve({ code, responses });
    });
    child.stdin.end(Buffer.concat(frames));
  });
}

const runResult = ({ status, body }) => ({ status, exit: body.readInt32BE(0), flags: body[4], output: body.subarray(5).toString() });

test('run returns the exit code and both output streams, and the end of input ends the agent cleanly', { skip }, async () => {
  const { out, work, done } = build();
  try {
    const { code, responses } = await talk(out, work, [runFrame('echo out; echo err >&2; exit 7')]);
    assert.equal(code, 0);
    const result = runResult(responses[0]);
    assert.equal(result.status, STATUS.ok);
    assert.equal(result.exit, 7);
    assert.equal(result.flags, 0);
    assert.match(result.output, /out/u);
    assert.match(result.output, /err/u);
  } finally { done(); }
});

test('a command never reads the frames meant for the agent', { skip }, async () => {
  const { out, work, done } = build();
  try {
    const { responses } = await talk(out, work, [runFrame('cat; echo seen=$?'), runFrame('echo second')]);
    assert.equal(responses.length, 2);
    assert.equal(runResult(responses[0]).output.trim(), 'seen=0');
    assert.equal(runResult(responses[1]).output.trim(), 'second');
  } finally { done(); }
});

test('a command gets only stdin, stdout and stderr', { skip }, async () => {
  const { out, work, done } = build();
  try {
    const { responses } = await talk(out, work, [runFrame('ls /proc/$$/fd | sort -n | tr "\\n" " "')]);
    assert.equal(runResult(responses[0]).output.trim().replace(/ 255$/u, ''), '0 1 2');
  } finally { done(); }
});

test('a command past its time limit is stopped and says so', { skip }, async () => {
  const { out, work, done } = build();
  try {
    const started = Date.now();
    const { responses } = await talk(out, work, [runFrame('echo begun; sleep 30', 1)]);
    const result = runResult(responses[0]);
    assert.equal(result.flags & FLAG.timedOut, FLAG.timedOut);
    assert.match(result.output, /begun/u);
    assert.ok(Date.now() - started < 10_000);
  } finally { done(); }
});

test('a command that closes its output keeps running until it ends', { skip }, async () => {
  const { out, work, done } = build();
  try {
    const { responses } = await talk(out, work, [runFrame('exec >&- 2>&-; sleep 1; touch finished; exit 3')]);
    assert.equal(runResult(responses[0]).exit, 3);
    assert.equal(existsSync(path.join(work, 'finished')), true);
  } finally { done(); }
});

test('a background process does not hold a run open or outlive it', { skip }, async () => {
  const { out, work, done } = build();
  try {
    const started = Date.now();
    const { responses } = await talk(out, work, [runFrame('(sleep 2; touch survived) & echo left')]);
    assert.equal(runResult(responses[0]).exit, 0);
    assert.ok(Date.now() - started < 1_500);
    await new Promise((resolve) => { setTimeout(resolve, 2_500); });
    assert.equal(existsSync(path.join(work, 'survived')), false);
  } finally { done(); }
});

test('output past the limit is cut, flagged, and stops the command', { skip }, async () => {
  const { out, work, done } = build();
  try {
    const { responses } = await talk(out, work, [runFrame('yes x; echo unreachable')]);
    const result = runResult(responses[0]);
    assert.equal(result.flags & FLAG.truncated, FLAG.truncated);
    assert.equal(result.output.length, 1024 * 1024);
  } finally { done(); }
});

test('write then read returns the same bytes', { skip }, async () => {
  const { out, work, done } = build();
  try {
    const data = Buffer.from([0, 1, 2, 255, 10, 13]);
    const { responses } = await talk(out, work, [writeFrame('a.bin', data), readFrame('a.bin')]);
    assert.equal(responses[0].status, STATUS.ok);
    assert.equal(responses[1].status, STATUS.ok);
    assert.deepEqual(Buffer.from(responses[1].body), data);
  } finally { done(); }
});

for (const name of ['/etc/passwd', '../outside', 'a/../../outside', '..', '']) {
  test(`read and write refuse the path "${name}"`, { skip }, async () => {
    const { out, work, done } = build();
    try {
      const { code, responses } = await talk(out, work, [readFrame(name), writeFrame(name, 'x')]);
      assert.equal(code, 0);
      assert.deepEqual(responses.map((r) => r.status), [STATUS.badPath, STATUS.badPath]);
    } finally { done(); }
  });
}

test('read and write do not follow a symlink at the last step', { skip }, async () => {
  const { out, work, done } = build();
  try {
    const target = path.join(work, '..', 'target');
    writeFileSync(target, 'secret');
    symlinkSync(target, path.join(work, 'link'));
    const { responses } = await talk(out, work, [readFrame('link'), writeFrame('link', 'overwritten')]);
    assert.deepEqual(responses.map((r) => r.status), [STATUS.io, STATUS.io]);
    assert.equal(readFileSync(target, 'utf8'), 'secret');
  } finally { done(); }
});

test('a directory cannot be read as a file', { skip }, async () => {
  const { out, work, done } = build();
  try {
    mkdirSync(path.join(work, 'dir'));
    const { responses } = await talk(out, work, [readFrame('dir')]);
    assert.equal(responses[0].status, STATUS.io);
  } finally { done(); }
});

test('bundle returns a git bundle that clones to the same commit', { skip }, async () => {
  const { out, work, done } = build();
  try {
    const script = 'git init -q repo && cd repo && git -c user.name=j -c user.email=j@e commit -q --allow-empty -m one && git rev-parse HEAD';
    const { responses } = await talk(out, work, [runFrame(script), bundleFrame('repo')]);
    const head = runResult(responses[0]).output.trim();
    assert.equal(responses[1].status, STATUS.ok);
    const file = path.join(work, '..', 'out.bundle');
    writeFileSync(file, responses[1].body);
    const clone = path.join(work, '..', 'clone');
    assert.equal(spawnSync('git', ['clone', '-q', file, clone]).status, 0);
    assert.equal(spawnSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), head);
  } finally { done(); }
});

test('bundle of something that is not a repository fails and returns no bytes', { skip }, async () => {
  const { out, work, done } = build();
  try {
    mkdirSync(path.join(work, 'plain'));
    const { responses } = await talk(out, work, [bundleFrame('plain')]);
    assert.equal(responses[0].status, STATUS.failed);
    assert.equal(responses[0].body.length, 0);
  } finally { done(); }
});

for (const [name, bytes] of [
  ['an unknown operation', frame(9)],
  ['an empty frame', u32(0)],
  ['a frame over the limit', u32(0xffffffff)],
  ['a frame cut short', Buffer.concat([u32(100), Buffer.from([1])])],
  ['a run with no time limit field', frame(OP.run, Buffer.from([0]))],
  ['a write whose path length runs past the frame', frame(OP.write, u32(50), Buffer.from('x'))],
]) {
  test(`${name} ends the run`, { skip }, async () => {
    const { out, work, done } = build();
    try {
      const { code, responses } = await talk(out, work, [bytes]);
      assert.equal(code, 97);
      assert.equal(responses.length, 0);
    } finally { done(); }
  });
}

test('the real build refuses to start outside the sandbox', { skip }, async () => {
  const { out, work, done } = build([]);
  try {
    const { code } = await talk(out, work, [runFrame('echo no')]);
    assert.equal(code, 96);
  } finally { done(); }
});

test('only builds that must never ship carry the marker the image build looks for', { skip }, () => {
  const shipped = build([]);
  const testBuild = build();
  try {
    assert.equal(readFileSync(shipped.out).includes('ALBERA-NOT-FOR-SHIPPING'), false);
    assert.equal(readFileSync(testBuild.out).includes('ALBERA-NOT-FOR-SHIPPING'), true);
  } finally { shipped.done(); testBuild.done(); }
});

test('the agent stops everything in the sandbox after a run, and only in the real build', () => {
  const source = readFileSync(SOURCE, 'utf8');
  assert.match(source, /#ifdef ALBERA_TEST_BUILD\s+kill\(-pid, SIGKILL\);\s+#else[\s\S]*?kill\(-1, SIGKILL\);\s+#endif/u);
});
