import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';
import {
  AUTHORITY_CLIENT_ERROR_CODES,
  AUTHORITY_CLIENT_LIMITS,
  AUTHORITY_CLIENT_PRESEND_CODES,
  AUTHORITY_REPLY_CODES,
  AuthorityClientError,
  authoritySubmitPipeName,
  buildStatusRequestText,
  buildSubmitRequestText,
  getApprovalStatus,
  parseHelperResult,
  submitApproval,
  validateServerExpectation,
  validateStatusResponse,
  validateSubmitResponse,
} from '../src/runtime/approval-authority-client.mjs';

// Pure and fake-helper tests: they run on every OS and need neither .NET nor a real pipe. The real helper against the real Authority is exercised by
// runtime-approval-authority-client.integration.test.mjs (Windows only).
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const EXPECT = { ownerSid: SID, pid: 4242 };
const PIPE_ROOT = 'TestRoot\\Authority\\t0123456789ab';
const APPROVAL_ID = '3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';
const CHALLENGE = '_-7dzLuqmYh3ZlVEMyIRAA';
const ACTION = { action: 'environment.start', projectId: 'proj-alpha', computerId: 'pc-01', args: { vmName: 'alpha', cpu: 2, fast: true } };
const FIELDS = { purpose: 'broker.operation', operationId: 'op-1', idempotencyKey: 'idem-1', leaseId: 'lease-1', leaseGeneration: 7, brokerEpoch: 3, brokerChallenge: CHALLENGE, action: ACTION };
const PENDING = { ok: true, state: 'pending', expiresAt: 1800000120 };
const SUBMITTED = { ok: true, approvalId: APPROVAL_ID, state: 'pending', expiresAt: 1800000120 };
const codeOf = (fn) => { try { fn(); } catch (error) { assert.ok(error instanceof AuthorityClientError); return error.code; } return null; };
const line = (value) => `${typeof value === 'string' ? value : JSON.stringify(value)}\n`;

/** A structurally valid receipt v2 for APPROVAL_ID (the signature is not checked by the client). */
const receiptFor = (overrides = {}) => Buffer.from(JSON.stringify({
  v: 2, kid: 'authority-key-test', issuer: 'albera-test-approval-authority', audience: 'albera-host-broker', purpose: 'broker.operation', approvalId: APPROVAL_ID,
  receiptId: '7c9e6679-7425-4f40-8b2b-8d7d6a5f1c11', nonce: 'AAAAAAAAAAAAAAAAAAAAAA', operationId: 'op-1', idempotencyKey: 'idem-1', action: 'environment.start',
  actionDigest: computeActionDigest('broker.operation', ACTION), projectId: 'proj-alpha', computerId: 'pc-01', leaseId: 'lease-1', leaseGeneration: 7, brokerEpoch: 3,
  brokerChallenge: CHALLENGE, policyVersion: 'policy-test', approverKeyId: 'hello-key-test', iat: 1800000000, exp: 1800000120, ...overrides,
}), 'utf8');
const SIGNATURE = Buffer.alloc(64, 7).toString('base64');
const APPROVED = { ok: true, state: 'approved', receipt: receiptFor().toString('base64'), signature: SIGNATURE };

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'albera-authority-client-unit-'));
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
const connection = (fake, helperPath = makeHelper()) => ({ pipeRoot: PIPE_ROOT, expect: EXPECT, helperPath, spawnImpl: fake.spawnImpl });
const submit = (options = {}, fake = fakeSpawn({ stdout: line(SUBMITTED) }), helperPath) => submitApproval({ ...FIELDS, ...connection(fake, helperPath), ...options });
const status = (options = {}, fake = fakeSpawn({ stdout: line(PENDING) }), helperPath) => getApprovalStatus({ approvalId: APPROVAL_ID, ...connection(fake, helperPath), ...options });

test('the submit pipe is <root>\\submit\\v1 for a root of plain tokens, and nothing can leave the pipe namespace', () => {
  assert.equal(authoritySubmitPipeName(PIPE_ROOT), `${PIPE_ROOT}\\submit\\v1`);
  assert.equal(authoritySubmitPipeName('Root'), 'Root\\submit\\v1');
  const long = 'x'.repeat(128);
  for (const bad of ['', '\\', 'a\\', '\\a', 'a\\\\b', '..', 'a\\..\\b', 'a/b', '\\\\.\\pipe\\x', 'a.b', 'a b', 'a\nb', 'x'.repeat(129), `${long}\\${long}\\x`, 'a\\b\\c\\d\\e', undefined, null, 12, {}, ['a']]) {
    assert.equal(codeOf(() => authoritySubmitPipeName(bad)), 'invalid_pipe_name', String(bad));
  }
});

test('the submit request has exactly the Authority keys in a fixed order, the validated DTO, and no digest unless asked', () => {
  const text = buildSubmitRequestText(FIELDS);
  assert.deepEqual(Object.keys(JSON.parse(text)), ['v', 'verb', 'purpose', 'operationId', 'idempotencyKey', 'leaseId', 'leaseGeneration', 'brokerEpoch', 'brokerChallenge', 'action']);
  assert.deepEqual(JSON.parse(text), { v: 1, verb: 'submit', ...FIELDS });
  assert.deepEqual(Object.keys(JSON.parse(text).action), ['action', 'projectId', 'computerId', 'args']);
  const withDigest = JSON.parse(buildSubmitRequestText({ ...FIELDS, includeDigest: true }));
  assert.equal(withDigest.expectedDigest, computeActionDigest('broker.operation', ACTION));
  assert.deepEqual(Object.keys(withDigest).slice(-2), ['action', 'expectedDigest']);
  assert.equal('expectedDigest' in JSON.parse(buildSubmitRequestText({ ...FIELDS, includeDigest: false })), false);
});

test('strings reach the wire exactly as given: NFC and NFD forms stay different, nothing is normalised', () => {
  const nfc = 'caf\u00e9';
  const nfd = 'cafe\u0301';
  const a = JSON.parse(buildSubmitRequestText({ ...FIELDS, action: { ...ACTION, args: { label: nfc } } }));
  const b = JSON.parse(buildSubmitRequestText({ ...FIELDS, action: { ...ACTION, args: { label: nfd } } }));
  assert.equal(a.action.args.label, nfc);
  assert.equal(b.action.args.label, nfd);
  assert.notEqual(a.action.args.label, b.action.args.label);
});

test('the submit request is strict: every field, the DTO, unknown options and the 2 KiB bound', () => {
  const cases = {
    'unknown option': { receipt: 'x' }, 'extra field': { operationId2: 'x' },
    'purpose': { purpose: 'shell.exec' }, 'no purpose': { purpose: undefined },
    'operationId': { operationId: 'bad id' }, 'operationId type': { operationId: 7 }, 'idempotencyKey': { idempotencyKey: '' }, 'leaseId': { leaseId: '-x' },
    'leaseGeneration 0': { leaseGeneration: 0 }, 'leaseGeneration float': { leaseGeneration: 1.5 }, 'leaseGeneration string': { leaseGeneration: '7' }, 'brokerEpoch 0': { brokerEpoch: 0 },
    'brokerEpoch unsafe': { brokerEpoch: 2 ** 53 }, 'challenge short': { brokerChallenge: 'abc' }, 'challenge non-canonical': { brokerChallenge: '_-7dzLuqmYh3ZlVEMyIRAB' },
    'includeDigest type': { includeDigest: 'yes' },
    'action not an object': { action: 'environment.start' }, 'action null': { action: null },
    'action name': { action: { ...ACTION, action: 'environment.format' } }, 'action for the other purpose': { action: { ...ACTION, action: 'task.start' } },
    'action extra key': { action: { ...ACTION, extra: 1 } }, 'action missing key': { action: { action: ACTION.action, projectId: 'p', args: {} } },
    'args nested': { action: { ...ACTION, args: { a: { b: 1 } } } }, 'args array': { action: { ...ACTION, args: [] } }, 'args null value': { action: { ...ACTION, args: { a: null } } },
    'args float': { action: { ...ACTION, args: { a: 1.5 } } }, 'args control char': { action: { ...ACTION, args: { a: 'x\ny' } } }, 'args bidi': { action: { ...ACTION, args: { a: 'x\u202ey' } } },
    'args lone surrogate': { action: { ...ACTION, args: { a: '\ud800' } } }, 'args key': { action: { ...ACTION, args: { 'Bad-Key': 1 } } },
    'args too long': { action: { ...ACTION, args: { a: 'x'.repeat(257) } } },
    'projectId': { action: { ...ACTION, projectId: 'a b' } },
  };
  for (const [label, override] of Object.entries(cases)) assert.equal(codeOf(() => buildSubmitRequestText({ ...FIELDS, ...override })), 'invalid_request', label);
  assert.equal(codeOf(() => buildSubmitRequestText()), 'invalid_request');
  assert.equal(codeOf(() => buildSubmitRequestText(null)), 'invalid_request');
  assert.equal(codeOf(() => buildSubmitRequestText([])), 'invalid_request');
  assert.equal(AUTHORITY_CLIENT_LIMITS.maxRequestBytes, 2048);
  const many = Object.fromEntries(Array.from({ length: 16 }, (_, n) => [`k${n}`, 'é'.repeat(100)])); // valid for the contract, far above one frame
  assert.equal(codeOf(() => buildSubmitRequestText({ ...FIELDS, action: { ...ACTION, args: many } })), 'request_too_large');
  const wire = buildSubmitRequestText({ ...FIELDS, action: { ...ACTION, args: { a: 'é'.repeat(100) } } });
  assert.ok(Buffer.byteLength(wire) > wire.length, 'the bound is measured in UTF-8 bytes');
});

test('the status request carries only a uuid approval id', () => {
  assert.deepEqual(JSON.parse(buildStatusRequestText({ approvalId: APPROVAL_ID })), { v: 1, verb: 'status', approvalId: APPROVAL_ID });
  for (const bad of [undefined, null, '', 'x', APPROVAL_ID.toUpperCase(), `${APPROVAL_ID}\n`, `${APPROVAL_ID}0`, '3f2b8c1e-5d4a-0b6f-9a7e-0c1d2e3f4a5b', 7, {}]) {
    assert.equal(codeOf(() => buildStatusRequestText({ approvalId: bad })), 'invalid_request', String(bad));
  }
  assert.equal(codeOf(() => buildStatusRequestText()), 'invalid_request');
});

test('the submit reply schema is fixed: only the success and the Authority failure shapes pass, as fresh frozen objects', () => {
  const ok = validateSubmitResponse(SUBMITTED);
  assert.deepEqual(ok, SUBMITTED);
  assert.notEqual(ok, SUBMITTED);
  assert.ok(Object.isFrozen(ok));
  assert.deepEqual(validateSubmitResponse({ ...SUBMITTED, state: 'approved' }), { ...SUBMITTED, state: 'approved' });
  for (const code of AUTHORITY_REPLY_CODES) assert.deepEqual(validateSubmitResponse({ ok: false, code }), { ok: false, code });
  const bad = [
    null, undefined, 'ok', 7, [], [SUBMITTED], {}, { ok: true }, { ok: false }, { ...SUBMITTED, extra: 1 }, { ...SUBMITTED, state: 'denied' }, { ...SUBMITTED, state: 'APPROVED' },
    { ...SUBMITTED, approvalId: 'x' }, { ...SUBMITTED, approvalId: undefined }, { ...SUBMITTED, expiresAt: 0 }, { ...SUBMITTED, expiresAt: '1800000120' }, { ...SUBMITTED, expiresAt: 1.5 },
    { ...SUBMITTED, ok: 'true' }, { ok: true, state: 'pending', expiresAt: 1800000120 }, { ...APPROVED },
    { ok: false, code: 'SYNTHETIC_SECRET_MARKER' }, { ok: false, code: 'timeout' }, { ok: false, code: 'server_identity_mismatch' }, { ok: false, code: 'denied' }, { ok: false, code: 'human_denied', extra: 'C:\\Users\\secret' },
    { ok: true, code: 'human_denied' }, Object.create(SUBMITTED),
  ];
  for (const value of bad) assert.equal(codeOf(() => validateSubmitResponse(value)), 'invalid_response', JSON.stringify(value));
});

test('the status reply schema: pending, or approved with a canonical base64 receipt that parses as receipt v2 for this approval and a 64-byte signature', () => {
  assert.deepEqual(validateStatusResponse(PENDING, APPROVAL_ID), PENDING);
  assert.ok(Object.isFrozen(validateStatusResponse(PENDING, APPROVAL_ID)));
  assert.deepEqual(validateStatusResponse(APPROVED, APPROVAL_ID), APPROVED);
  for (const code of AUTHORITY_REPLY_CODES) assert.deepEqual(validateStatusResponse({ ok: false, code }, APPROVAL_ID), { ok: false, code });
  const otherApproval = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
  const bad = [
    null, [], {}, { ok: true }, { ...PENDING, extra: 1 }, { ...PENDING, state: 'approved' }, { ...PENDING, expiresAt: 0 }, { ...APPROVED, extra: 1 }, { ...APPROVED, state: 'pending' },
    { ok: true, state: 'approved', receipt: APPROVED.receipt }, { ok: true, state: 'approved', signature: SIGNATURE },
    { ...APPROVED, expiresAt: 1800000120 }, { ...PENDING, receipt: APPROVED.receipt },
    { ...APPROVED, receipt: '' }, { ...APPROVED, receipt: 'not base64!' }, { ...APPROVED, receipt: APPROVED.receipt.replace(/=+$/u, '') }, { ...APPROVED, receipt: Buffer.from('{}').toString('base64') },
    { ...APPROVED, receipt: Buffer.from('not json').toString('base64') }, { ...APPROVED, receipt: receiptFor({ v: 1 }).toString('base64') },
    { ...APPROVED, receipt: receiptFor({ approvalId: otherApproval }).toString('base64') }, { ...APPROVED, receipt: receiptFor({ extra: 1 }).toString('base64') },
    { ...APPROVED, receipt: Buffer.alloc(1281, 0x20).toString('base64') },
    { ...APPROVED, signature: '' }, { ...APPROVED, signature: Buffer.alloc(63, 7).toString('base64') }, { ...APPROVED, signature: Buffer.alloc(65, 7).toString('base64') }, { ...APPROVED, signature: 'AAAA' },
    { ok: false, code: 'denied' }, { ok: false, code: 'SYNTHETIC_SECRET_MARKER' }, { ok: false, code: 'request_invalid', extra: 1 },
  ];
  for (const value of bad) assert.equal(codeOf(() => validateStatusResponse(value, APPROVAL_ID)), 'invalid_response', JSON.stringify(value).slice(0, 120));
});

test('the status reply also takes a receipt v3 (basis presence or policy, policy hash) for this approval, and nothing with another basis or a v2-style label', () => {
  const POLICY_HASH = `sha256:${'ef'.repeat(32)}`;
  const v3 = (overrides = {}) => ({ ...APPROVED, receipt: receiptFor({ v: 3, policyVersion: POLICY_HASH, basis: 'policy', action: 'environment.stop', actionDigest: computeActionDigest('broker.operation', { ...ACTION, action: 'environment.stop' }), ...overrides }).toString('base64') });
  assert.deepEqual(validateStatusResponse(v3(), APPROVAL_ID), v3());
  assert.deepEqual(validateStatusResponse(v3({ basis: 'presence' }), APPROVAL_ID), v3({ basis: 'presence' }));
  for (const overrides of [{ basis: 'grant:g-1' }, { basis: 'approved' }, { basis: undefined }, { policyVersion: 'policy-test' }, { extra: 1 }, { approvalId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' }]) {
    assert.equal(codeOf(() => validateStatusResponse(v3(overrides), APPROVAL_ID)), 'invalid_response', JSON.stringify(overrides));
  }
  assert.equal(codeOf(() => validateStatusResponse({ ...APPROVED, receipt: receiptFor({ basis: 'policy' }).toString('base64') }, APPROVAL_ID)), 'invalid_response', 'a v2 body with a basis is neither v2 nor v3');
});

test('the error code lists agree: pre-send codes are a subset, and no post-send or Authority code can look retry-safe', () => {
  assert.ok(AUTHORITY_CLIENT_ERROR_CODES.every((code) => /^[a-z_]+$/u.test(code)));
  assert.equal(new Set(AUTHORITY_CLIENT_ERROR_CODES).size, AUTHORITY_CLIENT_ERROR_CODES.length, 'no code listed twice');
  for (const code of AUTHORITY_CLIENT_PRESEND_CODES) assert.ok(AUTHORITY_CLIENT_ERROR_CODES.includes(code), code);
  for (const code of ['server_identity_mismatch', 'server_identity_unavailable', 'helper_unavailable', 'authority_unreachable', 'access_denied']) assert.ok(AUTHORITY_CLIENT_PRESEND_CODES.includes(code), code);
  for (const code of [...AUTHORITY_REPLY_CODES, 'timeout', 'transport_error', 'invalid_response', 'response_too_large']) assert.equal(AUTHORITY_CLIENT_PRESEND_CODES.includes(code), false, code);
  for (const code of ['broker_unavailable', 'denied']) assert.equal(AUTHORITY_CLIENT_ERROR_CODES.includes(code), false, `${code} is the Broker's word`);
  assert.ok(Object.isFrozen(AUTHORITY_CLIENT_PRESEND_CODES) && Object.isFrozen(AUTHORITY_CLIENT_ERROR_CODES) && Object.isFrozen(AUTHORITY_REPLY_CODES));
  assert.equal(new AuthorityClientError('C:\\secret').code, 'transport_error');
  assert.equal(new AuthorityClientError('C:\\secret').message, 'transport_error');
});

test('the reply codes match the Authority\'s own list and the pipe client helper\'s allow-list (no drift)', () => {
  const authority = readFileSync(path.join(root, 'src', 'runtime', 'windows-approval-authority', 'ReceiptBuilder.cs'), 'utf8');
  const fromAuthority = [...authority.slice(authority.indexOf('class AuthorityCodes')).split('}')[0].matchAll(/= "([a-z_]+)"/gu)].map((m) => m[1]);
  const helper = readFileSync(path.join(root, 'src', 'runtime', 'windows-broker-pipe-client', 'Program.cs'), 'utf8');
  const fromHelper = [...helper.match(/AuthorityCodes = \[([^\]]*)\]/u)[1].matchAll(/"([a-z_]+)"/gu)].map((m) => m[1]);
  assert.deepEqual([...AUTHORITY_REPLY_CODES].sort(), [...fromAuthority].sort());
  assert.deepEqual([...AUTHORITY_REPLY_CODES].sort(), [...fromHelper].sort());
});

test('the server expectation is exact: an owner SID with either a PID or a service name, an optional lowercase image hash, nothing else', () => {
  assert.deepEqual(validateServerExpectation({ ownerSid: SID, pid: 4242, imageSha256: 'a'.repeat(64) }), { ownerSid: SID, pid: 4242, imageSha256: 'a'.repeat(64) });
  assert.deepEqual(validateServerExpectation({ serviceName: 'SomeService' }), { serviceName: 'SomeService' }, 'service mode derives the owner from the service');
  const bad = [
    undefined, null, [], 'pid', {}, { ownerSid: SID }, { pid: 4242 }, { ownerSid: SID, pid: 4242, serviceName: 'X' }, { ownerSid: SID, pid: 0 }, { ownerSid: SID, pid: 1.5 }, { ownerSid: SID, pid: 2 ** 32 },
    { ownerSid: 'S-1', pid: 4242 }, { ownerSid: `${SID}\n`, pid: 4242 }, { ownerSid: SID, serviceName: '..\\x' }, { ownerSid: SID, pid: 4242, imageSha256: 'A'.repeat(64) }, { ownerSid: SID, pid: 4242, extra: 1 },
  ];
  for (const value of bad) assert.equal(codeOf(() => validateServerExpectation(value)), 'invalid_request', JSON.stringify(value));
});

test('helper output: only the Authority shapes and the helper failure codes pass, tied to the exit code; everything else is a post-send transport_error', () => {
  const validate = validateSubmitResponse;
  assert.deepEqual(parseHelperResult(line(SUBMITTED), 0, validate), SUBMITTED);
  assert.deepEqual(parseHelperResult(JSON.stringify(SUBMITTED), 0, validate), SUBMITTED, 'the trailing newline is optional');
  assert.deepEqual(parseHelperResult(`${JSON.stringify(SUBMITTED)}\r\n`, 0, validate), SUBMITTED, 'the helper writes CRLF on Windows');
  for (const code of ['access_denied', 'server_identity_mismatch', 'server_identity_unavailable', 'timeout', 'response_too_large', 'invalid_response', 'transport_error', ...AUTHORITY_REPLY_CODES]) {
    assert.deepEqual(parseHelperResult(line({ ok: false, code }), 0, validate), { ok: false, code }, code);
  }
  assert.deepEqual(parseHelperResult(line({ ok: false, code: 'broker_unavailable' }), 0, validate), { ok: false, code: 'authority_unreachable' }, 'the helper\'s word for an unreachable pipe');
  assert.deepEqual(parseHelperResult(line({ ok: false, code: 'invalid_request' }), 64, validate), { ok: false, code: 'invalid_request' });
  assert.deepEqual(parseHelperResult(line({ ok: false, code: 'server_identity_unavailable' }), 70, validate), { ok: false, code: 'server_identity_unavailable' });
  const transport = { ok: false, code: 'transport_error' };
  const cases = [
    [line(SUBMITTED), 1], [line(SUBMITTED), 64], [line(SUBMITTED), 70], [line(SUBMITTED), null], [line(SUBMITTED), 3221225781],
    [line({ ok: false, code: 'human_denied' }), 64], [line({ ok: false, code: 'timeout' }), 70], [line({ ok: false, code: 'server_identity_mismatch' }), 70], [line({ ok: false, code: 'invalid_request' }), 0],
    ['', 0], ['\n', 0], ['not json\n', 0], [`${line(SUBMITTED)}${line(SUBMITTED)}`, 0], [`${line(SUBMITTED)}trailing`, 0], ['[]\n', 0], ['null\n', 0], ['7\n', 0],
    [line({ ok: false, code: 'human_denied', detail: 'C:\\Users\\secret' }), 0], [line({ ok: false, code: 'SYNTHETIC_SECRET_MARKER' }), 0], [line({ ok: false, code: 'denied' }), 0],
    [line({ ok: false, code: 'helper_unavailable' }), 0], [line({ ok: false, code: 'request_too_large' }), 0], [line({ ok: false, code: 'unsupported_platform' }), 0], [line({ ok: false, code: 'authority_unreachable' }), 0],
    [line({ ...SUBMITTED, extra: 1 }), 0], [line({ ...SUBMITTED, state: 'denied' }), 0], [line(PENDING), 0], [line({ ok: 'yes' }), 0], [undefined, 0], [null, 0], [Buffer.from(line(SUBMITTED)), 0],
  ];
  for (const [stdout, exitCode] of cases) assert.deepEqual(parseHelperResult(stdout, exitCode, validate), transport, `${String(stdout)} / ${exitCode}`);
});

test('submit sends one JSON line to a verified helper, started without a shell or arguments, with the request as text, and returns the validated reply', async () => {
  const fake = fakeSpawn({ stdout: line(SUBMITTED) });
  const helperPath = makeHelper();
  assert.deepEqual(await submit({ timeoutMs: 1234, includeDigest: true }, fake, helperPath), SUBMITTED);
  assert.equal(fake.calls.spawns.length, 1);
  const [{ command, args, options }] = fake.calls.spawns;
  assert.equal(command, helperPath);
  assert.deepEqual(args, []);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.ok(fake.calls.input.endsWith('\n') && fake.calls.input.indexOf('\n') === fake.calls.input.length - 1, 'exactly one line');
  const sent = JSON.parse(fake.calls.input);
  assert.deepEqual(Object.keys(sent), ['pipeName', 'authority', 'timeoutMs', 'expect']);
  assert.deepEqual({ ...sent, authority: undefined }, { pipeName: `${PIPE_ROOT}\\submit\\v1`, authority: undefined, timeoutMs: 1234, expect: EXPECT });
  assert.equal(sent.authority, buildSubmitRequestText({ ...FIELDS, includeDigest: true }), 'the helper receives the exact request text');
  assert.ok(fake.calls.killed >= 1, 'the helper is always cleaned up');
});

test('status sends the status request text and returns pending or the approved receipt', async () => {
  const fake = fakeSpawn({ stdout: line(APPROVED) });
  assert.deepEqual(await status({}, fake), APPROVED);
  assert.equal(JSON.parse(fake.calls.input).authority, buildStatusRequestText({ approvalId: APPROVAL_ID }));
  assert.deepEqual(await status({}, fakeSpawn({ stdout: line(PENDING) })), PENDING);
  assert.deepEqual(await status({}, fakeSpawn({ stdout: line({ ok: false, code: 'human_denied' }) })), { ok: false, code: 'human_denied' });
});

test('a receipt that names another approval, or is not a receipt, is never passed on', async () => {
  const other = { ...APPROVED, receipt: receiptFor({ approvalId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' }).toString('base64') };
  assert.deepEqual(await status({}, fakeSpawn({ stdout: line(other) })), { ok: false, code: 'transport_error' });
  assert.deepEqual(await status({}, fakeSpawn({ stdout: line({ ...APPROVED, receipt: Buffer.from('{"x":1}').toString('base64') }) })), { ok: false, code: 'transport_error' });
  assert.deepEqual(await submit({}, fakeSpawn({ stdout: line(APPROVED) })), { ok: false, code: 'transport_error' }, 'a status-shaped reply is not a submit reply');
});

test('helper failure lines come back as their fixed code, and pre-send ones are listed as retry-safe', async () => {
  for (const [helperCode, code] of [['server_identity_mismatch', 'server_identity_mismatch'], ['server_identity_unavailable', 'server_identity_unavailable'], ['broker_unavailable', 'authority_unreachable'], ['access_denied', 'access_denied']]) {
    const result = await submit({}, fakeSpawn({ stdout: line({ ok: false, code: helperCode }) }));
    assert.deepEqual(result, { ok: false, code });
    assert.ok(AUTHORITY_CLIENT_PRESEND_CODES.includes(result.code), code);
  }
  for (const code of ['timeout', 'invalid_response', 'transport_error', 'response_too_large', ...AUTHORITY_REPLY_CODES]) {
    const result = await submit({}, fakeSpawn({ stdout: line({ ok: false, code }) }));
    assert.deepEqual(result, { ok: false, code });
    assert.equal(AUTHORITY_CLIENT_PRESEND_CODES.includes(result.code), false, code);
  }
});

test('a crashed, silent, flooding or lying helper is a post-send transport_error without raw text', async () => {
  const transport = { ok: false, code: 'transport_error' };
  assert.deepEqual(await submit({}, fakeSpawn({ stdout: '', exitCode: 0 })), transport);
  assert.deepEqual(await submit({}, fakeSpawn({ stdout: '', exitCode: 3221225781 })), transport);
  assert.deepEqual(await submit({}, fakeSpawn({ stdout: line(SUBMITTED), exitCode: 1 })), transport);
  assert.deepEqual(await submit({}, fakeSpawn({ stdout: `${'x'.repeat(17_000)}\n`, exitCode: 0 })), transport);
  const secret = JSON.stringify(await submit({}, fakeSpawn({ stdout: 'C:\\Users\\yosuke\\secret SYNTHETIC_SECRET_MARKER\n' })));
  assert.equal(secret.includes('SYNTHETIC_SECRET_MARKER') || secret.includes('yosuke'), false);
});

test('a helper that cannot be started is helper_unavailable (pre-send); one that never answers times out (post-send)', async () => {
  assert.deepEqual(await submit({}, fakeSpawn({ throws: true })), { ok: false, code: 'helper_unavailable' });
  assert.deepEqual(await submit({}, fakeSpawn({ errorBeforeSpawn: true })), { ok: false, code: 'helper_unavailable' });
  const hung = fakeSpawn({ hang: true });
  const started = Date.now();
  assert.deepEqual(await submit({ timeoutMs: 100 }, hung), { ok: false, code: 'timeout' });
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
    const fake = fakeSpawn({ stdout: line(SUBMITTED) });
    assert.deepEqual(await submit({}, fake, helperPath), { ok: false, code: 'helper_unavailable' }, label);
    assert.equal(fake.calls.spawns.length, 0, label);
  }
});

test('a bad request never reaches the helper', async () => {
  const cases = [
    [{ pipeRoot: '..\\x' }, 'invalid_pipe_name'], [{ pipeRoot: undefined }, 'invalid_pipe_name'], [{ pipeRoot: 'a\\' }, 'invalid_pipe_name'],
    [{ operationId: 'SYNTHETIC SECRET' }, 'invalid_request'], [{ brokerChallenge: 'short' }, 'invalid_request'], [{ action: { ...ACTION, action: 'rm.rf' } }, 'invalid_request'],
    [{ unknownOption: 1 }, 'invalid_request'], [{ approvalId: APPROVAL_ID }, 'invalid_request'],
    [{ action: { ...ACTION, args: Object.fromEntries(Array.from({ length: 16 }, (_, n) => [`k${n}`, 'x'.repeat(200)])) } }, 'request_too_large'],
    [{ expect: undefined }, 'invalid_request'], [{ expect: { pid: 4242 } }, 'invalid_request'], [{ expect: { ownerSid: SID, pid: 4242, serviceName: 'Svc' } }, 'invalid_request'],
    [{ timeoutMs: 0 }, 'invalid_request'], [{ timeoutMs: 1.5 }, 'invalid_request'], [{ timeoutMs: AUTHORITY_CLIENT_LIMITS.maxTimeoutMs + 1 }, 'invalid_request'],
  ];
  for (const [input, code] of cases) {
    const fake = fakeSpawn({ stdout: line(SUBMITTED) });
    assert.deepEqual(await submit(input, fake), { ok: false, code }, JSON.stringify(input));
    assert.equal(fake.calls.spawns.length, 0, JSON.stringify(input));
    assert.ok(AUTHORITY_CLIENT_PRESEND_CODES.includes(code));
  }
  for (const [input, code] of [[{ approvalId: 'nope' }, 'invalid_request'], [{ operationId: 'x' }, 'invalid_request'], [{ pipeRoot: '' }, 'invalid_pipe_name']]) {
    const fake = fakeSpawn({ stdout: line(PENDING) });
    assert.deepEqual(await status(input, fake), { ok: false, code }, JSON.stringify(input));
    assert.equal(fake.calls.spawns.length, 0);
  }
  assert.deepEqual(await submitApproval(), { ok: false, code: 'invalid_pipe_name' });
  assert.deepEqual(await getApprovalStatus(), { ok: false, code: 'invalid_pipe_name' });
});

test('default transport refuses to run off Windows instead of guessing a socket path', { skip: process.platform === 'win32' && 'Windows has a real default helper' }, async () => {
  assert.deepEqual(await submitApproval({ ...FIELDS, pipeRoot: PIPE_ROOT, expect: EXPECT }), { ok: false, code: 'unsupported_platform' });
  assert.deepEqual(await getApprovalStatus({ approvalId: APPROVAL_ID, pipeRoot: PIPE_ROOT, expect: EXPECT }), { ok: false, code: 'unsupported_platform' });
});

test('the client opens no pipe or socket itself, has one launch site after the digest check, only names the submit pipe, and nothing else imports it', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? (entry.name === 'bin' || entry.name === 'obj' ? [] : walk(full)) : [full];
  });
  const self = path.join(root, 'src', 'runtime', 'approval-authority-client.mjs');
  const client = readFileSync(self, 'utf8');
  assert.equal(/node:net|net\.createConnection|\bexec\w*\(|\bfork\(|spawnSync|shell\s*:\s*true/u.test(client), false, 'no direct pipe and no shell');
  assert.deepEqual(client.match(/^import .*child_process.*$/gmu), ["import { spawn } from 'node:child_process';"]);
  assert.equal([...client.matchAll(/\bspawn\(|spawnImpl\(/gu)].length, 1, 'one launch site');
  assert.match(client, /await verifyHelper\(helperPath,[^\n]*\);\n[^\n]*\n?[^\n]*runHelper\(/u, 'the digest is verified before the helper is launched');
  assert.equal(/approver\\\\v1|verb: '(?:list|decide)'|'(?:list|decide)'/u.test(client.replace(/^\s*\/\/.*$/gmu, '')), false, 'the client has no way to reach the approver pipe or to decide');
  assert.deepEqual(client.match(/^.*windows-broker-pipe-client.*$/gmu).map((l) => /\/\/ arch-allow: \S/u.test(l)), [true], 'the helper path is named once, with an arch-allow reason');
  assert.equal(/windows-broker-client/u.test(client), false, 'it does not import the Broker client (the two stay independent)');
  const sources = walk(path.join(root, 'src')).filter((file) => /\.(?:mjs|js|html|json|css)$/u.test(file) && file !== self);
  assert.ok(sources.length > 50, 'the scan must cover the source tree');
  for (const file of sources) assert.equal(/approval-authority-client/u.test(readFileSync(file, 'utf8')), false, `${path.relative(root, file)} must not reference the Authority client`);
  assert.equal(/approval-authority-client|build:approval-authority/u.test(readFileSync(path.join(root, 'package.json'), 'utf8').replace(/"build:approval-authority":[^\n]*/u, '')), false);
});

test('the pipe client helper takes the Authority request as text, bounds it, and relays only the Authority\'s fixed codes (source guard, any OS)', () => {
  const helper = readFileSync(path.join(root, 'src', 'runtime', 'windows-broker-pipe-client', 'Program.cs'), 'utf8');
  const code = helper.replace(/^\s*\/\/.*$/gmu, '');
  assert.match(code, /"pipeName", "receipt", "signature", "fence", "inspect", "authority", "timeoutMs", "expect"/u, 'one more optional request key, nothing else');
  assert.match(code, /Text\(root, "verb"\) is "submit" or "status"/u, 'only the submit pipe verbs');
  assert.match(code, /Encoding\.UTF8\.GetByteCount\(requestBody\) > MaxRequestBytes/u, 'the 2 KiB bound is in bytes');
  assert.match(code, /input\.Authority \? MaxAuthorityResponseBytes : MaxResponseBytes/u);
  assert.match(code, /value\.Split\(\(char\)92\)\.All\(segment => IsToken\(segment, 128, "_-", false\)\)/u, 'pipe path: tokens only, no empty segment, no dot');
  // Same order as before: SQOS open, owner, PID, session, image, and only then the write. The Authority request kind added no earlier write.
  assert.ok(code.indexOf('SecurityIdentification') < code.indexOf('GetOwner(') && code.indexOf('GetNamedPipeServerProcessId(pipe') < code.indexOf('pipe.Write('));
  assert.equal([...code.matchAll(/pipe\.Write\(/gu)].length, 1, 'one write site');
});

test('status reads approvalId once: a caller object that changes approvalId during the I/O cannot make the client accept another approval', async () => {
  const other = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
  const forOther = { ...APPROVED, receipt: receiptFor({ approvalId: other }).toString('base64') };
  let reads = 0;
  const fake = fakeSpawn({ stdout: line(forOther) });
  const options = { ...connection(fake), get approvalId() { reads += 1; return reads === 1 ? APPROVAL_ID : other; } };
  const result = await getApprovalStatus(options);
  assert.equal(result.ok, false, 'the receipt for another approval is never accepted');
  assert.equal(reads, 1, 'approvalId is read exactly once');
});
