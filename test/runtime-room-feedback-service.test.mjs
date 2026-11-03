// `room-service` and the feedback panel (src/runtime/room-service-wiring.mjs, room-service-config.mjs): feedback is OFF unless the service file says `feedback: true`. Off means no route and no change
// to the CSP; on means the route and the contract's one origin in connect-src, together. The real room host, routes and approval wiring with the Fakes of test/helpers/room-service-world.mjs.
// The address is the contract's (FEEDBACK_ORIGIN / FEEDBACK_ENDPOINT); it is not written out here because the real one is not decided yet.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { FEEDBACK_ENDPOINT, FEEDBACK_ORIGIN } from '../src/runtime/feedback-contract.mjs';
import { ALBERA_VERSION } from '../src/runtime/albera-version.mjs';
import { parseServiceConfig } from '../src/runtime/room-service-config.mjs';
import { makeServiceWorld } from './helpers/room-service-world.mjs';

const CSP_BEFORE = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";
const CSP_WITH_FEEDBACK = CSP_BEFORE.replace("connect-src 'self';", `connect-src 'self' ${FEEDBACK_ORIGIN};`);

const cspOf = async (room) => (await fetch(`${room.origin}/room/`)).headers.get('content-security-policy');

// ---- the setting ----

const CP_SID = 'S-1-5-80-1111111111-2222222222-3333333333-4444444444-5555555555';
const OWNER_SID = 'S-1-5-21-1000000000-2000000000-3000000000-1001';
const INSTALL = path.resolve(path.sep, 'albera-test');
const valid = (patch = {}) => ({
  claude: { executable: path.join(INSTALL, 'claude.exe'), executableSha256: 'a'.repeat(64) }, ui: { controlPlaneSid: CP_SID, approverSid: OWNER_SID }, ...patch,
});
const parse = (object) => parseServiceConfig(JSON.stringify(object), { installDir: INSTALL });
const codeOf = (fn) => { try { fn(); } catch (error) { return error.message; } return 'no error'; };

test('the service file\'s `feedback` is an optional boolean and the default is off', () => {
  assert.equal(parse(valid()).feedback, false, 'absent: off');
  assert.equal(parse(valid({ feedback: false })).feedback, false);
  assert.equal(parse(valid({ feedback: true })).feedback, true);
  for (const bad of ['true', 'false', 1, 0, null, {}, []]) assert.equal(codeOf(() => parse(valid({ feedback: bad }))), 'room_service_config_feedback', JSON.stringify(bad));
  assert.equal(codeOf(() => parse(valid({ feedbak: true }))), 'room_service_config_unknown_key', 'a misspelt key is refused, not ignored');
});

// ---- the service ----

test('by default the service has no feedback route and the CSP is unchanged', async (t) => {
  const w = await makeServiceWorld(t);
  await w.start();
  const room = await w.open();
  assert.equal(room.unlocked, 200);
  const res = await room.call('GET', 'api/feedback');
  assert.equal(res.status, 404, res.text);
  assert.equal(await cspOf(room), CSP_BEFORE);
});

test('`feedback: false` is the same as the default', async (t) => {
  const w = await makeServiceWorld(t, { servicePatch: { feedback: false } });
  await w.start();
  const room = await w.open();
  assert.equal((await room.call('GET', 'api/feedback')).status, 404);
  assert.equal(await cspOf(room), CSP_BEFORE);
});

test('`feedback: true` registers the route and adds the contract\'s origin to connect-src, and nothing else changes in the CSP; the version is ALBERA_VERSION', async (t) => {
  const w = await makeServiceWorld(t, { servicePatch: { feedback: true } });
  await w.start();
  const room = await w.open();
  const res = await room.call('GET', 'api/feedback');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, { ok: true, endpoint: FEEDBACK_ENDPOINT, version: ALBERA_VERSION });
  assert.equal(await cspOf(room), CSP_WITH_FEEDBACK);
  assert.equal((await fetch(`${room.origin}/room/api/feedback`)).status, 403, 'a request that does not say it is this page is refused, session or not');
});

test('a version given to the service is the one the panel is told (and only if it fits the request)', async (t) => {
  const given = await makeServiceWorld(t, { servicePatch: { feedback: true } });
  await given.start({ version: '0.2.0 (7403ef2)' });
  assert.equal((await (await given.open()).call('GET', 'api/feedback')).json.version, '0.2.0 (7403ef2)');
  const odd = await makeServiceWorld(t, { servicePatch: { feedback: true } });
  await odd.start({ version: 'not\nprintable' });
  assert.equal((await (await odd.open()).call('GET', 'api/feedback')).json.version, 'unknown');
});

test('the room page itself is served the same whether feedback is on or off (the panel asks the room, it is not built differently)', async (t) => {
  const off = await makeServiceWorld(t);
  await off.start();
  const on = await makeServiceWorld(t, { servicePatch: { feedback: true } });
  await on.start();
  const [pageOff, pageOn] = await Promise.all([off, on].map(async (w) => (await fetch(`${(await w.open()).origin}/room/`)).text()));
  assert.equal(pageOff, pageOn);
  assert.ok(pageOn.includes('id="open-feedback"') && pageOn.includes('feedback.mjs'));
});
