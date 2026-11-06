import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { captureExecutableIdentity } from '../src/runtime/executable-identity.mjs';
import { createWsl2BridgeClient, HELPER_MODE, Wsl2BridgeError } from '../src/runtime/wsl2-bridge-client.mjs';
import { BRIDGE_REASONS, decodeReply, encodeRequest, frameOf, isSafeRunPath, maxReplyBytes, VERBS, WIRE_LIMITS, WireError, WireFrameReader } from '../src/runtime/wsl2-bridge-wire.mjs';
import { WIRE_PROBE_REPLIES } from './helpers/wsl2-wire-probe.mjs';

// The Node side of the WSL bridge's wire, and the client against a FAKE helper (an in-process stand-in for the child process: no pipe, no .NET, no WSL). What the real helper does is in
// test/runtime-wsl2-bridge-integration.test.mjs, against a fake bridge. Neither proves anything about a real bridge on a real machine.
const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeSource = (file) => readFileSync(path.resolve(here, '../src/runtime/windows-wsl-bridge', file), 'utf8');
const SID = 'S-1-5-21-1-2-3-1001';
const MIB = 1024 * 1024;
const roots = [];
process.on('exit', () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const u32 = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const wireFrame = (...parts) => { const payload = Buffer.concat(parts.map((p) => Buffer.from(p))); return Buffer.concat([u32(payload.length), payload]); };
const hostFrame = (value) => { const body = Buffer.from(JSON.stringify(value)); const head = Buffer.alloc(4); head.writeInt32LE(body.length); return Buffer.concat([head, body]); };

// ---- the wire against its canon ----

test('wire: verbs, limits and refusal words are the ones in Wire.cs, Limits.cs and Reason.cs', () => {
  const wire = bridgeSource('Wire.cs');
  const verbs = Object.fromEntries([...wire.match(/enum Verb : byte \{([^}]+)\}/u)[1].matchAll(/(\w+) = (\d)/gu)].map((m) => [m[1].toLowerCase(), Number(m[2])]));
  assert.deepEqual(verbs, { ...VERBS });
  const limits = bridgeSource('Limits.cs');
  const mib = (name) => Number(limits.match(new RegExp(`${name}: (\\d+) \\* MiB`, 'u'))[1]) * MIB;
  assert.equal(mib('MaxPutBytes'), WIRE_LIMITS.maxPutBytes);
  assert.equal(mib('MaxGetBytes'), WIRE_LIMITS.maxGetBytes);
  assert.match(limits, /MaxOutputBytes: MiB/u);
  assert.equal(WIRE_LIMITS.maxOutputBytes, MIB);
  assert.match(limits, new RegExp(`MaxCommandBytes: 64 \\* 1024, MaxPathBytes: ${WIRE_LIMITS.maxPathBytes}`, 'u'));
  assert.equal(WIRE_LIMITS.maxCommandBytes, 64 * 1024);
  assert.match(limits, new RegExp(`MaxExecSeconds: ${WIRE_LIMITS.maxExecSeconds}`, 'u'));
  assert.match(limits, /MaxRequestFrame => MaxPutBytes \+ MaxPathBytes \+ 1024/u);
  assert.equal(WIRE_LIMITS.maxRequestFrame, WIRE_LIMITS.maxPutBytes + WIRE_LIMITS.maxPathBytes + 1024);
  assert.match(bridgeSource('BridgeBegin.cs'), new RegExp(`MaxLeaseBytes = ${WIRE_LIMITS.maxLeaseBytes}`, 'u'));
  const words = [...bridgeSource('Reason.cs').matchAll(/\b[A-Z]\w+ = "([a-z_]+)"/gu)].map((m) => m[1]);
  assert.deepEqual([...words].sort(), [...BRIDGE_REASONS].sort());
  assert.ok(Math.max(...words.map((w) => w.length)) <= WIRE_LIMITS.maxWordBytes);
});

test('wire: each request is the exact bytes of the format, written out by hand', () => {
  const id = Buffer.from('op-1');
  const head = (verb) => [[verb, id.length], id];
  assert.deepEqual(encodeRequest.begin('op-1', '{}'), wireFrame(...head(1), '{}'));
  assert.deepEqual(encodeRequest.run('op-1', 300, 'ls'), wireFrame(...head(2), [0, 0, 1, 0x2c], 'ls'));
  assert.deepEqual(encodeRequest.put('op-1', 'a/b', Buffer.from([0, 255])), wireFrame(...head(3), [0, 0, 0, 3], 'a/b', [0, 255]));
  assert.deepEqual(encodeRequest.get('op-1', 'a/b'), wireFrame(...head(4), 'a/b'));
  assert.deepEqual(encodeRequest.end('op-1'), wireFrame(...head(5)));
  assert.deepEqual(encodeRequest.stop('op-1'), wireFrame(...head(6)));
  assert.equal(encodeRequest.get('op-1', 'x').readUInt32BE(0), encodeRequest.get('op-1', 'x').length - 4, 'the length is big-endian and leaves itself out');
});

test('wire: a request the bridge would refuse is not encoded', () => {
  const refused = (fn) => assert.throws(fn, (error) => error instanceof WireError && error.code === 'invalid_request');
  for (const id of ['', 'a'.repeat(65), '-a', 'a b', '\u6587', 'a/b', null]) refused(() => encodeRequest.end(id));
  assert.doesNotThrow(() => encodeRequest.end('a'.repeat(64)));
  refused(() => encodeRequest.begin('op', ''));
  refused(() => encodeRequest.begin('op', 'x'.repeat(WIRE_LIMITS.maxLeaseBytes + 1)));
  assert.doesNotThrow(() => encodeRequest.begin('op', 'x'.repeat(WIRE_LIMITS.maxLeaseBytes)));
  for (const seconds of [0, -1, 1.5, WIRE_LIMITS.maxExecSeconds + 1]) refused(() => encodeRequest.run('op', seconds, 'ls'));
  for (const command of ['', 'a\0b', '\ud800', 'x'.repeat(WIRE_LIMITS.maxCommandBytes + 1)]) refused(() => encodeRequest.run('op', 1, command));
  refused(() => encodeRequest.put('op', 'a', Buffer.alloc(WIRE_LIMITS.maxPutBytes + 1)));
  assert.doesNotThrow(() => encodeRequest.put('op', 'p'.repeat(WIRE_LIMITS.maxPathBytes), Buffer.alloc(WIRE_LIMITS.maxPutBytes)), 'the largest put fits the largest frame');
  refused(() => frameOf(Buffer.alloc(0)));
  refused(() => frameOf(Buffer.alloc(WIRE_LIMITS.maxRequestFrame + 1)));
});

test('wire: paths follow Bridge.SafePath', () => {
  for (const good of ['a', 'repo/a.txt', 'a/.b/c', '...', 'a..b', 'C:x', '\u6587\u5b57']) assert.equal(isSafeRunPath(good), true, good);
  for (const bad of ['', '/etc/passwd', '../a', 'a/../b', 'a/..', 'a//b', 'a/', 'a\\b', 'a\nb', 'a\u0000', 'a\u007f', '\ud800', 'p'.repeat(WIRE_LIMITS.maxPathBytes + 1), null, 7]) assert.equal(isSafeRunPath(bad), false, String(bad));
  assert.equal(isSafeRunPath('\u6587'.repeat(171)), false, 'the bound is in bytes, as on the wire');
});

// ---- frame boundaries ----

test('frames: a reply is assembled from any split, including inside the four length bytes', () => {
  const frame = wireFrame([0], 'hello');
  for (const size of [1, 2, 3, 5]) {
    const reader = new WireFrameReader();
    let payload = null;
    for (let at = 0; at < frame.length; at += size) {
      assert.equal(payload, null, 'nothing before the last byte');
      reader.push(frame.subarray(at, at + size));
      payload = reader.next(100);
    }
    assert.deepEqual(payload, Buffer.concat([Buffer.from([0]), Buffer.from('hello')]));
    assert.equal(reader.pending, false);
  }
});

test('frames: a short read gives no payload, and a length exactly at the bound is accepted', () => {
  const reader = new WireFrameReader();
  assert.equal(reader.next(10), null, 'nothing yet');
  reader.push(Buffer.from([0, 0, 0]));
  assert.equal(reader.next(10), null, 'three of the four length bytes');
  reader.push(Buffer.from([10, 1, 2, 3]));
  assert.equal(reader.next(10), null, 'part of the body');
  reader.push(Buffer.alloc(7));
  assert.equal(reader.next(10).length, 10);
});

test('frames: a length over the bound or of 0 is refused from the header alone, before a byte of the body', () => {
  const tooLong = new WireFrameReader();
  tooLong.push(u32(11));
  assert.throws(() => tooLong.next(10), (error) => error.code === 'response_too_large');
  const huge = new WireFrameReader();
  huge.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));
  assert.throws(() => huge.next(WIRE_LIMITS.maxGetBytes + 1), (error) => error.code === 'response_too_large', 'read as unsigned: a sign bit is not a small number');
  const empty = new WireFrameReader();
  empty.push(u32(0));
  assert.throws(() => empty.next(10), (error) => error.code === 'invalid_response');
});

test('frames: the bound follows the verb, so a job cannot answer a small verb with a large reply', () => {
  assert.equal(maxReplyBytes('get'), 1 + WIRE_LIMITS.maxGetBytes);
  assert.equal(maxReplyBytes('exec'), 1 + 5 + WIRE_LIMITS.maxOutputBytes);
  for (const verb of ['begin', 'put', 'end', 'stop']) assert.ok(maxReplyBytes(verb) <= 65);
});

// ---- replies ----

test('replies: the frames Wire.cs encodes (checked by the bridge harness) decode here', () => {
  const [empty, exec, refusal] = WIRE_PROBE_REPLIES.map(({ frame }) => frame.subarray(4));
  assert.deepEqual(decodeReply('end', empty), { ok: true, value: {} });
  assert.deepEqual(decodeReply('exec', exec), { ok: true, value: { exitCode: -2, flags: 3, output: Buffer.from('hi') } });
  assert.deepEqual(decodeReply('put', refusal), { ok: false, reason: 'calls_exhausted' });
});

test('replies: anything else is not a reply', () => {
  const invalid = (verb, payload) => assert.throws(() => decodeReply(verb, Buffer.from(payload)), (error) => error.code === 'invalid_response');
  invalid('end', []);
  invalid('end', [2]);
  invalid('end', [0, 1]); // a verb that answers nothing
  invalid('exec', [0, 0, 0, 0, 0]); // four of the five header bytes
  invalid('end', Buffer.concat([Buffer.from([1]), Buffer.from('C:\\Users\\secret')]));
  invalid('end', [1]);
  assert.deepEqual(decodeReply('get', Buffer.from([0])), { ok: true, value: { data: Buffer.alloc(0) } }, 'an empty file is a file');
});

// ---- the client, with a fake helper ----

function helperFile() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'albera-wsl2-client-'));
  roots.push(root);
  const helperPath = path.join(root, 'helper.exe');
  writeFileSync(helperPath, 'not a real program');
  return helperPath;
}

async function pinned(helperPath = helperFile()) {
  const { sha256 } = await captureExecutableIdentity(helperPath);
  writeFileSync(`${helperPath}.manifest.json`, JSON.stringify({ sha256 }));
  return { helperPath, helperSha256: sha256 };
}

/** A child process in memory. `answer(child, start)` plays the helper's part once the start frame came; `onRequest(child, bytes)` once the bytes after it came. */
function fakeSpawn({ answer = (child) => child.stdout.write(hostFrame({ ok: true })), onRequest = () => {} } = {}) {
  const seen = { spawns: 0, args: null, options: null, start: null, request: Buffer.alloc(0), killed: 0 };
  const spawnImpl = (file, args, options) => {
    seen.spawns += 1;
    seen.args = args;
    seen.options = options;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => { seen.killed += 1; };
    child.stdin = new Writable({
      write(chunk, encoding, done) {
        done();
        if (seen.start === null) {
          seen.start = JSON.parse(chunk.subarray(4).toString('utf8'));
          answer(child, seen.start);
        } else {
          seen.request = Buffer.concat([seen.request, chunk]);
          onRequest(child, chunk);
        }
      },
    });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  return { spawnImpl, seen };
}

const bridgeFailure = (code, outcome) => (error) => { assert.ok(error instanceof Wsl2BridgeError); assert.equal(error.code, code); assert.equal(error.outcome, outcome); return true; };
const replying = (...frames) => (child) => { for (const frame of frames) child.stdout.write(frame); };

async function clientWith(fake, extra = {}) {
  return createWsl2BridgeClient({ pipeName: 'ALBERA_test', serverSid: SID, ...(await pinned()), spawnImpl: fake.spawnImpl, ...extra });
}

test('client: the helper is asked to prove the owner SID first, and the request follows only its ok', async () => {
  const order = [];
  const fake = fakeSpawn({
    answer: (child) => { order.push(['start', fake.seen.request.length]); child.stdout.write(hostFrame({ ok: true })); },
    onRequest: (child) => { order.push(['request']); child.stdout.write(wireFrame([0])); },
  });
  const client = await clientWith(fake, { serverImageSha256: 'a'.repeat(64) });
  assert.deepEqual(await client.end('op-1'), {});
  assert.deepEqual(order, [['start', 0], ['request']]);
  assert.deepEqual(fake.seen.args, [HELPER_MODE]);
  assert.deepEqual(fake.seen.start.expect, { ownerSid: SID, imageSha256: 'a'.repeat(64) });
  assert.equal(fake.seen.start.pipeName, 'ALBERA_test');
  assert.deepEqual(fake.seen.request, encodeRequest.end('op-1'));
  assert.equal(fake.seen.options.shell, false);
});

test('client: the helper gets a short environment, so a token of this process stays here', async () => {
  const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'not-a-real-token';
  try {
    const fake = fakeSpawn({ onRequest: replying(wireFrame([0])) });
    await (await clientWith(fake)).end('op-1');
    assert.deepEqual(Object.keys(fake.seen.options.env).filter((name) => !['SystemRoot', 'windir', 'TEMP', 'TMP'].includes(name)), []);
  } finally { if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved; }
});

for (const [helperCode, code] of [['server_identity_mismatch', 'server_identity_mismatch'], ['server_identity_unavailable', 'server_identity_unavailable'], ['access_denied', 'access_denied'], ['broker_unavailable', 'bridge_unavailable']]) {
  test(`client: ${helperCode} from the helper refuses the call and neither lease nor request is written`, async () => {
    const fake = fakeSpawn({ answer: (child) => child.stdout.write(hostFrame({ ok: false, code: helperCode })) });
    const client = await clientWith(fake);
    await assert.rejects(client.begin('op-1', '{"lease":"secret-looking"}'), bridgeFailure(code, 'not_applied'));
    assert.equal(fake.seen.request.length, 0);
    assert.equal(fake.seen.killed, 1);
  });
}

test('client: an answer that is not one of the two shapes is no proof, and nothing is sent', async () => {
  const answers = [
    hostFrame({ ok: true, extra: 1 }), hostFrame({ ok: false, code: 'something_else' }), hostFrame({ ok: 'true' }), hostFrame([]), hostFrame(null),
    Buffer.concat([hostFrame({ ok: true }), wireFrame([0])]), // more than the answer: out of step
    Buffer.from([0, 0, 0, 0]), Buffer.from([0xff, 0xff, 0xff, 0x7f]), Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from('abc')]),
  ];
  for (const answer of answers) {
    const fake = fakeSpawn({ answer: replying(answer) });
    await assert.rejects((await clientWith(fake)).end('op-1'), bridgeFailure('invalid_response', 'not_applied'));
    assert.equal(fake.seen.request.length, 0, answer.toString('hex'));
  }
});

test('client: a helper that ends before it proves anything is a refusal, and nothing is sent', async () => {
  const fake = fakeSpawn({ answer: (child) => child.emit('close', 1) });
  await assert.rejects((await clientWith(fake)).end('op-1'), bridgeFailure('transport_error', 'not_applied'));
  assert.equal(fake.seen.request.length, 0);
});

test('client: a helper that does not answer within the connect time is refused, and nothing is sent', async () => {
  const fake = fakeSpawn({ answer: () => {} });
  const client = await clientWith(fake, { connectTimeoutMs: 100 });
  await assert.rejects(client.end('op-1'), bridgeFailure('timeout', 'not_applied'));
  assert.equal(fake.seen.request.length, 0);
});

test('client: each verb sends its frame and returns its answer', async () => {
  const run = async (reply, call) => call(await clientWith(fakeSpawn({ onRequest: replying(reply) })));
  assert.deepEqual(await run(wireFrame([0]), (c) => c.begin('op-1', '{}')), {});
  assert.deepEqual(await run(wireFrame([0], [0, 0, 0, 7, 1], 'out'), (c) => c.run('op-1', { seconds: 1, command: 'ls' })), { exitCode: 7, flags: 1, output: Buffer.from('out') });
  assert.deepEqual(await run(wireFrame([0]), (c) => c.put('op-1', 'a', 'text')), {});
  assert.deepEqual(await run(wireFrame([0], 'bytes'), (c) => c.get('op-1', 'a')), { data: Buffer.from('bytes') });
  assert.deepEqual(await run(wireFrame([0]), (c) => c.stop('op-1')), {});
});

test('client: a refusal word comes back as the code, and other text is a bad reply whose outcome is unknown', async () => {
  const call = async (reply) => (await clientWith(fakeSpawn({ onRequest: replying(reply) }))).run('op-1', { seconds: 1, command: 'ls' });
  await assert.rejects(call(wireFrame([1], 'calls_exhausted')), bridgeFailure('calls_exhausted', 'refused'));
  await assert.rejects(call(wireFrame([1], 'C:\\Users\\owner')), bridgeFailure('invalid_response', 'unknown'));
});

test('client: a reply cut short, over its bound, empty or followed by more bytes is never a result', async () => {
  const stream = (...parts) => (child) => { for (const part of parts) child.stdout.write(Buffer.from(part)); child.emit('close', 0); };
  const ends = async (onRequest) => (await clientWith(fakeSpawn({ onRequest }))).end('op-1');
  await assert.rejects(ends(stream([0, 0])), bridgeFailure('short_read', 'unknown'), 'two of the four length bytes');
  await assert.rejects(ends(stream([0, 0, 0, 9, 0])), bridgeFailure('short_read', 'unknown'), 'part of the body');
  await assert.rejects(ends(stream([])), bridgeFailure('short_read', 'unknown'), 'nothing at all');
  await assert.rejects(ends(replying(u32(66))), bridgeFailure('response_too_large', 'unknown'), 'over the bound of this verb');
  await assert.rejects(ends(replying(u32(0))), bridgeFailure('invalid_response', 'unknown'));
  await assert.rejects(ends(replying(Buffer.concat([wireFrame([0]), wireFrame([0])]))), bridgeFailure('invalid_response', 'unknown'), 'one connection carries one reply');
});

test('client: a reply that does not come in time ends the helper, and the outcome is unknown', { timeout: 15_000 }, async () => {
  const fake = fakeSpawn();
  const client = await clientWith(fake);
  await assert.rejects(client.end('op-1', { timeoutMs: 1 }), bridgeFailure('timeout', 'unknown'));
  assert.equal(fake.seen.start.replyTimeoutMs, 4000, 'the wait has a floor of a second, and the helper gives up later than this client does');
  assert.equal(fake.seen.killed, 1);
});

test('client: a bad argument, a helper not at its pin or a changed helper start nothing', async () => {
  const fake = fakeSpawn();
  const client = await clientWith(fake);
  await assert.rejects(client.get('op-1', '../x'), bridgeFailure('invalid_request', 'not_applied'));
  await assert.rejects(client.run('op-1', { command: 'ls' }), bridgeFailure('invalid_request', 'not_applied'));
  assert.equal(fake.seen.spawns, 0);

  const helper = await pinned();
  const other = createWsl2BridgeClient({ pipeName: 'p', serverSid: SID, ...helper, helperSha256: 'b'.repeat(64), spawnImpl: fake.spawnImpl });
  await assert.rejects(other.end('op-1'), bridgeFailure('helper_unavailable', 'not_applied'));
  writeFileSync(helper.helperPath, 'changed after the pin');
  await assert.rejects(createWsl2BridgeClient({ pipeName: 'p', serverSid: SID, ...helper, spawnImpl: fake.spawnImpl }).end('op-1'), bridgeFailure('helper_unavailable', 'not_applied'));
  assert.equal(fake.seen.spawns, 0);
});

test('client: it cannot be made without a server SID and a pinned helper', async () => {
  const helper = await pinned();
  const invalid = (options) => assert.throws(() => createWsl2BridgeClient(options), /invalid_wsl2_bridge_client_options/u);
  invalid({ pipeName: 'p', ...helper });
  invalid({ pipeName: 'p', serverSid: 'owner', ...helper });
  invalid({ pipeName: 'p', serverSid: SID, helperPath: helper.helperPath });
  invalid({ pipeName: 'a\\b', serverSid: SID, ...helper });
  invalid({ pipeName: 'p', serverSid: SID, ...helper, serverImageSha256: 'ABC' });
});
