import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildShellMcpFlags } from '../src/runtime/albera-shell-mcp-args.mjs';
import { SHELL_HANDS } from '../src/runtime/albera-shell-mcp-server.mjs';
import { createClaudeCodeDriver } from '../src/runtime/claude-code-driver.mjs';
import { captureExecutableIdentity } from '../src/runtime/executable-identity.mjs';
import { createWsl2BridgeClient, Wsl2BridgeError } from '../src/runtime/wsl2-bridge-client.mjs';
import { encodeRequest } from '../src/runtime/wsl2-bridge-wire.mjs';
import { buildPipeClient, getUnavailableReason, nodePipeOwnerSid } from './helpers/windows-broker-harness.mjs';

// Windows-only: the Node client and the REAL pipe client helper against a FAKE bridge, a pipe this test serves with its own hand-written wire. Same user, random pipe names, no wsl.exe, no real bridge, no
// real lease, no token that means anything. Proves the owner check on a real connected handle, the relay and the frame bounds. It does NOT prove anything about the real bridge's pipe, a cross-account
// connection (Control Plane account to owner), or WSL: the helper's owner check is only ever same-user here. Skipped without the .NET 10 SDK.
const here = path.dirname(fileURLToPath(import.meta.url));
const u32 = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const framed = (...parts) => { const payload = Buffer.concat(parts.map((part) => Buffer.from(part))); return Buffer.concat([u32(payload.length), payload]); };
const OTHER_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';

/** Serves one pipe. `reply(request)` gets each request frame's whole bytes and writes what it wants on the socket given. `received` keeps every byte that arrived on every connection. */
function fakeBridge(reply) {
  const name = `ALBERA_FakeBridge_${randomBytes(8).toString('hex')}`;
  const seen = { connections: 0, received: Buffer.alloc(0), requests: [] };
  const server = net.createServer((socket) => {
    seen.connections += 1;
    let bytes = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      seen.received = Buffer.concat([seen.received, chunk]);
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32BE(0)) { seen.requests.push(bytes); reply(bytes, socket); }
    });
  });
  return new Promise((resolve) => { server.listen(`\\\\.\\pipe\\${name}`, () => resolve({ name, seen, close: () => new Promise((done) => { server.close(done); }) })); });
}
const answer = (...parts) => (request, socket) => socket.end(framed(...parts));
const failure = (code, outcome) => (error) => { assert.ok(error instanceof Wsl2BridgeError, String(error)); assert.deepEqual([error.code, error.outcome], [code, outcome]); return true; };

describe('bridge client, real helper, fake bridge', { skip: getUnavailableReason() }, () => {
  let root;
  let helperPath;
  let helperSha256;
  let sid;

  before(async () => {
    root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'albera-wsl2-relay-')));
    helperPath = await buildPipeClient(path.join(root, 'helper'));
    helperSha256 = (await captureExecutableIdentity(helperPath)).sha256;
    sid = nodePipeOwnerSid();
  });
  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  const clientFor = (bridge, extra = {}) => createWsl2BridgeClient({ pipeName: bridge.name, serverSid: sid, helperPath, helperSha256, connectTimeoutMs: 10_000, ...extra });
  async function withBridge(reply, use) {
    const bridge = await fakeBridge(reply);
    try { return await use(bridge); } finally { await bridge.close(); }
  }

  it('a command: the bytes on the pipe are the wire request, and the reply comes back', () => withBridge(answer([0, 0, 0, 0, 4, 2], 'out'), async (bridge) => {
    const result = await clientFor(bridge).run('op-1', { seconds: 5, command: 'echo hi' });
    assert.deepEqual(result, { exitCode: 4, flags: 2, output: Buffer.from('out') });
    assert.deepEqual(bridge.seen.received, encodeRequest.run('op-1', 5, 'echo hi'));
    assert.equal(bridge.seen.connections, 1);
  }));

  it('a server owned by another SID gets no byte: neither the lease nor anything else', () => withBridge(answer([0]), async (bridge) => {
    const client = clientFor(bridge, { serverSid: OTHER_SID });
    await assert.rejects(client.begin('op-1', '{"lease":"would-be-secret"}'), failure('server_identity_mismatch', 'not_applied'));
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    assert.equal(bridge.seen.received.length, 0);
  }));

  it('the image pin: the right image passes, and a wrong one gets no byte', () => withBridge(answer([0]), async (bridge) => {
    const image = (await captureExecutableIdentity(process.execPath)).sha256;
    await clientFor(bridge, { serverImageSha256: image }).end('op-1');
    const before = bridge.seen.received.length;
    await assert.rejects(clientFor(bridge, { serverImageSha256: 'a'.repeat(64) }).end('op-2'), failure('server_identity_mismatch', 'not_applied'));
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    assert.equal(bridge.seen.received.length, before);
  }));

  it('no such pipe is a refusal with nothing sent', async () => {
    const client = createWsl2BridgeClient({ pipeName: `ALBERA_None_${randomBytes(6).toString('hex')}`, serverSid: sid, helperPath, helperSha256 });
    await assert.rejects(client.end('op-1'), failure('bridge_unavailable', 'not_applied'));
  });

  it('a helper that is not the pinned build is not started', () => withBridge(answer([0]), async (bridge) => {
    await assert.rejects(clientFor(bridge, { helperSha256: 'b'.repeat(64) }).end('op-1'), failure('helper_unavailable', 'not_applied'));
    assert.equal(bridge.seen.connections, 0);
  }));

  it('1 MiB out and 1 MiB back go through the relay unchanged', async () => {
    const data = randomBytes(1024 * 1024);
    const stored = {};
    const reply = (request, socket) => {
      const verb = request[4];
      if (verb === 3) { stored.frame = request; socket.end(framed([0])); } else socket.end(framed([0], data));
    };
    await withBridge(reply, async (bridge) => {
      const client = clientFor(bridge);
      await client.put('op-1', 'big.bin', data);
      assert.deepEqual(stored.frame, encodeRequest.put('op-1', 'big.bin', data));
      assert.deepEqual((await client.get('op-1', 'big.bin')).data, data);
    });
  });

  it('a refusal word arrives as the code', () => withBridge(answer([1], 'lease_used'), (bridge) => assert.rejects(clientFor(bridge).begin('op-1', '{}'), failure('lease_used', 'refused'))));

  it('a reply cut short is a short read, and the outcome is unknown', async () => {
    await withBridge((request, socket) => socket.end(u32(30)), (bridge) => assert.rejects(clientFor(bridge).end('op-1'), failure('short_read', 'unknown')));
    await withBridge((request, socket) => socket.end(Buffer.concat([u32(100), Buffer.alloc(50)])), (bridge) => assert.rejects(clientFor(bridge).get('op-1', 'a'), failure('short_read', 'unknown')));
  });

  it('a length over the bound of the verb is refused without waiting for the body', () => withBridge((request, socket) => socket.write(u32(66)), (bridge) => assert.rejects(clientFor(bridge).end('op-1'), failure('response_too_large', 'unknown'))));

  it('a server that never answers ends in a timeout, and the helper goes away', () => withBridge(() => {}, async (bridge) => {
    let child;
    const spawnImpl = (...args) => { child = spawn(...args); return child; };
    const exited = new Promise((resolve) => { setImmediate(function wait() { if (child) child.once('close', resolve); else setImmediate(wait); }); });
    await assert.rejects(clientFor(bridge, { spawnImpl }).end('op-1', { timeoutMs: 1000 }), failure('timeout', 'unknown'));
    await exited;
  }));

  /** The helper alone, as Node's client would start it, for what the client itself never does. Resolves with its exit code. */
  async function rawHelper(bridge, { replyTimeoutMs = 60_000, after }) {
    const child = spawn(helperPath, ['wsl-bridge'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const closed = new Promise((resolve) => { child.once('close', resolve); });
    const body = Buffer.from(JSON.stringify({ pipeName: bridge.name, timeoutMs: 5000, replyTimeoutMs, expect: { ownerSid: sid } }));
    const head = Buffer.alloc(4);
    head.writeInt32LE(body.length);
    child.stdin.on('error', () => {});
    child.stdin.write(Buffer.concat([head, body]));
    await new Promise((resolve) => { child.stdout.once('data', resolve); });
    after(child);
    return closed;
  }

  it('the helper: stdin closed without a request writes nothing to the pipe', () => withBridge(answer([0]), async (bridge) => {
    assert.equal(await rawHelper(bridge, { after: (child) => child.stdin.end() }), 0);
    assert.equal(bridge.seen.received.length, 0);
  }));

  it('the helper: a request of length 0 or over the bound writes nothing to the pipe', async () => {
    for (const length of [0, 16 * 1024 * 1024 + 512 + 1024 + 1, 0xffffffff]) {
      await withBridge(answer([0]), async (bridge) => {
        assert.equal(await rawHelper(bridge, { after: (child) => child.stdin.write(u32(length)) }), 0);
        assert.equal(bridge.seen.received.length, 0, String(length));
      });
    }
  });

  it('the helper: a helper nobody ended leaves by itself at the end of its time', { timeout: 15_000 }, () => withBridge(() => {}, async (bridge) => {
    await rawHelper(bridge, { replyTimeoutMs: 1000, after: (child) => child.stdin.write(encodeRequest.end('op-1')) });
    assert.deepEqual(bridge.seen.received, encodeRequest.end('op-1'));
  }));

  it('driver, Fake claude, the real shell entry, the real helper and the fake bridge, end to end', () => withBridge((request, socket) => socket.end(request[4] === 2 ? framed([0, 0, 0, 0, 0, 0], 'hello from the fake guest\n') : framed([0])), async (bridge) => {
    const base = path.join(root, `run-${randomBytes(4).toString('hex')}`);
    const [workDir, configDir] = [path.join(base, 'work'), path.join(base, 'config')];
    mkdirSync(workDir, { recursive: true });
    mkdirSync(configDir);
    const recordTo = path.join(base, 'record.json');
    const scriptFile = path.join(base, 'script.json');
    writeFileSync(scriptFile, JSON.stringify({ recordTo, steps: [{ tool: 'run', input: { command: 'echo hi' } }, { tool: 'write', input: { path: 'a.txt', content: 'x' } }, { result: 'DONE: ran it' }] }));
    const entryPath = path.resolve(here, '../src/runtime/albera-shell-mcp-main.mjs');
    const args = buildShellMcpFlags({ entryPath, operationId: 'op-1', bridge: { pipeName: bridge.name, serverSid: sid, helperPath, helperSha256 } });
    const result = await createClaudeCodeDriver({
      executable: process.execPath, executableArgs: [path.resolve(here, '../src/runtime/fake-claude-code.mjs'), scriptFile], task: 'Say hi', oauthToken: `sk-test-${'x'.repeat(16)}`, workDir, configDir,
      mcpServer: { command: process.execPath, args }, hands: SHELL_HANDS, limits: { maxMs: 180_000, maxToolCalls: 5 }, exitGraceMs: 3000, io: { exists: async () => false },
    }).run();
    assert.equal(result.outcome, 'claimed_done', result.reason);
    assert.deepEqual(result.byTool, { run: 1, write: 1 });
    const record = JSON.parse(readFileSync(recordTo, 'utf8'));
    assert.match(record.toolResults[0].content[0].text, /exit code: 0[\s\S]*hello from the fake guest/u);
    assert.deepEqual(bridge.seen.requests, [encodeRequest.run('op-1', 120, 'echo hi'), encodeRequest.put('op-1', 'a.txt', 'x')]);
    assert.equal(record.argv[record.argv.indexOf('--allowedTools') + 1], 'mcp__albera_shell__run');
  }));
});
