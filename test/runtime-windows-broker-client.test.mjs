import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import {
  BROKER_CLIENT_ERROR_CODES,
  BROKER_CLIENT_LIMITS,
  BROKER_CLIENT_PRESEND_CODES,
  BrokerClientError,
  brokerPipePath,
  buildBrokerRequestBody,
  parseHelperResult,
  sendBrokerRequest,
  validateBrokerResponse,
  validateServerExpectation,
} from '../src/runtime/windows-broker-client.mjs';

// Pure and fake-helper tests: they run on every OS and need neither .NET nor a real pipe. The real helper is exercised by
// runtime-windows-broker-server-identity.test.mjs and runtime-windows-broker-client.integration.test.mjs (Windows only).
const b64 = (length) => 'A'.repeat(length);
const SUCCESS = { ok: true, state: 'UNKNOWN', action: 'synthetic.noop' };
const DENIED = { ok: false, code: 'denied' };
const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const EXPECT = { ownerSid: SID, pid: 4242 };
const goodRequest = { pipeName: 'ALBERA_Test_0123456789abcdef', receipt: Buffer.from('{"receipt":1}').toString('base64'), signature: b64(88), expect: EXPECT };
const codeOf = (fn) => { try { fn(); } catch (error) { assert.ok(error instanceof BrokerClientError); return error.code; } return null; };
const line = (value) => `${typeof value === 'string' ? value : JSON.stringify(value)}\n`;

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'albera-broker-client-unit-'));
after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
let helperCounter = 0;
/** A stand-in helper file plus a matching SHA-256 manifest, like `npm run build:windows-broker` writes. */
function makeHelper(content = 'not a real executable') {
  const helperPath = path.join(temporaryRoot, `helper-${helperCounter += 1}.exe`);
  writeFileSync(helperPath, content);
  writeFileSync(`${helperPath}.manifest.json`, JSON.stringify({ sha256: createHash('sha256').update(content).digest('hex') }));
  return helperPath;
}

/** A spawn replacement: records how it was called and what was written to stdin, then plays back `stdout` and `exitCode`. */
function fakeSpawn({ stdout = '', exitCode = 0, throws = false, errorBeforeSpawn = false, hang = false } = {}) {
  const calls = { spawns: [], input: '', killed: 0 };
  const spawnImpl = (command, args, options) => {
    calls.spawns.push({ command, args, options });
    if (throws) throw new Error('C:\\Users\\yosuke\\secret SYNTHETIC_SECRET_MARKER');
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stdin.on('data', (chunk) => { calls.input += chunk; });
    child.kill = () => { calls.killed += 1; };
    setImmediate(() => {
      if (errorBeforeSpawn) { child.emit('error', Object.assign(new Error('SYNTHETIC_SECRET_MARKER'), { code: 'ENOENT' })); return; }
      child.emit('spawn');
      if (hang) return;
      child.stdout.write(stdout);
      child.stdout.end();
      child.emit('close', exitCode);
    });
    return child;
  };
  return { spawnImpl, calls };
}
const run = (options = {}, fake = fakeSpawn(), helperPath = makeHelper()) => sendBrokerRequest({ ...goodRequest, helperPath, spawnImpl: fake.spawnImpl, ...options });

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
});

test('the Broker reply schema is fixed: only the success and denial shapes pass, as fresh frozen objects', () => {
  const ok = validateBrokerResponse(SUCCESS);
  assert.deepEqual(ok, SUCCESS);
  assert.notEqual(ok, SUCCESS);
  assert.ok(Object.isFrozen(ok));
  assert.deepEqual(validateBrokerResponse(DENIED), DENIED);
  const bad = [
    null, undefined, 'ok', 7, [], [SUCCESS],
    {}, { ok: true }, { ok: false }, { ok: 'true', state: 'UNKNOWN', action: 'synthetic.noop' },
    { ...SUCCESS, extra: 1 }, { ...SUCCESS, state: 'SUCCEEDED' }, { ...SUCCESS, action: 'shell.exec' }, { ...SUCCESS, state: undefined },
    { ...DENIED, extra: 'C:\\Users\\secret' }, { ok: false, code: 'SYNTHETIC_SECRET_MARKER' }, { ok: false, code: 'timeout' }, { ok: false, code: 'server_identity_mismatch' }, { ok: false, code: 'DENIED' },
    { ok: false, code: 'denied', message: 'x' }, { ok: true, code: 'denied' }, Object.create(SUCCESS),
  ];
  for (const value of bad) assert.equal(codeOf(() => validateBrokerResponse(value)), 'invalid_response', JSON.stringify(value));
});

test('the error code lists agree: pre-send codes are a subset, and no post-send code can look retry-safe', () => {
  assert.ok(BROKER_CLIENT_ERROR_CODES.every((code) => /^[a-z_]+$/u.test(code)));
  for (const code of BROKER_CLIENT_PRESEND_CODES) assert.ok(BROKER_CLIENT_ERROR_CODES.includes(code), code);
  for (const code of ['server_identity_mismatch', 'server_identity_unavailable', 'helper_unavailable']) assert.ok(BROKER_CLIENT_PRESEND_CODES.includes(code), code);
  for (const code of ['denied', 'timeout', 'transport_error', 'invalid_response', 'response_too_large']) assert.equal(BROKER_CLIENT_PRESEND_CODES.includes(code), false, code);
  assert.ok(Object.isFrozen(BROKER_CLIENT_PRESEND_CODES));
  assert.equal(new BrokerClientError('C:\\secret').code, 'transport_error');
  assert.equal(new BrokerClientError('C:\\secret').message, 'transport_error');
});

test('the server expectation is exact: an owner SID with either a PID or a service name, an optional lowercase image hash, nothing else', () => {
  assert.deepEqual(validateServerExpectation({ ownerSid: SID, pid: 4242, imageSha256: 'a'.repeat(64) }), { ownerSid: SID, pid: 4242, imageSha256: 'a'.repeat(64) });
  assert.deepEqual(validateServerExpectation({ ownerSid: SID, serviceName: 'AlberaHostBroker' }), { ownerSid: SID, serviceName: 'AlberaHostBroker' });
  assert.deepEqual(validateServerExpectation({ serviceName: 'AlberaHostBroker' }), { serviceName: 'AlberaHostBroker' }, 'service mode derives the owner from the service');
  const bad = [
    undefined, null, [], 'pid', {}, { ownerSid: SID }, { pid: 4242 }, { ownerSid: SID, pid: 4242, serviceName: 'X' }, { ownerSid: SID, pid: 0 }, { ownerSid: SID, pid: -4 },
    { ownerSid: SID, pid: 1.5 }, { ownerSid: SID, pid: 2 ** 32 }, { ownerSid: SID, pid: '4242' }, { ownerSid: 'S-1', pid: 4242 }, { ownerSid: 'everyone', pid: 4242 },
    { ownerSid: `${SID}\n`, pid: 4242 }, { ownerSid: SID, serviceName: 'a b' }, { ownerSid: SID, serviceName: '..\\x' }, { ownerSid: SID, pid: 4242, imageSha256: 'A'.repeat(64) },
    { ownerSid: SID, pid: 4242, imageSha256: 'a'.repeat(63) }, { ownerSid: SID, pid: 4242, extra: 1 }, { ownerSid: SID, pid: 4242, trusted: true },
  ];
  for (const value of bad) assert.equal(codeOf(() => validateServerExpectation(value)), 'invalid_request', JSON.stringify(value));
});

test('helper output: only the Broker shapes and the helper failure codes pass, tied to the exit code; everything else is a post-send transport_error', () => {
  assert.deepEqual(parseHelperResult(line(SUCCESS), 0), SUCCESS);
  assert.deepEqual(parseHelperResult(line(DENIED), 0), DENIED);
  assert.deepEqual(parseHelperResult(JSON.stringify(DENIED), 0), DENIED, 'the trailing newline is optional');
  for (const code of ['invalid_request', 'broker_unavailable', 'access_denied', 'server_identity_mismatch', 'server_identity_unavailable', 'timeout', 'response_too_large', 'invalid_response', 'transport_error']) {
    assert.deepEqual(parseHelperResult(line({ ok: false, code }), 0), { ok: false, code }, code);
  }
  assert.deepEqual(parseHelperResult(line({ ok: false, code: 'invalid_request' }), 64), { ok: false, code: 'invalid_request' });
  assert.deepEqual(parseHelperResult(line({ ok: false, code: 'server_identity_unavailable' }), 70), { ok: false, code: 'server_identity_unavailable' });
  const transport = { ok: false, code: 'transport_error' };
  const cases = [
    [line(SUCCESS), 1], [line(SUCCESS), 64], [line(SUCCESS), 70], [line(SUCCESS), null], [line(DENIED), 3221225781],
    [line({ ok: false, code: 'denied' }), 64], [line({ ok: false, code: 'timeout' }), 70], [line({ ok: false, code: 'server_identity_mismatch' }), 70],
    ['', 0], ['\n', 0], ['not json\n', 0], [`${line(DENIED)}${line(DENIED)}`, 0], [`${line(DENIED)}trailing`, 0], ['[]\n', 0], ['null\n', 0], ['7\n', 0],
    [line({ ...DENIED, detail: 'C:\\Users\\secret' }), 0], [line({ ok: false, code: 'SYNTHETIC_SECRET_MARKER' }), 0],
    [line({ ok: false, code: 'helper_unavailable' }), 0], [line({ ok: false, code: 'request_too_large' }), 0], [line({ ok: false, code: 'unsupported_platform' }), 0],
    [line({ ok: false, code: 'invalid_pipe_name' }), 0], [line({ ...SUCCESS, extra: 1 }), 0], [line({ ...SUCCESS, action: 'shell.exec' }), 0], [line({ ok: 'yes' }), 0],
    [undefined, 0], [null, 0], [Buffer.from(line(SUCCESS)), 0],
  ];
  for (const [stdout, exitCode] of cases) assert.deepEqual(parseHelperResult(stdout, exitCode), transport, `${String(stdout)} / ${exitCode}`);
});

test('client sends one JSON line to a verified helper, started without a shell or arguments, and returns the validated reply', async () => {
  const fake = fakeSpawn({ stdout: line(SUCCESS) });
  const helperPath = makeHelper();
  assert.deepEqual(await run({ timeoutMs: 1234 }, fake, helperPath), SUCCESS);
  assert.equal(fake.calls.spawns.length, 1);
  const [{ command, args, options }] = fake.calls.spawns;
  assert.equal(command, helperPath);
  assert.deepEqual(args, []);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.ok(fake.calls.input.endsWith('\n') && fake.calls.input.indexOf('\n') === fake.calls.input.length - 1, 'exactly one line');
  assert.deepEqual(JSON.parse(fake.calls.input), { pipeName: goodRequest.pipeName, receipt: goodRequest.receipt, signature: goodRequest.signature, timeoutMs: 1234, expect: EXPECT });
  assert.ok(fake.calls.killed >= 1, 'the helper is always cleaned up');
  assert.deepEqual(await run({}, fakeSpawn({ stdout: line(DENIED) })), DENIED);
});

test('helper failure lines come back as their fixed code, and pre-send ones are listed as retry-safe', async () => {
  for (const code of ['server_identity_mismatch', 'server_identity_unavailable', 'broker_unavailable', 'access_denied']) {
    const result = await run({}, fakeSpawn({ stdout: line({ ok: false, code }) }));
    assert.deepEqual(result, { ok: false, code });
    assert.ok(BROKER_CLIENT_PRESEND_CODES.includes(result.code), code);
  }
  for (const code of ['timeout', 'invalid_response', 'transport_error', 'response_too_large']) {
    const result = await run({}, fakeSpawn({ stdout: line({ ok: false, code }) }));
    assert.deepEqual(result, { ok: false, code });
    assert.equal(BROKER_CLIENT_PRESEND_CODES.includes(result.code), false, code);
  }
});

test('a crashed, silent, flooding or lying helper is a post-send transport_error without raw text', async () => {
  const transport = { ok: false, code: 'transport_error' };
  assert.deepEqual(await run({}, fakeSpawn({ stdout: '', exitCode: 0 })), transport);
  assert.deepEqual(await run({}, fakeSpawn({ stdout: '', exitCode: 3221225781 })), transport);
  assert.deepEqual(await run({}, fakeSpawn({ stdout: line(SUCCESS), exitCode: 1 })), transport);
  assert.deepEqual(await run({}, fakeSpawn({ stdout: `${'x'.repeat(2000)}\n`, exitCode: 0 })), transport);
  const secret = JSON.stringify(await run({}, fakeSpawn({ stdout: 'C:\\Users\\yosuke\\secret SYNTHETIC_SECRET_MARKER\n' })));
  assert.equal(secret.includes('SYNTHETIC_SECRET_MARKER') || secret.includes('yosuke'), false);
});

test('a helper that cannot be started is helper_unavailable (pre-send); one that never answers times out (post-send)', async () => {
  assert.deepEqual(await run({}, fakeSpawn({ throws: true })), { ok: false, code: 'helper_unavailable' });
  assert.deepEqual(await run({}, fakeSpawn({ errorBeforeSpawn: true })), { ok: false, code: 'helper_unavailable' });
  const hung = fakeSpawn({ hang: true });
  const started = Date.now();
  assert.deepEqual(await run({ timeoutMs: 100 }, hung), { ok: false, code: 'timeout' });
  assert.ok(Date.now() - started < 8000);
  assert.ok(hung.calls.killed >= 1, 'a hung helper is killed');
});

test('a missing, malformed, mismatched or modified helper is helper_unavailable and is never started', async () => {
  const cases = {
    'no manifest': (helperPath) => rmSync(`${helperPath}.manifest.json`),
    'manifest is not JSON': (helperPath) => writeFileSync(`${helperPath}.manifest.json`, 'nope'),
    'manifest is not a digest': (helperPath) => writeFileSync(`${helperPath}.manifest.json`, JSON.stringify({ sha256: 'ABC' })),
    'manifest has another digest': (helperPath) => writeFileSync(`${helperPath}.manifest.json`, JSON.stringify({ sha256: '0'.repeat(64) })),
    'helper bytes changed': (helperPath) => appendFileSync(helperPath, 'x'),
    'helper missing': (helperPath) => rmSync(helperPath),
  };
  for (const [label, tamper] of Object.entries(cases)) {
    const helperPath = makeHelper();
    tamper(helperPath);
    const fake = fakeSpawn({ stdout: line(SUCCESS) });
    assert.deepEqual(await run({}, fake, helperPath), { ok: false, code: 'helper_unavailable' }, label);
    assert.equal(fake.calls.spawns.length, 0, label);
  }
});

test('a bad request never reaches the helper', async () => {
  const cases = [
    [{ pipeName: '..\\x' }, 'invalid_pipe_name'],
    [{ receipt: 'SYNTHETIC_SECRET_MARKER' }, 'invalid_request'],
    [{ receipt: b64(2100) }, 'request_too_large'],
    [{ expect: undefined }, 'invalid_request'],
    [{ expect: { pid: 4242 } }, 'invalid_request'],
    [{ expect: { ownerSid: SID, pid: 4242, serviceName: 'AlberaHostBroker' } }, 'invalid_request'],
    [{ timeoutMs: 0 }, 'invalid_request'],
    [{ timeoutMs: 1.5 }, 'invalid_request'],
    [{ timeoutMs: BROKER_CLIENT_LIMITS.maxTimeoutMs + 1 }, 'invalid_request'],
  ];
  for (const [input, code] of cases) {
    const fake = fakeSpawn({ stdout: line(SUCCESS) });
    assert.deepEqual(await run(input, fake), { ok: false, code }, JSON.stringify(input));
    assert.equal(fake.calls.spawns.length, 0, JSON.stringify(input));
    assert.ok(BROKER_CLIENT_PRESEND_CODES.includes(code));
  }
  assert.deepEqual(await sendBrokerRequest(), { ok: false, code: 'invalid_pipe_name' });
});

test('default transport refuses to run off Windows instead of guessing a socket path', { skip: process.platform === 'win32' && 'Windows has a real default helper' }, async () => {
  assert.deepEqual(await sendBrokerRequest(goodRequest), { ok: false, code: 'unsupported_platform' });
});

test('the client is not imported by the Observer, entry layers, runtime modules or package wiring, and only launches the verified helper', () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? (entry.name === 'bin' || entry.name === 'obj' ? [] : walk(full)) : [full];
  });
  const self = path.join(root, 'src', 'runtime', 'windows-broker-client.mjs');
  const sources = walk(path.join(root, 'src')).filter((file) => /\.(?:mjs|js|html|json|css)$/u.test(file) && file !== self);
  assert.ok(sources.length > 50, 'the scan must cover the source tree');
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    assert.equal(/windows-broker-client/u.test(text), false, `${path.relative(root, file)} must not reference the Broker client`);
    assert.equal(/windows-broker-pipe-client|albera-windows-broker-pipe-client/u.test(text), false, `${path.relative(root, file)} must not name the pipe client helper`);
  }
  const manifest = readFileSync(path.join(root, 'package.json'), 'utf8');
  assert.equal(/windows-broker-client|windows-broker-pipe-client/u.test(manifest), false);
  const client = readFileSync(self, 'utf8');
  assert.equal(/node:net|net\.createConnection|\bexec\w*\(|\bfork\(|spawnSync|shell\s*:\s*true/u.test(client), false, 'no direct pipe and no shell');
  assert.deepEqual(client.match(/^import .*child_process.*$/gmu), ["import { spawn } from 'node:child_process';"]);
  assert.equal([...client.matchAll(/\bspawn\(|spawnImpl\(/gu)].length, 1, 'one launch site');
  assert.match(client, /await verifyHelper\(helperPath,[^\n]*\);\n[^\n]*\n?[^\n]*runHelper\(/u, 'the digest is verified before the helper is launched');
});
