import assert from 'node:assert/strict';
import test from 'node:test';
import { createGuestEventIntake } from '../src/runtime/guest-event-intake.mjs';
import { createGuestSessionCapabilityService } from '../src/runtime/guest-session-capability.mjs';

const at = '2026-10-28T12:00:00.000Z';

function context(overrides = {}) {
  return {
    computerId: 'computer-1', runId: 'run-1', generation: 4,
    leaseExpiresAt: '2026-10-28T12:30:00.000Z', ...overrides,
  };
}

function event(overrides = {}) {
  return {
    protocolVersion: 1, type: 'guest.event', messageId: '00000000-0000-4000-8000-000000000001', computerId: 'computer-1',
    runId: 'run-1', generation: 4, sequence: 1, occurredAt: at,
    eventType: 'operation.completed', operationId: 'operation-1', claimedOutcome: 'succeeded', ...overrides,
  };
}

function fixture(t, { resolveActiveContext, ttlMs = 300_000, maxSessions = 10 } = {}) {
  let timestamp = at;
  const service = createGuestSessionCapabilityService({
    resolveActiveContext: resolveActiveContext || (async () => context()),
    now: () => timestamp, ttlMs, maxSessions,
  });
  t.after(() => service.close());
  return { service, setNow(value) { timestamp = value; } };
}

test('Guest capability is random, short-lived and scoped to Host Lease identity', async (t) => {
  const f = fixture(t);
  const issued = await f.service.issue({ computerId: 'computer-1', runId: 'run-1' });
  assert.match(issued.credential, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.expiresAt, '2026-10-28T12:05:00.000Z');
  assert.deepEqual(issued.scope, { computerId: 'computer-1', runId: 'run-1', generation: 4 });
  assert.deepEqual(await f.service.authenticateTransport({ transport: { guestSessionCredential: issued.credential } }), {
    computerId: 'computer-1', runId: 'run-1', generation: 4,
  });
  assert.equal(Reflect.ownKeys(f.service).includes(issued.credential), false);
});

test('Guest capability expiry is capped by the active Lease and expired credentials fail closed', async (t) => {
  const f = fixture(t, { resolveActiveContext: async () => context({ leaseExpiresAt: '2026-10-28T12:02:00.000Z' }) });
  const issued = await f.service.issue({ computerId: 'computer-1', runId: 'run-1' });
  assert.equal(issued.expiresAt, '2026-10-28T12:02:00.000Z');
  f.setNow('2026-10-28T12:02:00.000Z');
  assert.equal(await f.service.authenticateTransport({ transport: { guestSessionCredential: issued.credential } }), null);
});

test('Guest capability refuses resolver identity mismatch and enforces its bounded session pool', async (t) => {
  const mismatch = fixture(t, { resolveActiveContext: async () => context({ computerId: 'other-computer' }) });
  await assert.rejects(mismatch.service.issue({ computerId: 'computer-1', runId: 'run-1' }), /guest_session_unavailable/);

  const bounded = fixture(t, {
    maxSessions: 1,
    resolveActiveContext: async ({ computerId, runId }) => context({ computerId, runId }),
  });
  await bounded.service.issue({ computerId: 'computer-1', runId: 'run-1' });
  await assert.rejects(
    bounded.service.issue({ computerId: 'computer-2', runId: 'run-2' }),
    /guest_session_capacity/,
  );
});

test('Guest capability is invalidated when Host Lease resolution fails or its generation advances', async (t) => {
  let current = context();
  const f = fixture(t, { resolveActiveContext: async () => current });
  const issued = await f.service.issue({ computerId: 'computer-1', runId: 'run-1' });
  current = context({ generation: 5 });
  assert.equal(await f.service.authenticateTransport({ transport: { guestSessionCredential: issued.credential } }), null);

  current = context();
  const second = await f.service.issue({ computerId: 'computer-1', runId: 'run-1' });
  current = null;
  assert.equal(await f.service.authenticateTransport({ transport: { guestSessionCredential: second.credential } }), null);
});

test('Guest capability accepts only the exact credential transport field and ignores accessors', async (t) => {
  const f = fixture(t);
  const issued = await f.service.issue({ computerId: 'computer-1', runId: 'run-1' });
  assert.equal(await f.service.authenticateTransport({ transport: { guestSessionCredential: issued.credential, computerId: 'spoof' } }), null);
  let getterCalled = false;
  const hostile = Object.defineProperty({}, 'guestSessionCredential', { get() { getterCalled = true; return issued.credential; } });
  assert.equal(await f.service.authenticateTransport({ transport: hostile }), null);
  assert.equal(getterCalled, false);
  assert.equal(await f.service.authenticateTransport({ transport: { guestSessionCredential: `${issued.credential}!` } }), null);

  let requestGetterCalled = false;
  const hostileRequest = Object.defineProperties({}, {
    computerId: { get() { requestGetterCalled = true; return 'computer-1'; } },
    runId: { value: 'run-1', enumerable: true },
  });
  await assert.rejects(f.service.issue(hostileRequest), /guest_session_unavailable/);
  assert.equal(requestGetterCalled, false);
});

test('Guest capability renewal replaces the previous run token; service close revokes every token', async (t) => {
  const f = fixture(t, { maxSessions: 1 });
  const first = await f.service.issue({ computerId: 'computer-1', runId: 'run-1' });
  const second = await f.service.issue({ computerId: 'computer-1', runId: 'run-1' });
  assert.notEqual(first.credential, second.credential);
  assert.equal(await f.service.authenticateTransport({ transport: { guestSessionCredential: first.credential } }), null);
  assert.ok(await f.service.authenticateTransport({ transport: { guestSessionCredential: second.credential } }));
  f.service.close();
  assert.equal(await f.service.authenticateTransport({ transport: { guestSessionCredential: second.credential } }), null);
  await assert.rejects(f.service.issue({ computerId: 'computer-1', runId: 'run-1' }), /guest_session_unavailable/);
});

test('closing during an asynchronous issue or authentication cannot resurrect a capability', async (t) => {
  let releaseIssue;
  const issueWait = new Promise((resolve) => { releaseIssue = resolve; });
  const issuing = createGuestSessionCapabilityService({
    resolveActiveContext: async () => issueWait, now: () => at,
  });
  const pendingIssue = issuing.issue({ computerId: 'computer-1', runId: 'run-1' });
  issuing.close();
  releaseIssue(context());
  await assert.rejects(pendingIssue, /guest_session_unavailable/);

  let calls = 0;
  let releaseAuthentication;
  const authWait = new Promise((resolve) => { releaseAuthentication = resolve; });
  const authenticating = createGuestSessionCapabilityService({
    resolveActiveContext: async () => (++calls === 1 ? context() : authWait), now: () => at,
  });
  const issued = await authenticating.issue({ computerId: 'computer-1', runId: 'run-1' });
  const pendingAuthentication = authenticating.authenticateTransport({
    transport: { guestSessionCredential: issued.credential },
  });
  await new Promise((resolve) => setImmediate(resolve));
  authenticating.close();
  releaseAuthentication(context());
  assert.equal(await pendingAuthentication, null);
});

test('Guest capability authenticates intake peer context while event contents remain provisional claims', async (t) => {
  const f = fixture(t);
  const issued = await f.service.issue({ computerId: 'computer-1', runId: 'run-1' });
  let recorded;
  const intake = createGuestEventIntake({
    store: { recordGuestEvent(input) { recorded = input; return { status: 'ACCEPTED' }; } },
    authenticateTransport: f.service.authenticateTransport,
    resolveGuestContext: async ({ peer }) => peer,
  });
  const result = await intake.receive({
    transport: { guestSessionCredential: issued.credential },
    message: event({ computerId: 'computer-1', runId: 'run-1', generation: 4 }),
  });
  assert.deepEqual(result, { status: 'ACCEPTED' });
  assert.equal(recorded.claimedOutcome, 'succeeded');
  assert.equal(recorded.provenance, undefined, 'only the durable Store assigns provenance');
  assert.equal(JSON.stringify(recorded).includes(issued.credential), false, 'Guest capability is not copied into event data');
  await assert.rejects(intake.receive({
    transport: { guestSessionCredential: 'unrecognized' }, message: event(),
  }), (error) => error.code === 'guest_authentication_failed');
});
