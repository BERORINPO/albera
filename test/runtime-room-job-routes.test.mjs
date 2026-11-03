// The room's job screen (control-plane-service.md section 4): routes on the real room host over Fake approvals and Fake hands.
// No pipe, no process, no real secret. The Fakes decide when each request is approved, denied or stopped.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';
import { computeMatchCode } from '../src/runtime/broker-contract/match-code.mjs';
import { JOB_MAX_BODY_BYTES, MAX_KEPT_JOBS, MAX_WAITING_JOBS, createRoomJobRoutes } from '../src/runtime/room-job-routes.mjs';
import { TARGETS, createFakeApprovals, createFakeHands } from './helpers/fake-room-jobs.mjs';
import { startRouteHost } from './helpers/room-route-host.mjs';

const JOBS = 'api/jobs';
const STOP_ALL = 'api/jobs/stop-all';
const TEST = 'api/jobs/approval-test';
const TASK = 'Open Notepad and type hello';
const APPROVAL_ID_0 = '0b6c9d5e-7f21-4c3a-9e48-5d1a2b3c4d5e';
const vectorsOf = (file) => JSON.parse(fs.readFileSync(new URL(`../src/runtime/broker-contract/${file}`, import.meta.url), 'utf8'));

/** The match code from the contract's own formula, written out here (not the module under test), checked against the contract vectors below. */
function referenceCode(approvalId, actionDigest) {
  const preimage = Buffer.concat([Buffer.from('albera.match-code.v1'), Buffer.of(0), Buffer.from(approvalId), Buffer.of(0), Buffer.from(actionDigest)]);
  return String(createHash('sha256').update(preimage).digest().readUInt32BE(0) % 10000).padStart(4, '0');
}

async function start(t, { approvalOptions, handsOptions, routeOptions } = {}) {
  const approvals = createFakeApprovals(approvalOptions);
  const hands = createFakeHands(handsOptions);
  const r = await startRouteHost(t, createRoomJobRoutes({ approvals, hands, targets: () => TARGETS, ...routeOptions }));
  const jobs = async () => (await r.call('GET', JOBS)).json.jobs;
  /** Wait until job `id` reaches `state` (the settle is a background promise). */
  const until = async (id, state) => {
    for (let i = 0; i < 100; i++) {
      const job = (await jobs()).find((j) => j.jobId === id);
      if (job?.state === state) return job;
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    assert.fail(`job ${id} did not reach ${state}: ${JSON.stringify(await jobs())}`);
  };
  return { ...r, approvals, hands, jobs, until };
}

test('the reference formula reproduces every valid contract vector (so it can be used as the oracle below)', () => {
  const { vectors } = vectorsOf('match-code-vectors.json');
  const valid = vectors.filter((v) => v.expected.ok);
  assert.ok(valid.length >= 20);
  for (const v of valid) assert.equal(referenceCode(v.approvalId, v.actionDigest), v.expected.matchCode, v.name);
});

test('start: asks for approval of exactly the typed task and shows the approval id, the action digest and the match code', async (t) => {
  const r = await start(t);
  const res = await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: TASK } });
  assert.equal(res.status, 202);
  assert.deepEqual(r.approvals.asked, [{ computerId: 'pc-01', task: TASK }]);
  const dto = { action: 'task.start', projectId: 'proj-alpha', computerId: 'pc-01', args: { task: TASK } };
  const digest = computeActionDigest('guest.command', dto);
  assert.deepEqual(res.json, { ok: true, job: {
    jobId: 'job-1', kind: 'task', computerId: 'pc-01', task: TASK, approvalId: APPROVAL_ID_0, actionDigest: digest, matchCode: referenceCode(APPROVAL_ID_0, digest), state: 'awaiting_approval',
  } });
  assert.equal(res.json.job.matchCode, computeMatchCode(APPROVAL_ID_0, digest));
  assert.match(res.json.job.matchCode, /^\d{4}$/);
  assert.equal(r.hands.started.length, 0, 'nothing reaches the hands before approval');
});

test('approval test: one fixed synthetic.noop, whose digest and match code are the contract vectors', async (t) => {
  const r = await start(t);
  const res = await r.call('POST', TEST, { body: {} });
  assert.equal(res.status, 202);
  const vector = vectorsOf('test-vectors.json').digestVectors.find((v) => v.name === 'noop-empty-args');
  assert.equal(res.json.job.actionDigest, vector.expected.digest, 'the room computes the contract digest of the fixed noop action');
  assert.equal(res.json.job.matchCode, referenceCode(APPROVAL_ID_0, vector.expected.digest));
  assert.equal(res.json.job.matchCode, '6762');
  assert.equal(res.json.job.kind, 'test');
  assert.equal(res.json.job.task, undefined);
  r.approvals.approve(0);
  const done = await r.until('job-1', 'approved');
  assert.equal(done.code, undefined);
  assert.equal(r.hands.started.length, 0, 'an approved test starts nothing');
});

test('only the approved string reaches the hands: after approval, byte for byte, with the claim operation id', async (t) => {
  const r = await start(t);
  const task = 'Type \u3053\u3093\u306b\u3061\u306f then save';
  const res = await r.call('POST', JOBS, { body: { computerId: 'pc-02', task } });
  assert.equal(res.status, 202);
  assert.equal(r.hands.started.length, 0);
  r.approvals.approve(0, 'op-claimed-1');
  await r.until('job-1', 'started');
  assert.deepEqual(r.hands.started, [{ computerId: 'pc-02', task, operationId: 'op-claimed-1' }]);
});

test('an unapproved string never reaches the hands: waiting, denied, expired and a bad claim all start nothing', async (t) => {
  const r = await start(t);
  const first = await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: 'first task' } });
  const second = await r.call('POST', JOBS, { body: { computerId: 'pc-02', task: 'second task' } });
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  assert.equal(r.hands.started.length, 0, 'while the person has not decided');
  r.approvals.deny(0, 'start_denied');
  await r.until(first.json.job.jobId, 'refused');
  r.approvals.deny(1, 'start_expired');
  const expired = await r.until(second.json.job.jobId, 'refused');
  assert.equal(expired.code, 'start_expired');
  assert.equal(r.hands.started.length, 0);

  // A code the room does not know becomes start_error; an approval with no usable operation id starts nothing either.
  const third = await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: 'third task' } });
  r.approvals.deny(2, 'made-up <script> code');
  assert.equal((await r.until(third.json.job.jobId, 'refused')).code, 'start_error');
  for (const [index, operationId] of [[3, undefined], [4, '../x'], [5, 42]]) {
    const res = await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: `task ${index}` } });
    r.approvals.approve(index, operationId);
    assert.equal((await r.until(res.json.job.jobId, 'refused')).code, 'start_error', String(operationId));
  }
  assert.equal(r.hands.started.length, 0);
});

test('a port that answers with another task, computer or action is refused and nothing is started', async (t) => {
  const lies = [
    (s) => ({ ...s, action: { ...s.action, args: { task: `${TASK} and then delete everything` } } }),
    (s) => ({ ...s, action: { ...s.action, computerId: 'pc-02' } }),
    (s) => ({ ...s, action: { ...s.action, action: 'task.cancel' } }),
    (s) => ({ ...s, purpose: 'broker.operation' }),
    (s) => ({ ...s, action: { ...s.action, args: { task: TASK, command: 'powershell' } } }),
    (s) => ({ ...s, action: { ...s.action, args: {} } }),
  ];
  for (const change of lies) {
    const r = await start(t, { approvalOptions: { change } });
    const res = await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: TASK } });
    assert.equal(res.status, 502);
    assert.ok(['submit_mismatch', 'submit_invalid'].includes(res.json.error), res.text);
    assert.deepEqual(await r.jobs(), [], 'no job and no match code is shown for it');
    r.approvals.approve(0);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert.equal(r.hands.started.length, 0);
  }
  const bad = [
    (s) => ({ ...s, approvalId: 'not-a-uuid' }), (s) => ({ ...s, decided: undefined }), () => ({ ok: false, code: 'queue_full' }), () => ({ ok: false, code: '<b>x</b>' }), () => null,
  ];
  for (const change of bad) {
    const r = await start(t, { approvalOptions: { change } });
    const res = await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: TASK } });
    assert.equal(res.status, 502);
    assert.ok(['submit_invalid', 'queue_full', 'submit_failed'].includes(res.json.error), res.text);
    assert.ok(!res.text.includes('<b>'));
  }
});

test('a task.start action may also name the VM and its generation (the attestation args), and the hands get the same task', async (t) => {
  const change = (s) => ({ ...s, action: { ...s.action, args: { ...s.action.args, vmId: 'vm-a', expectedGeneration: 2 } } });
  const r = await start(t, { approvalOptions: { change } });
  const res = await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: TASK } });
  assert.equal(res.status, 202);
  const digest = computeActionDigest('guest.command', { action: 'task.start', projectId: 'proj-alpha', computerId: 'pc-01', args: { task: TASK, vmId: 'vm-a', expectedGeneration: 2 } });
  assert.equal(res.json.job.actionDigest, digest, 'the digest is that of the submitted action, with those args');
  r.approvals.approve(0);
  await r.until('job-1', 'started');
  assert.deepEqual(r.hands.started, [{ computerId: 'pc-01', task: TASK, operationId: 'op-1', vmId: 'vm-a', expectedGeneration: 2 }], 'the approved VM and generation travel to the hands');
});

test('a vmId or generation of the wrong type in the submitted action is refused', async (t) => {
  for (const args of [{ vmId: 7 }, { vmId: '../vm' }, { expectedGeneration: '2' }, { expectedGeneration: 1.5 }]) {
    const change = (s) => ({ ...s, action: { ...s.action, args: { ...s.action.args, ...args } } });
    const r = await start(t, { approvalOptions: { change } });
    const res = await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: TASK } });
    assert.deepEqual([res.status, res.json.error], [502, 'submit_mismatch'], JSON.stringify(args));
    assert.deepEqual(await r.jobs(), [], 'the pending job is dropped');
  }
});

/** Wait until the list shows `count` jobs in state `submitting` (requests asked, the Authority not answered). */
async function untilSubmitting(r, count) {
  for (let i = 0; i < 200; i++) {
    if ((await r.jobs()).filter((j) => j.state === 'submitting').length >= count) return;
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  assert.fail('no request in flight');
}

test('two requests for the same computer at once: one asks the Authority, the other is 409 (the check sees the one in flight)', async (t) => {
  const r = await start(t);
  let release;
  r.approvals.hold = new Promise((resolve) => { release = resolve; });
  const first = r.call('POST', JOBS, { body: { computerId: 'pc-01', task: 'first' } });
  await untilSubmitting(r, 1);
  const second = await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: 'second' } });
  assert.deepEqual([second.status, second.json.error], [409, 'approval_in_progress']);
  const testRun = r.call('POST', TEST, { body: {} });
  await untilSubmitting(r, 2);
  const testAgain = await r.call('POST', TEST, { body: {} });
  assert.deepEqual([testAgain.status, testAgain.json.error], [409, 'approval_in_progress'], 'the same holds for the approval test');
  release();
  assert.equal((await first).status, 202);
  assert.equal((await testRun).status, 202);
  assert.equal(r.approvals.asked.filter((a) => a.task === 'second').length, 0, 'the refused one never asked');
  assert.equal(r.approvals.asked.filter((a) => a.task === 'first').length, 1);
});

test('the cap on waiting jobs counts requests in flight too', async (t) => {
  const approvals = createFakeApprovals();
  const hands = createFakeHands();
  const many = Array.from({ length: MAX_WAITING_JOBS + 1 }, (_, i) => ({ computerId: `pc-${i + 1}` }));
  const r = await startRouteHost(t, createRoomJobRoutes({ approvals, hands, targets: () => many }));
  let release;
  approvals.hold = new Promise((resolve) => { release = resolve; });
  const sent = many.slice(0, MAX_WAITING_JOBS).map((m) => r.call('POST', JOBS, { body: { computerId: m.computerId, task: `task for ${m.computerId}` } }));
  for (let i = 0; i < 400; i++) {
    const list = (await r.call('GET', JOBS)).json.jobs;
    if (list.filter((j) => j.state === 'submitting').length >= MAX_WAITING_JOBS) break;
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  const over = await r.call('POST', JOBS, { body: { computerId: many.at(-1).computerId, task: 'one too many' } });
  assert.deepEqual([over.status, over.json.error], [429, 'too_many_waiting']);
  release();
  assert.ok((await Promise.all(sent)).every((res) => res.status === 202));
});

test('stop all while a request is still being sent: the job is cancelled, nothing is shown or started, even if it is approved later', async (t) => {
  const r = await start(t);
  let release;
  r.approvals.hold = new Promise((resolve) => { release = resolve; });
  const sending = r.call('POST', JOBS, { body: { computerId: 'pc-01', task: TASK } });
  await untilSubmitting(r, 1);
  const stop = await r.call('POST', STOP_ALL, { body: {} });
  assert.deepEqual([stop.status, stop.json.cancelled], [200, 1], 'the request in flight was seen by stop all');
  release();
  const answered = await sending;
  assert.deepEqual([answered.status, answered.json], [409, { error: 'stopped' }], 'no job and no match code are returned for it');
  const [job] = await r.jobs();
  assert.deepEqual([job.state, job.code, job.matchCode], ['cancelled', 'stopped', undefined]);
  r.approvals.approve(0);
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  assert.equal(r.hands.started.length, 0);
  assert.equal((await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: 'after' } })).status, 202, 'the computer is free again');
});

test('the port failing (a fixed code, or an exception with text) is a fixed code and never the text', async (t) => {
  const r = await start(t);
  r.approvals.failNext = new Error('pipe \\\\.\\pipe\\secret-name refused: token=abc');
  const thrown = await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: TASK } });
  assert.deepEqual([thrown.status, thrown.json], [502, { error: 'submit_failed' }]);
  r.approvals.failNext = { ok: false, code: 'authority_unavailable' };
  assert.deepEqual((await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: TASK } })).json, { error: 'authority_unavailable' });
  assert.deepEqual(await r.jobs(), []);
});

test('start: the task rules of the gate, the exact body shape, and a known computer', async (t) => {
  const r = await start(t);
  const refuse = async (body, status, error) => {
    const res = await r.call('POST', JOBS, { body });
    assert.deepEqual([res.status, res.json.error], [status, error], JSON.stringify(body));
  };
  await refuse({ computerId: 'pc-01', task: '' }, 400, 'task_invalid');
  await refuse({ computerId: 'pc-01', task: 'x'.repeat(257) }, 400, 'task_invalid');
  await refuse({ computerId: 'pc-01', task: '\u3042'.repeat(86) }, 400, 'task_invalid'); // 258 bytes
  await refuse({ computerId: 'pc-01', task: 'line\nbreak' }, 400, 'task_invalid');
  await refuse({ computerId: 'pc-01', task: 'rtl \u202e override' }, 400, 'task_invalid');
  await refuse({ computerId: 'pc-01', task: 'zero\u0000byte' }, 400, 'task_invalid');
  await refuse({ computerId: 'pc-01', task: '\ud800' }, 400, 'task_invalid');
  await refuse({ computerId: 'pc-99', task: TASK }, 404, 'computer_unknown');
  await refuse({ computerId: '../pc-01', task: TASK }, 404, 'computer_unknown');
  await refuse({ computerId: 'pc-01' }, 400, 'invalid_request');
  await refuse({ task: TASK }, 400, 'invalid_request');
  await refuse({ computerId: 'pc-01', task: TASK, command: 'powershell' }, 400, 'invalid_request');
  await refuse({ computerId: 'pc-01', task: 7 }, 400, 'invalid_request');
  await refuse({ computerId: ['pc-01'], task: TASK }, 400, 'invalid_request');
  assert.equal(r.approvals.asked.length, 0, 'no approval was asked for any of them');
  const edge = await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: 'x'.repeat(256) } });
  assert.equal(edge.status, 202, '256 bytes is the limit and it is allowed');
});

test('the body limit holds: a body over the route limit is 413 and asks for nothing', async (t) => {
  const r = await start(t);
  assert.equal(JOB_MAX_BODY_BYTES, 2048);
  const big = JSON.stringify({ computerId: 'pc-01', task: 'x'.repeat(JOB_MAX_BODY_BYTES) });
  const res = await r.call('POST', JOBS, { rawBody: big });
  assert.deepEqual([res.status, res.json], [413, { error: 'body_too_large' }]);
  const stop = await r.call('POST', STOP_ALL, { rawBody: JSON.stringify({ pad: 'x'.repeat(200) }) });
  assert.equal(stop.status, 413);
  assert.equal(r.approvals.asked.length, 0);
});

test('every job route refuses a request with no session, no Origin, a wrong Origin, no Sec-Fetch-Site or the wrong content type', async (t) => {
  const r = await start(t);
  const posts = [[JOBS, { computerId: 'pc-01', task: TASK }], [STOP_ALL, {}], [TEST, {}]];
  const cases = [
    ['no cookie', { cookie: null }, 401], ['no Origin', { headers: { Origin: undefined } }, 403], ['another Origin', { headers: { Origin: 'http://localhost:1' } }, 403],
    ['no Sec-Fetch-Site', { headers: { 'Sec-Fetch-Site': undefined } }, 403], ['cross-site', { headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403],
    ['same-site', { headers: { 'Sec-Fetch-Site': 'same-site' } }, 403], ['text/plain', { headers: { 'Content-Type': 'text/plain' } }, 415],
  ];
  for (const [path, body] of posts) {
    for (const [what, options, status] of cases) assert.equal((await r.call('POST', path, { body, ...options })).status, status, `${path}: ${what}`);
  }
  for (const [what, options, status] of [['no cookie', { cookie: null }, 401], ['no Sec-Fetch-Site', { headers: { 'Sec-Fetch-Site': undefined } }, 403], ['cross-site', { headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403]]) {
    assert.equal((await r.call('GET', JOBS, options)).status, status, `GET: ${what}`);
  }
  assert.equal(r.approvals.asked.length, 0, 'none of the refused requests asked for approval');
  assert.equal(r.hands.stops.length, 0, 'none of the refused requests stopped anything');
});

test('stop all: cancels what waits, stops the hands, and a later approval of a cancelled job starts nothing', async (t) => {
  const r = await start(t, { handsOptions: { stopped: 2 } });
  await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: 'first' } });
  await r.call('POST', JOBS, { body: { computerId: 'pc-02', task: 'second' } });
  const stop = await r.call('POST', STOP_ALL, { body: {} });
  assert.deepEqual([stop.status, stop.json], [200, { ok: true, cancelled: 2, stopped: 2 }]);
  assert.equal(r.hands.stops.length, 1);
  assert.deepEqual((await r.jobs()).map((j) => [j.state, j.code]), [['cancelled', 'stopped'], ['cancelled', 'stopped']]);
  r.approvals.approve(0);
  r.approvals.approve(1);
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  assert.equal(r.hands.started.length, 0, 'the approvals arrived after the stop');
  assert.ok((await r.jobs()).every((j) => j.state === 'cancelled'));
  // A new job after the stop works normally.
  await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: 'after the stop' } });
  r.approvals.approve(2);
  await r.until('job-3', 'started');
  assert.equal(r.hands.started.length, 1);
});

test('stop all in the middle of a start stops the hands again, because they may have come up after the first stop', async (t) => {
  const r = await start(t);
  let release;
  r.hands.gate.block = new Promise((resolve) => { release = resolve; });
  await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: 'slow start' } });
  r.approvals.approve(0);
  await r.until('job-1', 'starting');
  assert.equal(r.hands.started.length, 1);
  const stop = await r.call('POST', STOP_ALL, { body: {} });
  assert.equal(stop.json.cancelled, 1);
  assert.equal(r.hands.stops.length, 1);
  release();
  for (let i = 0; i < 100 && r.hands.stops.length < 2; i++) await new Promise((resolve) => { setTimeout(resolve, 10); });
  assert.equal(r.hands.stops.length, 2, 'stopped again after the start returned');
  assert.equal((await r.jobs())[0].state, 'cancelled');
});

test('stop all: a hands failure is reported as stop_failed, and the waiting jobs are cancelled anyway', async (t) => {
  const approvals = createFakeApprovals();
  const hands = { start: async () => ({ ok: true }), stopAll: async () => { throw new Error('taskkill said: secret detail'); } };
  const r = await startRouteHost(t, createRoomJobRoutes({ approvals, hands, targets: () => TARGETS }));
  await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: TASK } });
  const stop = await r.call('POST', STOP_ALL, { body: {} });
  assert.deepEqual([stop.status, stop.json], [500, { error: 'stop_failed', cancelled: 1 }]);
  assert.ok(!stop.text.includes('secret detail'));
  assert.equal((await r.call('GET', JOBS)).json.jobs[0].state, 'cancelled');
  assert.equal((await r.call('POST', STOP_ALL, { body: { force: true } })).status, 400, 'stop all takes an empty object only');
});

test('one approval at a time per computer, one test at a time, and a cap on how many wait', async (t) => {
  const r = await start(t);
  assert.equal((await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: 'one' } })).status, 202);
  const again = await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: 'two' } });
  assert.deepEqual([again.status, again.json.error], [409, 'approval_in_progress']);
  assert.equal((await r.call('POST', JOBS, { body: { computerId: 'pc-02', task: 'other computer' } })).status, 202);
  assert.equal((await r.call('POST', TEST, { body: {} })).status, 202);
  assert.equal((await r.call('POST', TEST, { body: {} })).status, 409);
  assert.equal(r.approvals.asked.length, 3, 'the refused ones asked for nothing');
  r.approvals.deny(0);
  await r.until('job-1', 'refused');
  assert.equal((await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: 'again' } })).status, 202, 'free again once decided');
  assert.equal(MAX_WAITING_JOBS, 8);
  assert.equal(MAX_KEPT_JOBS, 16);
});

test('the job list keeps the latest jobs, and the targets are the injected ones with clean labels', async (t) => {
  const approvals = createFakeApprovals();
  const hands = createFakeHands();
  const targets = () => [{ computerId: 'pc-01', label: 'Alpha\u0000\nPC' }, { computerId: 'bad id', label: 'x' }, { computerId: 'pc-03' }, null];
  const r = await startRouteHost(t, createRoomJobRoutes({ approvals, hands, targets }));
  const list = (await r.call('GET', JOBS)).json;
  assert.deepEqual(list.targets, [{ computerId: 'pc-01', label: 'Alpha PC' }, { computerId: 'pc-03', label: 'pc-03' }]);
  for (let i = 0; i < MAX_KEPT_JOBS + 4; i++) {
    const res = await r.call('POST', JOBS, { body: { computerId: 'pc-01', task: `task ${i}` } });
    assert.equal(res.status, 202);
    approvals.deny(i);
    for (let k = 0; k < 100; k++) { if ((await r.call('GET', JOBS)).json.jobs.at(-1).state === 'refused') break; await new Promise((resolve) => { setTimeout(resolve, 5); }); }
  }
  const kept = (await r.call('GET', JOBS)).json.jobs;
  assert.equal(kept.length, MAX_KEPT_JOBS);
  assert.equal(kept.at(-1).task, `task ${MAX_KEPT_JOBS + 3}`);
});

test('the routes need their ports', () => {
  const ok = { approvals: createFakeApprovals(), hands: createFakeHands(), targets: () => [] };
  createRoomJobRoutes(ok);
  for (const bad of [{}, { ...ok, approvals: {} }, { ...ok, hands: { start() {} } }, { ...ok, targets: [] }, { ...ok, newJobId: 'x' }]) {
    assert.throws(() => createRoomJobRoutes(bad), /invalid_room_job_dependencies/);
  }
});
