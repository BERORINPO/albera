import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  BROKER_CLIENT_ERROR_CODES,
  BROKER_CLIENT_LIMITS,
  BrokerClientError,
  brokerPipePath,
  buildBrokerRequestBody,
  buildBrokerRequestFrame,
  encodeBrokerFrame,
  mapBrokerTransportError,
  parseBrokerResponseFrame,
  sendBrokerRequest,
  validateBrokerResponse,
} from '../src/runtime/windows-broker-client.mjs';

// Pure and fake-transport tests: they run on every OS and need neither .NET nor a real pipe.
const b64 = (length) => 'A'.repeat(length);
const frameOf = (value) => {
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeInt32LE(body.length);
  return Buffer.concat([header, body]);
};
const SUCCESS = { ok: true, state: 'UNKNOWN', action: 'synthetic.noop' };
const DENIED = { ok: false, code: 'denied' };
const goodRequest = { pipeName: 'ALBERA_Test_0123456789abcdef', receipt: Buffer.from('{"receipt":1}').toString('base64'), signature: b64(88) };
const codeOf = (fn) => { try { fn(); } catch (error) { assert.ok(error instanceof BrokerClientError); return error.code; } return null; };

test('pipe path accepts plain names only and keeps the pipe namespace', () => {
  assert.equal(brokerPipePath('ALBERA_Issue22_ab12-CD'), '\\\\.\\pipe\\ALBERA_Issue22_ab12-CD');
  for (const bad of ['', '..', 'a\\b', 'a/b', '\\\\.\\pipe\\x', 'a.b', 'a b', 'x'.repeat(129), undefined, null, 12, {}]) {
    assert.equal(codeOf(() => brokerPipePath(bad)), 'invalid_pipe_name', String(bad));
  }
});

test('request body carries exactly receipt and signature, in that order, and nothing else', () => {
  const body = buildBrokerRequestBody({ ...goodRequest, operationId: 'x', expectedGeneration: 7, actionDigest: 'y', extra: 'z' });
  assert.deepEqual(JSON.parse(body.toString('utf8')), { receipt: goodRequest.receipt, signature: goodRequest.signature });
  assert.deepEqual(Object.keys(JSON.parse(body.toString('utf8'))), ['receipt', 'signature']);
});

test('request fields must be canonical non-empty base64 strings', () => {
  for (const bad of ['', 'abc', 'abcd=', 'ab=d', 'ab cd', 'SYNTHETIC_SECRET_MARKER', 'AB==\n', '====', 'AAB=', undefined, null, 5, ['AAAA'], { toString: () => 'AAAA' }]) {
    assert.equal(codeOf(() => buildBrokerRequestBody({ receipt: bad, signature: goodRequest.signature })), 'invalid_request', `receipt ${String(bad)}`);
    assert.equal(codeOf(() => buildBrokerRequestBody({ receipt: goodRequest.receipt, signature: bad })), 'invalid_request', `signature ${String(bad)}`);
  }
  assert.equal(codeOf(() => buildBrokerRequestBody()), 'invalid_request');
});

test('request size limit is the 2 KiB ADR bound, measured on the JSON body', () => {
  const overhead = Buffer.byteLength(JSON.stringify({ receipt: '', signature: '' }));
  assert.equal(BROKER_CLIENT_LIMITS.maxRequestBytes, 2048);
  const atLimit = buildBrokerRequestBody({ receipt: b64(2016 - 88), signature: b64(88) });
  assert.equal(atLimit.length, overhead + 2016);
  assert.ok(atLimit.length <= 2048);
  const over = { receipt: b64(2020 - 88), signature: b64(88) };
  assert.equal(overhead + 2020 > 2048, true);
  assert.equal(codeOf(() => buildBrokerRequestBody(over)), 'request_too_large');
  assert.equal(codeOf(() => buildBrokerRequestFrame(over)), 'request_too_large');
  assert.equal(codeOf(() => encodeBrokerFrame(Buffer.alloc(2049))), 'request_too_large');
  assert.equal(codeOf(() => encodeBrokerFrame(Buffer.alloc(0))), 'request_too_large');
  assert.equal(codeOf(() => encodeBrokerFrame('text')), 'request_too_large');
});

test('frame is an int32 little-endian length followed by the body', () => {
  const frame = buildBrokerRequestFrame(goodRequest);
  const body = buildBrokerRequestBody(goodRequest);
  assert.equal(frame.readInt32LE(0), body.length);
  assert.equal(frame.length, 4 + body.length);
  assert.deepEqual(frame.subarray(4), body);
});

test('response schema is fixed: only the success and denial shapes pass, as fresh frozen objects', () => {
  const ok = validateBrokerResponse(SUCCESS);
  assert.deepEqual(ok, SUCCESS);
  assert.notEqual(ok, SUCCESS);
  assert.ok(Object.isFrozen(ok));
  assert.deepEqual(validateBrokerResponse(DENIED), DENIED);
  const bad = [
    null, undefined, 'ok', 7, [], [SUCCESS],
    {}, { ok: true }, { ok: false }, { ok: 'true', state: 'UNKNOWN', action: 'synthetic.noop' },
    { ...SUCCESS, extra: 1 }, { ...SUCCESS, state: 'SUCCEEDED' }, { ...SUCCESS, action: 'shell.exec' }, { ...SUCCESS, state: undefined },
    { ...DENIED, extra: 'C:\\Users\\secret' }, { ok: false, code: 'SYNTHETIC_SECRET_MARKER' }, { ok: false, code: 'timeout' }, { ok: false, code: 'DENIED' },
    { ok: false, code: 'denied', message: 'x' }, { ok: true, code: 'denied' }, Object.create(SUCCESS),
  ];
  for (const value of bad) assert.equal(codeOf(() => validateBrokerResponse(value)), 'invalid_response', JSON.stringify(value));
});

test('response frames: truncation, trailing bytes, oversize, bad length, bad JSON and bad UTF-8 are all rejected', () => {
  assert.deepEqual(parseBrokerResponseFrame(frameOf(SUCCESS)), SUCCESS);
  assert.deepEqual(parseBrokerResponseFrame(frameOf(DENIED)), DENIED);
  const good = frameOf(DENIED);
  const header = (n) => { const h = Buffer.alloc(4); h.writeInt32LE(n); return h; };
  const cases = {
    invalid_response: [
      Buffer.alloc(0), Buffer.from([1, 0]), good.subarray(0, good.length - 1), Buffer.concat([good, Buffer.from('x')]),
      header(0), header(-1), Buffer.concat([header(2), Buffer.from('{}')]), frameOf('not json'), frameOf('[]'),
      Buffer.concat([header(2), Buffer.from([0xff, 0xfe])]), 'string', null,
    ],
    response_too_large: [header(BROKER_CLIENT_LIMITS.maxResponseBytes + 1), Buffer.concat([header(0x7fffffff), Buffer.alloc(8)])],
  };
  for (const [code, frames] of Object.entries(cases)) for (const frame of frames) assert.equal(codeOf(() => parseBrokerResponseFrame(frame)), code, String(frame));
});

test('transport errors map by errno only and never expose message text', () => {
  const secret = 'C:\\Users\\yosuke\\AppData\\secret-path SYNTHETIC_SECRET_MARKER';
  const withCode = (code) => Object.assign(new Error(secret), { code });
  assert.equal(mapBrokerTransportError(withCode('ENOENT')), 'broker_unavailable');
  assert.equal(mapBrokerTransportError(withCode('EBUSY')), 'broker_unavailable');
  assert.equal(mapBrokerTransportError(withCode('ECONNREFUSED')), 'broker_unavailable');
  assert.equal(mapBrokerTransportError(withCode('EACCES')), 'access_denied');
  assert.equal(mapBrokerTransportError(withCode('EPERM')), 'access_denied');
  assert.equal(mapBrokerTransportError(withCode('EPIPE')), 'transport_error');
  for (const other of [new Error(secret), null, undefined, 'ENOENT', { code: 5 }]) assert.equal(mapBrokerTransportError(other), 'transport_error');
  assert.equal(mapBrokerTransportError(new BrokerClientError('timeout')), 'timeout');
  assert.equal(new BrokerClientError('C:\\secret').code, 'transport_error');
  assert.equal(new BrokerClientError('C:\\secret').message, 'transport_error');
  assert.ok(BROKER_CLIENT_ERROR_CODES.every((code) => /^[a-z_]+$/u.test(code)));
});

function fakeConnect({ reply = [], endAfter = true, connectError, onWrite } = {}) {
  const calls = { paths: [], written: [], destroyed: false };
  const connect = (pipePath) => {
    calls.paths.push(pipePath);
    const socket = new EventEmitter();
    socket.write = (data) => {
      calls.written.push(Buffer.from(data));
      onWrite?.(calls.written.length);
      setImmediate(() => { for (const chunk of reply) socket.emit('data', chunk); if (endAfter) socket.emit('end'); });
      return true;
    };
    socket.destroy = () => { calls.destroyed = true; };
    setImmediate(() => (connectError ? socket.emit('error', connectError) : socket.emit('connect')));
    return socket;
  };
  return { connect, calls };
}

test('client writes one frame, validates the reply and destroys the connection', async () => {
  const { connect, calls } = fakeConnect({ reply: [frameOf(SUCCESS)] });
  assert.deepEqual(await sendBrokerRequest({ ...goodRequest, connect }), SUCCESS);
  assert.deepEqual(calls.paths, ['\\\\.\\pipe\\ALBERA_Test_0123456789abcdef']);
  assert.equal(calls.written.length, 1);
  assert.deepEqual(calls.written[0], buildBrokerRequestFrame(goodRequest));
  assert.equal(calls.destroyed, true);
  const split = frameOf(DENIED);
  assert.deepEqual(await sendBrokerRequest({ ...goodRequest, connect: fakeConnect({ reply: [split.subarray(0, 3), split.subarray(3, 9), split.subarray(9)] }).connect }), DENIED);
});

test('client returns fixed failure codes and never touches the transport for a bad request', async () => {
  const never = () => { throw new Error('connect must not be called'); };
  const cases = [
    [{ ...goodRequest, pipeName: '..\\x' }, 'invalid_pipe_name'],
    [{ ...goodRequest, receipt: 'SYNTHETIC_SECRET_MARKER' }, 'invalid_request'],
    [{ ...goodRequest, receipt: b64(2100) }, 'request_too_large'],
    [{ ...goodRequest, timeoutMs: 0 }, 'invalid_request'],
    [{ ...goodRequest, timeoutMs: 1.5 }, 'invalid_request'],
    [{ ...goodRequest, timeoutMs: BROKER_CLIENT_LIMITS.maxTimeoutMs + 1 }, 'invalid_request'],
  ];
  for (const [input, code] of cases) assert.deepEqual(await sendBrokerRequest({ ...input, connect: never }), { ok: false, code });
  assert.deepEqual(await sendBrokerRequest(), { ok: false, code: 'invalid_pipe_name' });
});

test('client maps connect errors, bad replies, oversize replies and silence without raw text', async () => {
  const secret = 'C:\\Users\\yosuke\\secret SYNTHETIC_SECRET_MARKER';
  const run = (options, extra = {}) => sendBrokerRequest({ ...goodRequest, timeoutMs: 200, ...extra, connect: fakeConnect(options).connect });
  assert.deepEqual(await run({ connectError: Object.assign(new Error(secret), { code: 'ENOENT' }) }), { ok: false, code: 'broker_unavailable' });
  assert.deepEqual(await run({ connectError: Object.assign(new Error(secret), { code: 'EACCES' }) }), { ok: false, code: 'access_denied' });
  assert.deepEqual(await run({ connectError: new Error(secret) }), { ok: false, code: 'transport_error' });
  assert.deepEqual(await run({ reply: [] }), { ok: false, code: 'invalid_response' });
  assert.deepEqual(await run({ reply: [frameOf({ ...DENIED, detail: secret })] }), { ok: false, code: 'invalid_response' });
  assert.deepEqual(await run({ reply: [frameOf({ ok: false, code: secret })] }), { ok: false, code: 'invalid_response' });
  assert.deepEqual(await run({ reply: [Buffer.concat([frameOf(DENIED), Buffer.from('x')])] }), { ok: false, code: 'invalid_response' });
  assert.deepEqual(await run({ reply: [frameOf(DENIED).subarray(0, 6)] }), { ok: false, code: 'invalid_response' });
  assert.deepEqual(await run({ reply: [frameOf(`{"pad":"${'x'.repeat(400)}"}`)] }), { ok: false, code: 'response_too_large' });
  assert.deepEqual(await run({ reply: [Buffer.alloc(BROKER_CLIENT_LIMITS.maxResponseBytes + 64, 1)] }), { ok: false, code: 'response_too_large' });
  const started = Date.now();
  assert.deepEqual(await run({ reply: [frameOf(DENIED)], endAfter: false }), { ok: false, code: 'timeout' });
  assert.ok(Date.now() - started < 3000);
  const results = JSON.stringify([await run({ connectError: Object.assign(new Error(secret), { code: 'ENOENT' }) })]);
  assert.equal(results.includes('SYNTHETIC_SECRET_MARKER') || results.includes('yosuke'), false);
});

test('default transport refuses to run off Windows instead of guessing a socket path', { skip: process.platform === 'win32' && 'Windows has a real default transport' }, async () => {
  assert.deepEqual(await sendBrokerRequest(goodRequest), { ok: false, code: 'unsupported_platform' });
});

test('the client is not imported by the Observer, entry layers, runtime modules or package wiring', () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? (entry.name === 'bin' || entry.name === 'obj' ? [] : walk(full)) : [full];
  });
  const self = path.join(root, 'src', 'runtime', 'windows-broker-client.mjs');
  const sources = walk(path.join(root, 'src')).filter((file) => /\.(?:mjs|js|html|json|css)$/u.test(file) && file !== self);
  assert.ok(sources.length > 50, 'the scan must cover the source tree');
  for (const file of sources) assert.equal(/windows-broker-client/u.test(readFileSync(file, 'utf8')), false, `${path.relative(root, file)} must not reference the Broker client`);
  const manifest = readFileSync(path.join(root, 'package.json'), 'utf8');
  assert.equal(/windows-broker-client/u.test(manifest), false);
  const client = readFileSync(self, 'utf8');
  assert.equal(/child_process|\bspawn\b|\bexec\w*\(|\bfork\(/u.test(client), false, 'the client never launches a process');
});
