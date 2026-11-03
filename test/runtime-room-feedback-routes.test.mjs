// The room host's side of the feedback panel: the one route (src/runtime/room-feedback-routes.mjs), the `feedback` option (CSP connect-src), and the files the host serves for the page.
// Real hosts on 127.0.0.1 (test/helpers/room-route-host.mjs). The address is the contract's (FEEDBACK_ORIGIN / FEEDBACK_ENDPOINT); it is never written out here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { FEEDBACK_ENDPOINT, FEEDBACK_ORIGIN } from '../src/runtime/feedback-contract.mjs';
import { UNKNOWN_VERSION, createRoomFeedbackRoutes, projectVersion } from '../src/runtime/room-feedback-routes.mjs';
import { createRoomHost } from '../src/runtime/room-host.mjs';
import { roomStubs, startRouteHost } from './helpers/room-route-host.mjs';

const runtime = (name) => fs.readFileSync(new URL(`../src/runtime/${name}`, import.meta.url), 'utf8');
/** The CSP of the room as it was before feedback existed, character for character. */
const CSP_BEFORE = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";

// ---- the route ----

test('projectVersion: printable ASCII of 1 to 64 characters passes; anything else is "unknown"', () => {
  for (const ok of ['0.2.0', '0.2.0 (7403ef2)', 'a', 'x'.repeat(64), '~ !']) assert.equal(projectVersion(ok), ok, ok);
  for (const bad of ['', 'x'.repeat(65), 'vあ', 'line\nbreak', 'tab\there', '\u007f', 5, null, undefined, {}, ['0.2.0']]) assert.equal(projectVersion(bad), UNKNOWN_VERSION, String(bad));
  assert.equal(UNKNOWN_VERSION, 'unknown');
});

test('createRoomFeedbackRoutes: one GET /api/feedback that answers { ok, endpoint, version } and nothing else', async () => {
  const routes = createRoomFeedbackRoutes({ version: '0.2.0' });
  assert.equal(routes.length, 1);
  assert.deepEqual([routes[0].method, routes[0].path], ['GET', '/api/feedback']);
  assert.ok(Object.isFrozen(routes) && Object.isFrozen(routes[0]));
  assert.deepEqual(await routes[0].handle({}), { status: 200, body: { ok: true, endpoint: FEEDBACK_ENDPOINT, version: '0.2.0' } });
  assert.equal((await createRoomFeedbackRoutes()[0].handle({})).body.version, 'unknown', 'no version given: unknown');
  assert.equal((await createRoomFeedbackRoutes({ version: 'bad\nversion' })[0].handle({})).body.version, 'unknown', 'a version that does not fit is not passed on');
});

test('GET api/feedback through the real host: same-origin and a session, the three fields only; no session, no Sec-Fetch-Site, a cross-site page and any other method are refused', async (t) => {
  const r = await startRouteHost(t, createRoomFeedbackRoutes({ version: '0.2.0 (test)' }), { feedback: true });
  const ok = await r.call('GET', 'api/feedback');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, endpoint: FEEDBACK_ENDPOINT, version: '0.2.0 (test)' });
  assert.deepEqual(Object.keys(ok.json), ['ok', 'endpoint', 'version'], 'no OS, no errors, nothing else about the machine');
  assert.equal((await r.call('GET', 'api/feedback', { cookie: null })).status, 401);
  assert.equal((await r.call('GET', 'api/feedback', { headers: { 'Sec-Fetch-Site': undefined } })).status, 403);
  assert.equal((await r.call('GET', 'api/feedback', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await r.call('GET', 'api/feedback', { headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403);
  assert.equal((await r.call('POST', 'api/feedback', { body: {} })).status, 405);
});

test('a room with no feedback route answers 404 once the person has a session (the panel reads that as "off in this room")', async (t) => {
  const r = await startRouteHost(t, []);
  const res = await r.call('GET', 'api/feedback');
  assert.equal(res.status, 404);
  assert.deepEqual(res.json, { error: 'not_found' });
});

// ---- the CSP ----

test('CSP: without `feedback` it is exactly what it was; with it only connect-src gains the contract\'s origin', async (t) => {
  const off = await startRouteHost(t, []);
  const on = await startRouteHost(t, createRoomFeedbackRoutes(), { feedback: true });
  const explicitOff = await startRouteHost(t, [], { feedback: false });
  const withFeedback = CSP_BEFORE.replace("connect-src 'self';", `connect-src 'self' ${FEEDBACK_ORIGIN};`);
  assert.notEqual(withFeedback, CSP_BEFORE);
  for (const [room, expected] of [[off, CSP_BEFORE], [explicitOff, CSP_BEFORE], [on, withFeedback]]) {
    for (const route of ['', 'app.mjs', 'api/state', 'nothing-here']) {
      const res = await fetch(`${room.address.url}${route}`, { headers: { Cookie: room.cookie, 'Sec-Fetch-Site': 'same-origin' } });
      assert.equal(res.headers.get('content-security-policy'), expected, route || '/');
    }
  }
  const origins = withFeedback.match(/connect-src ([^;]*);/u)[1].split(' ');
  assert.deepEqual(origins, ["'self'", FEEDBACK_ORIGIN], 'one origin, no wildcard');
  assert.match(FEEDBACK_ORIGIN, /^https:\/\/[^/*]+$/u);
});

test('`feedback` must be a real boolean', () => {
  for (const bad of ['true', 1, null, {}, []]) assert.throws(() => createRoomHost({ ...roomStubs(), feedback: bad }), { message: 'feedback must be a boolean' }, String(bad));
  assert.doesNotThrow(() => createRoomHost({ ...roomStubs(), feedback: true }));
});

// ---- what the host serves for the page ----

test('the host serves feedback.mjs, words-feedback.mjs and, as feedback-contract.mjs, the runtime\'s own contract (not room-ui\'s Node-side stand-in)', async (t) => {
  const r = await startRouteHost(t, []);
  for (const [served, file] of [['feedback.mjs', 'room-ui/feedback.mjs'], ['words-feedback.mjs', 'room-ui/words-feedback.mjs'], ['feedback-contract.mjs', 'feedback-contract.mjs']]) {
    const res = await fetch(`${r.address.url}${served}`);
    assert.equal(res.status, 200, served);
    assert.match(res.headers.get('content-type'), /text\/javascript/u, served);
    assert.equal(await res.text(), runtime(file), served);
  }
  const standIn = runtime('room-ui/feedback-contract.mjs');
  assert.match(standIn, /export \* from '\.\.\/feedback-contract\.mjs'/u);
  assert.notEqual(runtime('feedback-contract.mjs'), standIn);
  assert.match(runtime('feedback-contract.mjs'), /export const FEEDBACK_ENDPOINT/u);
});

test('every file the page names, and every module a room-ui module imports, is one the host serves', async (t) => {
  const r = await startRouteHost(t, []);
  const page = await (await fetch(r.address.url)).text();
  const named = [...page.matchAll(/(?:src|href)="([^"#]+)"/gu)].map((m) => m[1]);
  assert.ok(named.includes('feedback.mjs') && named.includes('panels.css'));
  const imported = new Set();
  for (const file of fs.readdirSync(new URL('../src/runtime/room-ui/', import.meta.url)).filter((name) => name.endsWith('.mjs') && name !== 'feedback-contract.mjs')) {
    for (const m of runtime(`room-ui/${file}`).matchAll(/^\s*(?:import|export)\b[^'"\n]*?from\s*'\.\/([^']+)'|^\s*import\s*'\.\/([^']+)'/gmu)) imported.add(m[1] ?? m[2]);
  }
  assert.ok(imported.has('feedback-contract.mjs') && imported.has('words-feedback.mjs'));
  for (const name of new Set([...named, ...imported])) {
    const res = await fetch(`${r.address.url}${name}`);
    assert.equal(res.status, 200, `${name} is asked for by the page and must be served`);
    await res.arrayBuffer();
  }
});
