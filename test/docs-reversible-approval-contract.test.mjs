// ADR-002 "Amendment 2026-11-04" (reversible approval on the production Broker; Proposed, docs tier): the contract tests of PR1.
// Two things are pinned and nothing runs: (1) src/runtime/broker-contract/broker-vm-wire-vectors.json, the sample traffic of the new `_vm` pipe and of the two new claim actions,
// against a reference checker written here from the Amendment (keys, limits, value ranges); (2) the Amendment text in docs/architecture/adr-002-host-broker-trust-contract.md,
// against the file and against itself (every NOT VERIFIED row names a measurement, every reference points at a defined row). No Broker, VM, WMI or key is involved, so it runs on every OS.
// When PR3 to PR5 implement the traffic, THEIR tests must read the same file; a change to a number here is a change to the Amendment.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ACTIONS_BY_PURPOSE, ActionDigestError, ID_PATTERN, computeActionDigest, validateActionDto } from '../src/runtime/broker-contract/action-digest.mjs';
import { NetworkAttestationError, verifyNetworkAttestation } from '../src/runtime/broker-contract/network-attestation.mjs';
import { parseStrictJson } from '../src/runtime/broker-contract/strict-json.mjs';
import { TaskStartAttestationError, createTaskStartAttestation, provesCheckpointedNoNetwork, signTaskStartAttestation, verifyTaskStartAttestation } from '../src/runtime/broker-contract/task-start-attestation.mjs';
import { createEcdsaAttestationSigner, createEcdsaAttestationVerifier } from '../src/runtime/ecdsa-attestation-signer.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vectors = JSON.parse(readFileSync(path.join(root, 'src', 'runtime', 'broker-contract', 'broker-vm-wire-vectors.json'), 'utf8'));
const adr = readFileSync(path.join(root, 'docs', 'architecture', 'adr-002-host-broker-trust-contract.md'), 'utf8');
const tiers = readFileSync(path.join(root, 'docs', 'architecture', 'approval-tiers.md'), 'utf8');

// ---- what the Amendment fixes (the numbers and word sets live HERE as well as in the file: a drift in either fails) ----
const LIMITS = Object.freeze({
  vmPipeSuffix: '_vm', pipeInstances: 4, maxRequestBytes: 4096, maxVmReplyBytes: 2048, maxClaimReplyBytes: 256, maxIdLength: 64, counterMin: 1, counterMax: Number.MAX_SAFE_INTEGER,
  attestationTtlSeconds: 60, clientTimeoutSeconds: 180, brokerDeadlineSeconds: 150, restoreWaitSeconds: 300,
});
const ENUMS = Object.freeze({
  vmRequestKinds: ['vmState', 'attestTaskStart', 'attestNetwork'],
  vmState: ['ready', 'restoring', 'fenced'],
  recordedStates: ['UNKNOWN', 'APPLIED', 'NOT_APPLIED'],
  claimActions: ['synthetic.noop', 'task.start', 'environment.start', 'environment.restore_checkpoint'],
  refusalCode: 'denied',
});
const REQUEST_KEYS = Object.freeze({
  vmState: ['computerId'],
  attestTaskStart: ['actionDigest', 'computerId', 'generation', 'leaseGeneration', 'leaseId', 'operationId', 'projectId', 'vmId'],
  attestNetwork: ['computerId', 'generation', 'leaseGeneration', 'leaseId', 'projectId', 'vmId'],
});
const BROKER_OWNED_KEYS = Object.freeze(['checkpointId', 'checkpointType', 'expiresAt', 'network', 'observedAt']); // a request cannot say what the Broker observed
const CLAIMABLE = Object.freeze(['task.start', 'environment.start', 'environment.restore_checkpoint']); // the three-key claim form
const SYNTHETIC_INSPECT = 'synthetic.inspect';

// ---- the reference checker: the Amendment's rules, nothing else ----
const ID_RE = new RegExp(ID_PATTERN);
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const isCounter = (v) => Number.isSafeInteger(v) && v >= LIMITS.counterMin;
const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const isGuid = (v) => typeof v === 'string' && GUID_RE.test(v);
const FIELD_RULES = Object.freeze({
  computerId: isId, projectId: isId, leaseId: isId, operationId: isId, vmId: isGuid, generation: isCounter, leaseGeneration: isCounter, actionDigest: (v) => typeof v === 'string' && DIGEST_RE.test(v),
});
const OK = Object.freeze({ ok: true });
const bad = (reason, field) => (field === undefined ? { ok: false, reason } : { ok: false, reason, field });
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const bytes = (text) => Buffer.byteLength(text, 'utf8');
const tryParse = (text, depth) => { try { return parseStrictJson(text, depth); } catch { return null; } };

function checkVmRequest(text) {
  if (bytes(text) > LIMITS.maxRequestBytes) return bad('too_large');
  const parsed = tryParse(text, 2);
  if (parsed === null) return bad('malformed_json');
  const kinds = Object.keys(parsed);
  if (kinds.length !== 1 || !Object.hasOwn(REQUEST_KEYS, kinds[0])) return bad('request_shape');
  const body = parsed[kinds[0]];
  if (body === null || typeof body !== 'object') return bad('request_shape');
  const keys = Object.keys(body).sort();
  if (!sameList(keys, REQUEST_KEYS[kinds[0]])) return bad('key_set');
  for (const key of keys) if (!FIELD_RULES[key](body[key])) return bad('field', key);
  return OK;
}

function checkRefusal(parsed) {
  if (!sameList(Object.keys(parsed).sort(), ['code', 'ok'])) return bad('key_set');
  return parsed.code === ENUMS.refusalCode ? OK : bad('field', 'code');
}

function checkAttestation(kind, signed, request, now) {
  const verify = createEcdsaAttestationVerifier({ keyId: vectors.keyId, publicKey: vectors.publicKeySpki }).verify;
  const pick = (keys) => Object.fromEntries(keys.map((k) => [k, request[k]]));
  try {
    if (kind === 'attestTaskStart') {
      const attestation = verifyTaskStartAttestation(signed, { clock: () => now, verify, expected: pick(REQUEST_KEYS.attestTaskStart) });
      return provesCheckpointedNoNetwork(attestation) ? OK : bad('statement_not_enough');
    }
    verifyNetworkAttestation(signed, { clock: () => now, verify, expected: pick(REQUEST_KEYS.attestNetwork) });
    return OK;
  } catch (error) {
    if (!(error instanceof TaskStartAttestationError || error instanceof NetworkAttestationError)) throw error;
    return { ok: false, reason: 'attestation', code: error.code, field: error.field };
  }
}

function checkVmReply({ kind, text, request, now }) {
  if (bytes(text) > LIMITS.maxVmReplyBytes) return bad('too_large');
  const parsed = tryParse(text, 3);
  if (parsed === null) return bad('malformed_json');
  if (typeof parsed.ok !== 'boolean') return bad('reply_shape');
  if (!parsed.ok) return checkRefusal(parsed);
  const keys = Object.keys(parsed).sort();
  if (kind !== 'vmState') return sameList(keys, ['attestation', 'ok']) ? checkAttestation(kind, parsed.attestation, request, now) : bad('key_set');
  if (!sameList(keys, ['generation', 'ok', 'restorable', 'state'])) return bad('key_set');
  if (!isCounter(parsed.generation)) return bad('field', 'generation');
  if (typeof parsed.restorable !== 'boolean') return bad('field', 'restorable');
  if (!ENUMS.vmState.includes(parsed.state)) return bad('field', 'state');
  return parsed.restorable && parsed.state === 'restoring' ? bad('invariant') : OK;
}

function checkClaimAction(text) {
  const dto = tryParse(text, 3);
  if (dto === null) return bad('action_invalid');
  const purpose = ACTIONS_BY_PURPOSE['guest.command'].includes(dto.action) ? 'guest.command' : 'broker.operation';
  let normalized;
  try { normalized = validateActionDto(purpose, dto); } catch (error) { if (error instanceof ActionDigestError) return bad('action_invalid'); throw error; }
  if (!CLAIMABLE.includes(normalized.action)) return bad('action_mismatch');
  const names = Object.keys(normalized.args).sort();
  const a = normalized.args;
  const vmArgs = isGuid(a.vmId) && isCounter(a.expectedGeneration);
  const argsOk = normalized.action === 'task.start'
    ? typeof a.task === 'string' && a.task.length > 0 && (names.length === 1 || (sameList(names, ['expectedGeneration', 'task', 'vmId']) && vmArgs))
    : sameList(names, ['expectedGeneration', 'vmId']) && vmArgs;
  return argsOk ? { ok: true, purpose, actionDigest: computeActionDigest(purpose, normalized) } : bad('action_invalid');
}

function checkClaimReply({ claim, text }) {
  if (bytes(text) > LIMITS.maxClaimReplyBytes) return bad('too_large');
  const parsed = tryParse(text, 2);
  if (parsed === null) return bad('malformed_json');
  if (typeof parsed.ok !== 'boolean') return bad('reply_shape');
  if (!parsed.ok) return checkRefusal(parsed);
  const replayed = Object.hasOwn(parsed, 'replayed');
  if (!sameList(Object.keys(parsed).sort(), replayed ? ['action', 'ok', 'replayed', 'state'] : ['action', 'ok', 'state'])) return bad('key_set');
  if ((replayed && parsed.replayed !== true) || (claim === 'replay') !== replayed) return bad('replayed');
  if (!ENUMS.recordedStates.includes(parsed.state)) return bad('field', 'state');
  if (!ENUMS.claimActions.includes(parsed.action)) return bad('field', 'action');
  return claim === 'first' && parsed.state !== 'UNKNOWN' ? bad('fresh_state') : OK;
}

function checkInspectReply({ text }) {
  if (bytes(text) > LIMITS.maxClaimReplyBytes) return bad('too_large');
  const parsed = tryParse(text, 2);
  if (parsed === null) return bad('malformed_json');
  if (typeof parsed.ok !== 'boolean') return bad('reply_shape');
  if (!parsed.ok) return checkRefusal(parsed);
  if (!sameList(Object.keys(parsed).sort(), ['action', 'ok', 'state'])) return bad('key_set');
  if (!ENUMS.recordedStates.includes(parsed.state)) return bad('field', 'state');
  return parsed.action === SYNTHETIC_INSPECT ? OK : bad('field', 'action');
}

// ---- helpers over the file ----
const textOf = (c, objectKey, rawKey) => (c[rawKey] !== undefined ? c[rawKey] : JSON.stringify(c[objectKey]));
const requestBodyOf = (name) => {
  const found = vectors.vmRequests.find((c) => c.name === name);
  assert.ok(found?.request, `the request case ${name} exists and is an object`);
  return Object.values(found.request)[0];
};
const caseKeys = (section, allowed) => {
  for (const c of vectors[section]) assert.deepEqual(Object.keys(c).filter((k) => !allowed.includes(k)), [], `${section}/${c.name}: only ${allowed.join(', ')}`);
};
const uniqueNames = (section) => {
  const names = vectors[section].map((c) => c.name);
  assert.equal(new Set(names).size, names.length, `${section}: names are unique`);
  assert.ok(names.every((n) => typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(n)), `${section}: names are plain words`);
};
const reasonsOf = (cases) => new Set(cases.filter((c) => !c.expected.ok).map((c) => c.expected.reason));

// ---------------------------------------------------------------- the file ----

test('the file: exact top-level keys; limits, word sets and request key sets are the Amendment\'s', () => {
  assert.deepEqual(Object.keys(vectors).sort(), ['claimActions', 'claimReplies', 'contract', 'enums', 'inspectReplies', 'keyId', 'limits', 'notes', 'publicKeySpki', 'requestKeys', 'status', 'version', 'vmReplies', 'vmRequests'].sort());
  assert.equal(vectors.contract, 'albera.broker-vm-wire.vectors');
  assert.equal(vectors.version, 1);
  assert.match(vectors.status, /^Proposed\./u, 'the file says it is Proposed');
  assert.ok(Array.isArray(vectors.notes) && vectors.notes.length >= 6 && vectors.notes.every((n) => typeof n === 'string' && n.length > 0));
  assert.deepEqual(vectors.limits, LIMITS);
  assert.deepEqual(vectors.enums, ENUMS);
  assert.deepEqual(vectors.requestKeys, REQUEST_KEYS);
  // the limits are consistent with each other and with the contracts they reuse
  assert.ok(LIMITS.brokerDeadlineSeconds < LIMITS.clientTimeoutSeconds, 'the Broker answers before the client gives up');
  assert.ok(LIMITS.attestationTtlSeconds >= 1 && LIMITS.attestationTtlSeconds <= 300, 'the statement TTL is inside the contract\'s 1..300 s');
  assert.equal(LIMITS.maxRequestBytes, 4096, 'the claim pipe\'s request bound (Amendment 2026-10-31)');
  assert.equal(LIMITS.maxIdLength, 64);
  assert.equal(ID_PATTERN, '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$', 'the id grammar of the contract');
  assert.equal(vectors.keyId, 'albera-test-broker-2026');
  assert.match(vectors.publicKeySpki, /^[A-Za-z0-9+/]+={0,2}$/u);
});

test('the file: every section has unique plain names and only the keys its notes describe', () => {
  for (const section of ['vmRequests', 'vmReplies', 'claimActions', 'claimReplies', 'inspectReplies']) {
    assert.ok(vectors[section].length >= 5, `${section} has cases`);
    uniqueNames(section);
    for (const c of vectors[section]) {
      assert.equal(typeof c.expected, 'object', `${section}/${c.name}: expected`);
      assert.ok(c.expected.ok === true || (c.expected.ok === false && typeof c.expected.reason === 'string'), `${section}/${c.name}: expected is ok or a refusal with a reason`);
    }
  }
  caseKeys('vmRequests', ['name', 'request', 'rawRequest', 'expected']);
  caseKeys('vmReplies', ['name', 'kind', 'forRequest', 'now', 'reply', 'rawReply', 'expected']);
  caseKeys('claimActions', ['name', 'dto', 'rawDto', 'expected']);
  caseKeys('claimReplies', ['name', 'claim', 'reply', 'expected']);
  caseKeys('inspectReplies', ['name', 'reply', 'expected']);
  for (const c of vectors.vmRequests) assert.equal([c.request, c.rawRequest].filter((x) => x !== undefined).length, 1, `${c.name}: exactly one of request / rawRequest`);
  for (const c of vectors.vmReplies) assert.equal([c.reply, c.rawReply].filter((x) => x !== undefined).length, 1, `${c.name}: exactly one of reply / rawReply`);
});

// ---------------------------------------------------------------- `_vm` requests ----

test('vmRequests: every case agrees with the reference checker', () => {
  for (const c of vectors.vmRequests) assert.deepEqual(checkVmRequest(textOf(c, 'request', 'rawRequest')), c.expected, c.name);
});

test('vmRequests: each kind has a good example and a refused one, and every field of every kind has its own refused example', () => {
  const kindOf = (c) => (c.request ? Object.keys(c.request)[0] : null);
  for (const kind of ENUMS.vmRequestKinds) {
    const ofKind = vectors.vmRequests.filter((c) => kindOf(c) === kind);
    assert.ok(ofKind.some((c) => c.expected.ok), `${kind}: a valid example`);
    assert.ok(ofKind.some((c) => c.expected.reason === 'key_set'), `${kind}: a refused key set`);
    for (const field of REQUEST_KEYS[kind]) {
      const body = (c) => Object.values(c.request)[0];
      assert.ok(ofKind.some((c) => c.expected.reason === 'field' && c.expected.field === field && body(c)[field] !== undefined), `${kind}.${field}: a refused example that fails on that field`);
    }
  }
  const reasons = reasonsOf(vectors.vmRequests);
  for (const reason of ['malformed_json', 'request_shape', 'key_set', 'field']) assert.ok(reasons.has(reason), `a refused example for ${reason}`);
  // value ranges are pinned from both sides
  const ts = requestBodyOf('attestTaskStart-ok-generation-max-safe');
  assert.equal(ts.generation, LIMITS.counterMax);
  assert.equal(requestBodyOf('attestTaskStart-ok-ids-64-chars').computerId.length, LIMITS.maxIdLength);
  assert.equal(requestBodyOf('vmState-id-65-chars').computerId.length, LIMITS.maxIdLength + 1);
});

test('vmRequests: a key the Broker owns is refused in every request kind, and nothing but the frame length decides "too large"', () => {
  for (const owned of BROKER_OWNED_KEYS) {
    for (const kind of ['attestTaskStart', 'attestNetwork']) {
      const body = { ...requestBodyOf(`${kind}-ok`), [owned]: 'x' };
      assert.deepEqual(checkVmRequest(JSON.stringify({ [kind]: body })), bad('key_set'), `${kind} + ${owned}`);
    }
  }
  for (const owned of ['network', 'checkpointType', 'observedAt', 'checkpointId']) {
    assert.ok(vectors.vmRequests.some((c) => c.request?.attestTaskStart && Object.hasOwn(c.request.attestTaskStart, owned) && c.expected.reason === 'key_set'), `the file carries a refused attestTaskStart with ${owned}`);
  }
  const frame = (length) => `{"vmState":{"computerId":"pc-01"}}${' '.repeat(length - bytes('{"vmState":{"computerId":"pc-01"}}'))}`;
  assert.deepEqual(checkVmRequest(frame(LIMITS.maxRequestBytes)), OK, 'exactly the limit passes the length gate (and is a valid request: trailing whitespace)');
  assert.deepEqual(checkVmRequest(frame(LIMITS.maxRequestBytes + 1)), bad('too_large'));
  assert.deepEqual(checkVmRequest('é'.repeat(LIMITS.maxRequestBytes / 2 + 1)), bad('too_large'), 'the limit counts UTF-8 bytes, not characters');
  // the largest request any kind can carry fits with room to spare
  const widest = Object.fromEntries(REQUEST_KEYS.attestTaskStart.map((k) => [k, FIELD_RULES[k] === isId ? 'a'.repeat(LIMITS.maxIdLength) : requestBodyOf('attestTaskStart-ok')[k]]));
  assert.ok(bytes(JSON.stringify({ attestTaskStart: widest })) < LIMITS.maxRequestBytes / 4);
});

// ---------------------------------------------------------------- `_vm` replies ----

test('vmReplies: every case agrees with the reference checker (real signatures, the existing verifiers decide)', () => {
  for (const c of vectors.vmReplies) {
    const request = c.forRequest === undefined ? undefined : requestBodyOf(c.forRequest);
    assert.deepEqual(checkVmReply({ kind: c.kind, text: textOf(c, 'reply', 'rawReply'), request, now: c.now }), c.expected, c.name);
  }
});

test('vmReplies: each kind has a good reply and a refusal; every binding of both statements is tested; the weak statements and the wrong-kind envelopes are refused', () => {
  for (const kind of ENUMS.vmRequestKinds) {
    const ofKind = vectors.vmReplies.filter((c) => c.kind === kind);
    assert.ok(ofKind.some((c) => c.expected.ok && !JSON.parse(textOf(c, 'reply', 'rawReply')).code), `${kind}: a valid success reply`);
    assert.ok(ofKind.some((c) => JSON.parse(textOf(c, 'reply', 'rawReply')).ok === false && c.expected.ok), `${kind}: the one denial`);
  }
  const bindings = (kind) => new Set(vectors.vmReplies.filter((c) => c.kind === kind && c.expected.reason === 'attestation' && c.expected.code === 'binding').map((c) => c.expected.field));
  assert.deepEqual([...bindings('attestTaskStart')].sort(), [...REQUEST_KEYS.attestTaskStart].sort(), 'task-start: a statement for another value of each of the 8 items is refused');
  assert.deepEqual([...bindings('attestNetwork')].sort(), [...REQUEST_KEYS.attestNetwork].sort(), 'network: the same for the 6 items');
  const codes = new Set(vectors.vmReplies.filter((c) => c.expected.reason === 'attestation').map((c) => c.expected.code));
  for (const code of ['binding', 'expired', 'signature', 'digest', 'malformed']) assert.ok(codes.has(code), `an attestation refused as ${code}`);
  const reasons = reasonsOf(vectors.vmReplies);
  for (const reason of ['key_set', 'field', 'reply_shape', 'invariant', 'statement_not_enough', 'attestation']) assert.ok(reasons.has(reason), `a refused reply for ${reason}`);
  const weak = vectors.vmReplies.filter((c) => c.expected.reason === 'statement_not_enough').map((c) => c.name);
  assert.ok(weak.some((n) => /network-present/u.test(n)) && weak.some((n) => /network-unknown/u.test(n)) && weak.some((n) => /standard-checkpoint/u.test(n)), 'present, unknown and Standard are each refused for attestTaskStart');
  // a network statement of "present" or "unknown" IS a valid answer to attestNetwork (the Authority judges it)
  assert.ok(vectors.vmReplies.some((c) => c.kind === 'attestNetwork' && c.expected.ok && /present/u.test(c.name)) && vectors.vmReplies.some((c) => c.kind === 'attestNetwork' && c.expected.ok && /unknown/u.test(c.name)));
  // the TTL boundary: valid one second before it ends, expired at the end
  assert.deepEqual(vectors.vmReplies.find((c) => c.name === 'attestTaskStart-still-valid-at-59-s').expected, OK);
  assert.equal(vectors.vmReplies.find((c) => c.name === 'attestTaskStart-expired-at-60-s').now - vectors.vmReplies.find((c) => c.name === 'attestTaskStart-ok-none-production').now, LIMITS.attestationTtlSeconds - 10);
});

test('vmReplies: the statement body echoes the request, is 60 s long, and every valid reply fits the reply bound with room to spare', () => {
  for (const c of vectors.vmReplies.filter((x) => x.expected.ok && x.reply?.attestation)) {
    const body = c.reply.attestation.attestation;
    assert.equal(body.expiresAt - body.observedAt, LIMITS.attestationTtlSeconds, c.name);
    assert.ok(bytes(JSON.stringify(c.reply)) < LIMITS.maxVmReplyBytes / 2, `${c.name}: well inside ${LIMITS.maxVmReplyBytes} bytes`);
    assert.equal(c.reply.attestation.keyId, vectors.keyId);
    if (c.kind === 'attestTaskStart') assert.equal(body.checkpointType, 'production', 'the Broker signs a task-start statement only for a Production checkpoint');
  }
  const padded = JSON.stringify({ ok: true, generation: 3, restorable: false, state: 'ready', pad: 'x'.repeat(LIMITS.maxVmReplyBytes) });
  assert.deepEqual(checkVmReply({ kind: 'vmState', text: padded }), bad('too_large'));
});

test('vmReplies: the widest reply the contract can produce (64-character ids, the largest counters) is the size the Amendment states, and fits the bound twice over', async () => {
  const id = `a${'b'.repeat(LIMITS.maxIdLength - 1)}`;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signer = createEcdsaAttestationSigner({ keyId: id, privateKey });
  const body = createTaskStartAttestation({
    network: 'none', computerId: id, vmId: requestBodyOf('attestTaskStart-ok').vmId, generation: LIMITS.counterMax, projectId: id, leaseId: id, leaseGeneration: LIMITS.counterMax, operationId: id,
    actionDigest: `sha256:${'a'.repeat(64)}`, checkpointId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', checkpointType: 'production', observedAt: 1793404800,
  });
  const widest = bytes(JSON.stringify({ ok: true, attestation: await signTaskStartAttestation(body, signer) }));
  assert.ok(widest * 2 < LIMITS.maxVmReplyBytes, `${widest} bytes leaves room`);
  assert.ok(section('The `_vm` pipe').includes(`is ${widest} bytes)`), `the Amendment states the widest reply as ${widest} bytes`);
});

// ---------------------------------------------------------------- the claim pipe ----

test('claimActions: every case agrees with the reference checker, digest included; the purpose follows the action', () => {
  for (const c of vectors.claimActions) assert.deepEqual(checkClaimAction(textOf(c, 'dto', 'rawDto')), c.expected, c.name);
  for (const c of vectors.claimActions.filter((x) => x.expected.ok)) {
    assert.equal(c.expected.purpose, c.dto.action === 'task.start' ? 'guest.command' : 'broker.operation', c.name);
    assert.match(c.expected.actionDigest, DIGEST_RE);
  }
  const okActions = new Set(vectors.claimActions.filter((c) => c.expected.ok).map((c) => c.dto.action));
  assert.deepEqual([...okActions].sort(), [...CLAIMABLE].sort(), 'each claimable action has a valid example');
});

test('claimActions: every other action of the contract is refused in the three-key form, and every wrong args shape of the two new actions is refused', () => {
  const refusedActions = new Set(vectors.claimActions.filter((c) => c.expected.reason === 'action_mismatch').map((c) => c.dto.action));
  const others = [...new Set([...ACTIONS_BY_PURPOSE['broker.operation'], ...ACTIONS_BY_PURPOSE['guest.command']])].filter((a) => !CLAIMABLE.includes(a));
  assert.deepEqual([...refusedActions].sort(), others.sort(), 'one refused example per other action of the contract');
  for (const action of ['environment.start', 'environment.restore_checkpoint']) {
    const ofAction = vectors.claimActions.filter((c) => c.dto?.action === action && c.expected.reason === 'action_invalid');
    assert.ok(ofAction.some((c) => !Object.hasOwn(c.dto.args, 'expectedGeneration')) && ofAction.some((c) => !Object.hasOwn(c.dto.args, 'vmId')) && ofAction.some((c) => Object.keys(c.dto.args).length > 2),
      `${action}: a missing generation, a missing vmId and an extra arg are each refused`);
  }
  assert.ok(vectors.claimActions.some((c) => c.rawDto && c.expected.reason === 'action_invalid'), 'a DTO the strict reader refuses');
});

test('claimReplies and inspectReplies: every case agrees with the reference checker; a first claim says UNKNOWN, a replay may say any recorded state', () => {
  for (const c of vectors.claimReplies) assert.deepEqual(checkClaimReply({ claim: c.claim, text: JSON.stringify(c.reply) }), c.expected, c.name);
  for (const c of vectors.inspectReplies) assert.deepEqual(checkInspectReply({ text: JSON.stringify(c.reply) }), c.expected, c.name);
  const replayStates = new Set(vectors.claimReplies.filter((c) => c.claim === 'replay' && c.expected.ok && c.reply.ok).map((c) => c.reply.state));
  assert.deepEqual([...replayStates].sort(), [...ENUMS.recordedStates].sort(), 'a replay shown for each recorded state');
  assert.ok(vectors.claimReplies.filter((c) => c.claim === 'first' && c.expected.ok && c.reply.ok).every((c) => c.reply.state === 'UNKNOWN'));
  const inspectStates = new Set(vectors.inspectReplies.filter((c) => c.expected.ok && c.reply.ok).map((c) => c.reply.state));
  assert.deepEqual([...inspectStates].sort(), [...ENUMS.recordedStates].sort());
  for (const reason of ['fresh_state', 'replayed', 'field', 'key_set']) assert.ok(reasonsOf(vectors.claimReplies).has(reason), `claimReplies: a refused example for ${reason}`);
  assert.ok(vectors.claimReplies.some((c) => c.reply.ok && c.expected.ok && ['environment.start', 'environment.restore_checkpoint'].includes(c.reply.action)), 'the two new actions are named in a claim reply');
  for (const word of ['FENCED', 'ready', 'restoring']) {
    assert.ok([...vectors.claimReplies, ...vectors.inspectReplies].some((c) => c.reply.state === word && !c.expected.ok), `the vmState word ${word} is not a claim state`);
  }
  const oversize = JSON.stringify({ ok: true, state: 'UNKNOWN', action: 'task.start', pad: 'x'.repeat(LIMITS.maxClaimReplyBytes) });
  assert.deepEqual(checkClaimReply({ claim: 'first', text: oversize }), bad('too_large'));
});

// ---------------------------------------------------------------- the Amendment text ----

const amendmentStart = adr.indexOf('\n## Amendment 2026-11-04:');
assert.ok(amendmentStart > 0, 'the ADR carries "Amendment 2026-11-04"');
const afterStart = adr.slice(amendmentStart + 1);
const amendment = afterStart.slice(0, afterStart.indexOf('\n## Remaining ADR-002 gates'));
const section = (title) => {
  const at = amendment.indexOf(`\n### ${title}`);
  assert.ok(at >= 0, `the Amendment has the section "${title}"`);
  const rest = amendment.slice(at + 1);
  const next = rest.indexOf('\n### ', 1);
  return next < 0 ? rest : rest.slice(0, next);
};
const tableRows = (text) => text.split('\n').filter((l) => l.startsWith('|') && !/^\|[-| ]+\|$/u.test(l)).map((l) => l.split('|').slice(1, -1).map((cell) => cell.trim()));

test('the Amendment: says Proposed, names both owner decisions, changes no runtime line, and carries every required section in order', () => {
  assert.match(amendment, /^## Amendment 2026-11-04: .*\*\*Proposed\*\*, design only\)/u);
  assert.match(amendment, /\*\*Status: Proposed\. Waiting for the owner\.\*\*/u);
  for (const needle of ['**AGM-1**', '**AGM-2**', 'it changes no runtime line', 'broker-vm-wire-vectors.json', 'test/docs-reversible-approval-contract.test.mjs', '2026-11-04+reversible-approval-broker']) assert.ok(amendment.includes(needle), `names ${needle}`);
  assert.match(amendment, /AGM-1\*\* \(widen the WmiGate allowlist.*ProductionOnly\)/u);
  assert.match(amendment, /AGM-2\*\* \(issue the Broker's attestation key and register its public half with the Approval Authority\)/u);
  const titles = [...amendment.matchAll(/^### (.+)$/gmu)].map((m) => m[1]);
  assert.deepEqual(titles, [
    'The `_vm` pipe', 'Claim pipe: two more actions, wider states', 'Journal v4', 'Generation: who owns it', 'Lease revocation', 'WmiGate rows added (AGM-1)', 'Checkpoint and prune rules',
    'Restore: state transitions', 'Known limits', 'NOT VERIFIED items and where each is measured', 'Measurements C1 to C8', 'Approvals and order', 'Evidence in this amendment',
  ]);
  assert.match(adr.slice(adr.indexOf('\n## Remaining ADR-002 gates')), /Run the measurements C1 to C8 of "Amendment 2026-11-04"/u);
});

test('the Amendment: the limits table is the file\'s limits, row for row; the request table names the exact keys; the pipe rules are written', () => {
  const pipe = section('The `_vm` pipe');
  const limitsPart = pipe.slice(pipe.indexOf('Limits (every row'), pipe.indexOf('Requests and replies (one top-level key'));
  assert.ok(limitsPart.length > 100, 'the limits table is found');
  const limits = new Map(tableRows(limitsPart).filter((r) => /^`\w+`$/u.test(r[0]) && /^`[^`]*`$/u.test(r[1])).map((r) => [r[0].slice(1, -1), r[1].slice(1, -1)]));
  assert.deepEqual(Object.fromEntries(limits), Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, String(v)])), 'the doc\'s limits table equals the pinned limits');
  const rows = new Map(tableRows(pipe).filter((r) => ENUMS.vmRequestKinds.includes(r[0].replaceAll('`', ''))).map((r) => [r[0].replaceAll('`', ''), r[1]]));
  assert.deepEqual([...rows.keys()].sort(), [...ENUMS.vmRequestKinds].sort());
  for (const [kind, cell] of rows) for (const key of REQUEST_KEYS[kind]) assert.ok(cell.includes(`\`${key}\``), `${kind} row names ${key}`);
  assert.match(rows.get('attestTaskStart'), /the 8 items/u);
  assert.match(rows.get('attestNetwork'), /the 6 items/u);
  for (const state of ENUMS.vmState) assert.ok(pipe.includes(`\`${state}\``), `the pipe section names the state ${state}`);
  for (const needle of ['LocalPipe.cs', 'CreateNamedPipeW', 'NamedPipeServerStreamAcl', 'PIPE_REJECT_REMOTE_CLIENTS', '0x00120083', '{"ok":false,"code":"denied"}', 'albera.task-start-attestation.v2', 'albera.network-attestation.v1', 'Re-sign', 'user SID equals the configured Control Plane SID']) {
    assert.ok(pipe.includes(needle), `the pipe section says ${needle}`);
  }
  assert.equal([...pipe.matchAll(/^\d+\. /gmu)].length, 11, 'attestTaskStart has its 11 steps');
  for (const key of BROKER_OWNED_KEYS) assert.ok(pipe.includes(`\`${key}\``), `the Broker-owned key ${key} is named`);
});

test('the Amendment: the claim pipe additions fix the purpose rule, the args, the states and what is not changed', () => {
  const claim = section('Claim pipe: two more actions, wider states');
  for (const needle of ['`environment.start` and `environment.restore_checkpoint` are `broker.operation`', '`task.start` is `guest.command`', '`{vmId, expectedGeneration}`', 'DENY=action_mismatch', 'DENY=action_invalid',
    '`UNKNOWN`, `APPLIED`, `NOT_APPLIED`', 'synthetic.inspect', 'DENY=binding', 'it means "recorded", never "done"']) assert.ok(claim.includes(needle), `says ${needle}`);
  for (const word of ['vm_unknown', 'vm_mismatch', 'vm_generation', 'vm_state', 'no_checkpoint', 'attestation']) assert.ok(claim.includes(word), `the new log word ${word}`);
  for (const action of CLAIMABLE) assert.ok(claim.includes(`\`${action}\``));
});

test('the Amendment: journal v4 gives the exact tables; their word sets are the ones on the wire; claims keeps its table text', () => {
  const journal = section('Journal v4');
  const ddl = [...journal.matchAll(/^CREATE TABLE (\w+) \(.*\)$/gmu)].map((m) => [m[1], m[0]]);
  assert.deepEqual(ddl.map(([name]) => name), ['vm_state', 'checkpoints']);
  const [vmState, checkpoints] = ddl.map(([, text]) => text);
  assert.ok(vmState.includes(`CHECK(state IN (${ENUMS.vmState.map((s) => `'${s}'`).join(', ')}))`), 'vm_state.state is the vmState word set');
  assert.ok(vmState.includes('generation INTEGER NOT NULL CHECK(generation >= 1)') && vmState.includes('CHECK(NOT (state = \'restoring\' AND restorable = 1))'));
  assert.ok(checkpoints.includes("CHECK(state IN ('attested', 'claimed', 'applied', 'destroyed'))"));
  assert.ok(checkpoints.includes('operation_id TEXT NOT NULL UNIQUE') && checkpoints.includes('statement_digest TEXT CHECK(statement_digest IS NULL OR length(statement_digest) = 71)'));
  assert.ok(checkpoints.includes('length(action_digest) = 71'), '"sha256:" plus 64 hex is 71 characters');
  for (const col of ['snapshot_id', 'computer_id', 'vm_id', 'generation', 'operation_id', 'action_digest', 'statement_digest', 'created_at', 'state']) assert.ok(checkpoints.includes(col), `checkpoints.${col}`);
  for (const col of ['computer_id', 'vm_id', 'generation', 'state', 'restorable']) assert.ok(vmState.includes(col), `vm_state.${col}`);
  for (const needle of ['user_version', 'exit 76', 'There is no downgrade', '`APPLIED` and `NOT_APPLIED`', 'does not change', 'BeginEpochAsync', 'restoring', 'fenced']) assert.ok(journal.toLowerCase().includes(needle.toLowerCase()), `says ${needle}`);
});

test('the Amendment: the generation has one owner and five counters are told apart; the lease is revoked at attest and at restore', () => {
  const generation = section('Generation: who owns it');
  assert.match(generation, /owned by the Broker's journal \(`vm_state\.generation`\) and by nothing else/u);
  assert.match(generation, /It only goes up, by one, in exactly two cases/u);
  const counters = tableRows(generation).filter((r) => r.length === 3 && r[0] !== 'Counter').map((r) => r[0]);
  assert.equal(counters.length, 5);
  for (const name of ['vm_state.generation', 'broker_state.lease_generation', 'desktop lease generation', 'Notes generation', 'computers.generation']) assert.ok(counters.some((c) => c.includes(name)), `counter ${name}`);
  const lease = section('Lease revocation');
  for (const needle of ['`attestTaskStart` for the computer, step 5', 'a restore claim accepted', '**before** the transaction commits', 'a Broker start', 'a `task.start` claim', 'fail closed', '`vmId` only']) assert.ok(lease.includes(needle), `lease: ${needle}`);
});

test('the Amendment: the WmiGate rows name every class, method and argument value, and still refuse what must stay refused', () => {
  const gate = section('WmiGate rows added (AGM-1)');
  const rows = tableRows(gate).filter((r) => r.length === 4 && r[0] !== 'Use');
  assert.equal(rows.length, 8);
  const classes = rows.flatMap((r) => [...r[1].matchAll(/`(Msvm_\w+)`/gu)].map((m) => m[1]));
  assert.deepEqual([...new Set(classes)].sort(), ['Msvm_ComputerSystem', 'Msvm_ConcreteJob', 'Msvm_EmulatedEthernetPortSettingData', 'Msvm_SyntheticEthernetPortSettingData', 'Msvm_VirtualSystemSettingData', 'Msvm_VirtualSystemSnapshotService', 'Msvm_VirtualSystemSnapshotSettingData'].sort());
  const byMethod = (name) => rows.find((r) => r[2].includes(`\`${name}\``));
  assert.equal(byMethod('CreateSnapshot')[1], '`Msvm_VirtualSystemSnapshotService` (its one instance)');
  for (const [method, needles] of [
    ['CreateSnapshot', ['AffectedSystem', 'SnapshotSettings', '`ConsistencyLevel = 1`', '`SnapshotType = 2`', 'ResultingSnapshot', 'Job']],
    ['DestroySnapshot', ['AffectedSnapshot', 'has no child', 'K4']],
    ['ApplySnapshot', ['Snapshot', 'newest `claimed` row']],
    ['RequestStateChange', ['`RequestedState = 2`', '`RequestedState = 3`', 'only inside a restore', 'C3', 'no other value', '`TimeoutPeriod` is not passed']],
  ]) for (const needle of needles) assert.ok(byMethod(method)[3].includes(needle), `${method}: ${needle}`);
  assert.ok(rows.some((r) => r[2].startsWith('read only') && r[1].includes('Msvm_ConcreteJob') && r[3].includes('no method')), 'a job is read, never cancelled');
  const refused = gate.slice(gate.indexOf('**Still refused:**'));
  for (const needle of ['`ModifySystemSettings`', '`DefineSystem`', '`DestroySystem`', '`DestroySnapshotTree`', '`TypeCtrlAltDel`', 'every other `RequestedState`', 'any other namespace', 'CONTRACT_ALLOWLIST']) assert.ok(refused.includes(needle), `refuses ${needle}`);
  for (const needle of ['NOT VERIFIED until C1 reads the live class', '`root\\virtualization\\v2`', 'never through PowerShell or a child process', 'ProductionOnly']) assert.ok(gate.includes(needle), `says ${needle}`);
});

test('the Amendment: prune is ledger-only, leaf-only and ledger-first, and says what that costs and what decides it', () => {
  const rules = section('Checkpoint and prune rules');
  const ids = [...rules.matchAll(/^- \*\*(K\d) /gmu)].map((m) => m[1]);
  assert.deepEqual(ids, ['K1', 'K2', 'K3', 'K4', 'K5']);
  for (const needle of ['**it has no child**', '`Parent` of `Msvm_VirtualSystemSnapshotSettingData`', 'NOT VERIFIED, N4', 'never `DestroySnapshotTree`', 'a row of the same computer and VM', 'after the claim\'s reply has been written',
    'may, as a side effect, also destroy other snapshots that depend on it', 'https://learn.microsoft.com/ja-jp/windows/win32/hyperv_v2/msvm-virtualsystemsnapshotservice', 'C4', 'PR3 does not merge until C4 decides', 'an **orphan**', 'never destroyed and never applied', '21474836480', 'contradicts the approved']) {
    assert.ok(rules.includes(needle), `says ${needle}`);
  }
});

test('the Amendment: the restore state machine lists every transition between the three states and the three claim states', () => {
  const restore = section('Restore: state transitions');
  const rows = tableRows(restore).filter((r) => /^S\d+$/u.test(r[0]));
  assert.deepEqual(rows.map((r) => r[0]), ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
  const stateWords = new Set(rows.flatMap((r) => [r[1], r[3]]).flatMap((cell) => [...cell.matchAll(/`(\w+)`/gu)].map((m) => m[1])));
  for (const state of ENUMS.vmState) assert.ok(stateWords.has(state), `a transition touches ${state}`);
  for (const state of ['APPLIED', 'NOT_APPLIED', 'UNKNOWN']) assert.ok(rows.some((r) => r[4].includes(`\`${state}\``)), `a transition writes ${state}`);
  const s3 = rows.find((r) => r[0] === 'S3');
  assert.ok(s3[1].includes('`ready` or `fenced`') && s3[3] === '`restoring`' && s3[4].includes('g + 1') && s3[4].includes('revoked first') && s3[4].includes('`UNKNOWN`'));
  const s6 = rows.find((r) => r[0] === 'S6');
  assert.equal(s6[3], '`fenced`');
  assert.ok(s6[4].includes('never resolved'));
  for (const needle of ['*branch X*', '*branch Y*', 'RequestStateChange(3)', '240 s', '`environment.start {vmId, expectedGeneration: g + 1}`', 'D3', 'NOT VERIFIED (N3, C3)', 'a new person-approved restore is the repair']) assert.ok(restore.includes(needle), `says ${needle}`);
  assert.ok(restore.includes(`${LIMITS.restoreWaitSeconds} s`), 'the poll time is the limits table\'s');
});

test('the Amendment: the known limits include the second round\'s first finding and the CNG points of the 2026-11-01 measurements', () => {
  const limits = section('Known limits');
  const ids = [...limits.matchAll(/^- \*\*(L\d+) /gmu)].map((m) => m[1]);
  assert.deepEqual(ids, Array.from({ length: 11 }, (_, i) => `L${i + 1}`));
  const l1 = limits.slice(limits.indexOf('- **L1'), limits.indexOf('- **L2'));
  for (const needle of ['can move the restore point forward', 'second round, finding 1', 'repeat attest, submit and claim', '"restorable" is a convenience, not a safety boundary', '`careful` tier', 'per-action override', '`environment.destroy` and `environment.purge` still ask a person']) assert.ok(l1.includes(needle), `L1: ${needle}`);
  const l9 = limits.slice(limits.indexOf('- **L9'), limits.indexOf('- **L10'));
  for (const needle of ['No Microsoft document was found', '%ProgramData%\\Microsoft\\Crypto', 'NOT VERIFIED (N7)', '`NTE_BAD_KEYSET`', '`NTE_PERM`', 'signing_key_unavailable', 'from the administrator side', 'high integrity and elevated', 'only the SID in the ACL does']) assert.ok(l9.includes(needle), `L9: ${needle}`);
  for (const needle of ['L2 The prune is stricter', 'L3 `projectId`', 'L5 Network statements are not remembered', 'L7 The hands compare `vmId` only', 'L10 The lab cannot sign with Windows Hello']) assert.ok(limits.includes(`**${needle}`) || limits.includes(needle), `says ${needle}`);
});

test('the Amendment: every NOT VERIFIED row names a measurement among C1 to C8, every measurement closes at least one row, and no reference dangles', () => {
  const notVerified = tableRows(section('NOT VERIFIED items and where each is measured')).filter((r) => /^N\d+$/u.test(r[0]));
  const measurements = tableRows(section('Measurements C1 to C8')).filter((r) => /^C\d+$/u.test(r[0]));
  assert.deepEqual(notVerified.map((r) => r[0]), Array.from({ length: 10 }, (_, i) => `N${i + 1}`));
  assert.deepEqual(measurements.map((r) => r[0]), Array.from({ length: 8 }, (_, i) => `C${i + 1}`), 'exactly C1 to C8, once each');
  const mapped = new Map(notVerified.map((r) => [r[0], [...r[2].matchAll(/\bC([1-8])\b/gu)].map((m) => `C${m[1]}`)]));
  for (const [n, cs] of mapped) assert.ok(cs.length >= 1, `${n} is mapped to a measurement`);
  assert.deepEqual(new Set([...mapped.values()].flat()), new Set(measurements.map((r) => r[0])), 'every measurement is used and none outside C1 to C8 is named');
  for (const [n, cs] of mapped) for (const c of cs) assert.ok([...measurements.find((r) => r[0] === c)[3].matchAll(/\bN\d+\b/gu)].some((m) => m[0] === n), `${c} lists ${n} among what it decides`);
  for (const r of measurements) assert.ok(r[1].length > 10 && r[2].length > 20, `${r[0]} says what is measured and how`);
  // the two items the 2.5th round could not confirm, and the key ACL, are tied to the right measurements
  const row = (n) => notVerified.find((r) => r[0] === n);
  assert.ok(row('N2')[1].includes('honors ProductionOnly') && row('N2')[2] === 'C2');
  assert.ok(row('N3')[1].includes('running VM') && row('N3')[2] === 'C3');
  assert.ok(row('N4')[1].includes('`Parent`') && row('N4')[2] === 'C4' && row('N5')[2] === 'C4');
  assert.ok(row('N7')[1].includes('CNG machine key') && row('N7')[2] === 'C6');
  const c = (id) => measurements.find((r) => r[0] === id);
  assert.ok(c('C4')[2].includes('DestroySnapshot(A)') && c('C4')[2].includes('parent'), 'C4 destroys a parent and reads the parent link');
  assert.ok(c('C6')[2].includes('ACL') && c('C6')[2].includes('as the Control Plane identity (must not)'), 'C6 sets the ACL and tries the wrong identity');
  assert.ok(c('C3')[2].includes('running VM') && c('C2')[2].includes('ProductionOnly VM'));
  // references: every N, C, K, L, S named anywhere in the Amendment is defined
  const defined = {
    N: new Set(notVerified.map((r) => r[0])), C: new Set(measurements.map((r) => r[0])),
    K: new Set([...amendment.matchAll(/^- \*\*(K\d+) /gmu)].map((m) => m[1])), L: new Set([...amendment.matchAll(/^- \*\*(L\d+) /gmu)].map((m) => m[1])),
    S: new Set(tableRows(section('Restore: state transitions')).filter((r) => /^S\d+$/u.test(r[0])).map((r) => r[0])),
  };
  for (const [letter, names] of Object.entries(defined)) {
    for (const m of amendment.matchAll(new RegExp(`\\b${letter}\\d+\\b`, 'gu'))) assert.ok(names.has(m[0]), `${m[0]} is referenced and defined`);
  }
});

test('approval-tiers.md points at the Amendment and keeps the two flows; the ADR keeps its earlier sections', () => {
  const heading = tiers.indexOf('## Production Broker path (Proposed, NOT IMPLEMENTED; ADR-002 Amendment 2026-11-04)');
  assert.ok(heading > 0);
  const next = tiers.indexOf('\n## ', heading + 1);
  const part = tiers.slice(heading, next);
  for (const needle of ['(adr-002-host-broker-trust-contract.md)', 'Flow A', 'Flow B', 'attestTaskStart', 'environment.restore_checkpoint', 'Hello', 'the Authority\'s code does not change', 'ADR-002 Amendment 2026-11-04', 'L1']) {
    assert.ok(part.toLowerCase().includes(needle.toLowerCase()), `approval-tiers: ${needle}`);
  }
  assert.match(tiers, /^6\. \*\*Production Broker path \(Proposed, 2026-11-04\)\.\*\*/mu, 'the order of work lists it');
  for (const earlier of ['## Amendment 2026-11-03: the Broker performs the room\'s desktop operations', '## Amendment 2026-11-03 (2): the Control Plane is the service', '### Known limit: the helper pin in the Control Plane settings', 'Owner decision (2026-11-03): option A']) assert.ok(adr.includes(earlier), `the ADR still has ${earlier}`);
});
