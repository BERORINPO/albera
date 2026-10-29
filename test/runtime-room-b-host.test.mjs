import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createRoomHost, NUDGE_TASK, recheckTask, MAX_PINNED_FRAMES } from '../src/runtime/room-host.mjs';
import { createAgentStatusBoard } from '../src/runtime/agent-status-board.mjs';
import { HyperVDesktopDriver } from '../src/runtime/hyperv-desktop-driver.mjs';
import { createMockDesktopBroker } from '../src/runtime/mock-desktop-broker.mjs';
import { cleanParams, validEvent } from '../src/runtime/room-contract.mjs';
import { createDemoBroker, demoStep, DEMO_SCREEN, DEMO_VMS, missingRoomParts, startRoomDemo } from '../src/runtime/room-demo.mjs';
import { parseRuntimeArgs, RUNTIME_HELP } from '../src/runtime/entry.mjs';
import { bandText, camTone, cursorSpot } from '../src/runtime/room-ui/cam.mjs';
import WORDS_CAM from '../src/runtime/room-ui/words-cam.mjs';

const screen = Object.freeze({ width: 64, height: 48 });
const VMS = [{ vmId: 'vm-a', label: 'Alpha', task: 'open notepad and write hello' }, { vmId: 'vm-b', label: 'Beta' }];

// ---- fakes of part C (journal), part D (director) and the fleet ----

function fakeJournal(now) {
  const entries = [];
  const add = (vmId, actor, code, params) => {
    const entry = Object.freeze({ seq: entries.length + 1, at: now(), vmId, actor, code, params: cleanParams(params) });
    entries.push(entry);
    return entry;
  };
  return {
    entries,
    record: ({ vmId, actor, code, params }) => add(vmId, actor, code, params),
    recordFleetEvent: (vmId, ev) => (ev.type === 'step' ? add(vmId, 'hands', 'hands_step', { step: ev.step, usd: ev.usd, action: '', note: ev.note ?? '' }) : null),
    since: (seq) => entries.filter((e) => e.seq > seq),
    all: () => [...entries],
    lastSeq: () => entries.length,
  };
}

function fakeDirector() {
  const outputs = [];
  const cards = new Map();
  const calls = { tick: [], decide: [] };
  return {
    calls, cards,
    queue(output) { outputs.push(output); },
    tick(input) {
      calls.tick.push(input);
      const out = outputs.shift() ?? { acts: [], ledger: [] };
      for (const act of out.acts) if (act?.type === 'card') cards.set(act.card.cardId, { ...act.card, open: true });
      return out;
    },
    decide(cardId, choiceId) {
      calls.decide.push([cardId, choiceId]);
      const card = cards.get(cardId);
      if (!card) return { ok: false, code: 'card_unknown' };
      if (!card.open) return { ok: false, code: 'card_closed' };
      const choice = card.choices.find((c) => c.choiceId === choiceId);
      if (!choice) return { ok: false, code: 'choice_unknown' };
      card.open = false;
      return { ok: true, effect: { effect: choice.effect, vmId: card.vmId, cardId, choiceId }, ledger: [] };
    },
    openCards: () => [...cards.values()].filter((c) => c.open),
  };
}

function fakeFleet({ busy = new Set() } = {}) {
  const calls = [];
  return {
    calls, busy,
    startJob(vmId, task) { calls.push(['startJob', vmId, task]); if (busy.has(vmId)) return { ok: false, code: 'vm_busy' }; return { ok: true }; },
    stopVm(vmId) { calls.push(['stopVm', vmId]); const was = busy.has(vmId); busy.delete(vmId); return was; },
    async idle() {},
  };
}

const card = (cardId, { vmId = 'vm-a', ba = false, effects = ['stop', 'nudge', 'recheck'] } = {}) => ({
  type: 'card',
  card: {
    cardId, vmId, code: 'stalled', params: { seconds: 60 }, openedAt: 1,
    choices: effects.map((effect, i) => ({ choiceId: `${cardId}-c${i}`, code: `pick_${effect}`, effect })),
    figure: ba ? { figureId: `fig-${cardId}`, kind: 'ba', vmId, before: { frameId: null }, after: { frameId: null }, sources: [] } : null,
  },
});

async function start(t, { vms = VMS, broker = createMockDesktopBroker(screen), fleet = fakeFleet(), director = fakeDirector() } = {}) {
  const clock = { t: Date.parse('2026-10-29T12:00:00.000Z') };
  const now = () => clock.t;
  const board = createAgentStatusBoard({ now });
  const journal = fakeJournal(now);
  const host = createRoomHost({
    vms, board, journal, director, fleet, now, captureIntervalMs: 60_000, tickMs: 60_000,
    driver: (resolveCurrentLease) => new HyperVDesktopDriver({ broker, resolveCurrentLease, now, screen }),
  });
  const address = await host.listen(0);
  t.after(() => host.close());
  const origin = new URL(address.url).origin;
  const jsonHeaders = { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };
  const unlock = async () => {
    const res = await fetch(`${address.url}api/session`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ bootstrapCode: address.bootstrapCode }) });
    assert.equal(res.status, 200);
    return res.headers.get('set-cookie').split(';')[0];
  };
  const get = (p, cookie, init = {}) => fetch(`${address.url}${p}`, { ...init, headers: { ...(cookie ? { Cookie: cookie } : {}), ...init.headers } });
  const decide = (cookie, body, headers = {}) => fetch(`${address.url}api/decide`, {
    method: 'POST', headers: { ...jsonHeaders, ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const state = async (cookie, since = 0) => (await get(`api/state?since=${since}`, cookie)).json();
  return { host, broker, board, journal, director, fleet, address, clock, origin, unlock, get, decide, state };
}

// ---- serving, auth, CSP ----

test('room: UI files come from a fixed list, with CSP and no-store; nothing else is served', async (t) => {
  const r = await start(t);
  const page = await r.get('');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(page.headers.get('content-security-policy'), /img-src 'self'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  for (const file of ['cam.mjs', 'cam.css', 'words-cam.mjs', 'app.mjs', 'room.css', 'bero.mjs', 'figure.css']) assert.equal((await r.get(file)).status, 200, file);
  assert.match((await r.get('cam.mjs')).headers.get('content-type'), /text\/javascript/);
  for (const file of ['../room-host.mjs', '%2E%2E/room-host.mjs', 'room-contract.mjs', 'index.html.bak', 'wall.mjs']) assert.equal((await r.get(file)).status, 404, file);
  assert.equal((await fetch(`http://127.0.0.1:${r.address.port}/wall/`)).status, 404);
});

test('room: api needs the one-time code; the cookie is HttpOnly, SameSite=Strict, Path=/room/', async (t) => {
  const r = await start(t);
  assert.equal((await r.get('api/state')).status, 401);
  assert.equal((await r.get('api/vms/vm-a/screen.png')).status, 401);
  const res = await fetch(`${r.address.url}api/session`, {
    method: 'POST', headers: { Origin: r.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrapCode: r.address.bootstrapCode }),
  });
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie.startsWith(`${r.host.cookieName}=`));
  assert.match(r.host.cookieName, new RegExp(`^albera_room_${r.address.port}_[0-9a-f]{12}$`));
  assert.match(setCookie, /Max-Age=28800/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\/room\//);
  const again = await fetch(`${r.address.url}api/session`, {
    method: 'POST', headers: { Origin: r.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrapCode: r.address.bootstrapCode }),
  });
  assert.equal(again.status, 403);
  const cookie = setCookie.split(';')[0];
  assert.equal((await r.get('api/state', cookie)).status, 200);
  assert.equal((await r.get('api/state', `${r.host.cookieName}=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)).status, 401);
});

test('room: a foreign Host header and cross-site requests are refused', async (t) => {
  const r = await start(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: r.address.port, path: '/room/', headers: { Host: 'evil.example:80' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
  assert.equal((await r.get('', undefined, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

// ---- state, tick, frames ----

test('room: state lists VMs with their agent and pages events (at most 200, nextSince)', async (t) => {
  const r = await start(t);
  await r.host.captureOnce();
  r.board.record('vm-a', { type: 'action', action: 'left_click', ok: true, cursor: [3, 4] });
  const cookie = await r.unlock();
  r.director.queue({ acts: Array.from({ length: 250 }, () => ({ type: 'hush' })), ledger: [] });
  r.host.tickOnce();
  const first = await r.state(cookie, 0);
  assert.equal(first.events.length, 200);
  assert.equal(first.nextSince, 200);
  assert.ok(first.events.every(validEvent));
  assert.deepEqual(first.vms.map((vm) => [vm.vmId, vm.label, vm.status]), [['vm-a', 'Alpha', 'live'], ['vm-b', 'Beta', 'live']]);
  assert.deepEqual(first.vms[0].agent.cursor, [3, 4]);
  assert.equal(first.vms[1].agent, null);
  assert.equal(first.staleAfterMs, 10_000);
  assert.equal(typeof first.now, 'number');
  const second = await r.state(cookie, first.nextSince);
  assert.deepEqual([second.events.length, second.events[0].seq, second.nextSince], [50, 201, 250]);
  const none = await r.state(cookie, 250);
  assert.deepEqual([none.events.length, none.nextSince], [0, 250]);
  for (const bad of ['-1', 'abc', '1e3', '99999999999999999']) assert.equal((await r.get(`api/state?since=${bad}`, cookie)).status, 400, bad);
  assert.equal((await r.state(cookie, 9999)).events.length, 200, 'a since past the end starts over (host restart)');
});

test('room: tick feeds new journal entries to the director, records its ledger and drops invalid acts and items', async (t) => {
  const r = await start(t);
  const cookie = await r.unlock();
  r.host.recordFleetEvent('vm-a', { type: 'start', job: 1, task: 'open notepad\u0007 and write hello' });
  r.host.recordFleetEvent('vm-a', { type: 'step', step: 1, usd: 0.01, note: 'opening' });
  r.host.recordFleetEvent('vm-zzz', { type: 'step', step: 1, usd: 0.01 });
  r.director.queue({
    acts: [{ type: 'say', code: 'patrol', params: {}, cardId: null }, { type: 'say', code: 'not_a_code', params: {}, cardId: null }, { type: 'card', card: { cardId: 'bad' } }, { type: 'point', vmId: 'vm-a' }],
    ledger: [{ vmId: 'vm-a', actor: 'bero', code: 'bero_noticed', params: { what: 'stalled' } }, { vmId: 'vm-a', actor: 'human', code: 'human_choice', params: {} }, { vmId: 'vm-x', actor: 'bero', code: 'bero_card', params: {} }],
  });
  r.host.tickOnce();
  const tick = r.director.calls.tick[0];
  assert.deepEqual(tick.entries.map((e) => e.code), ['hands_started', 'hands_step']);
  assert.equal(tick.entries[0].params.task, 'open notepad  and write hello', 'control characters are removed');
  assert.ok('vm-a' in tick.agents || Object.keys(tick.agents).length === 0);
  const { events } = await r.state(cookie);
  assert.deepEqual(events.map((e) => (e.kind === 'ledger' ? e.entry.code : e.act.type)), ['hands_started', 'hands_step', 'bero_noticed', 'say', 'point']);
  r.host.tickOnce();
  assert.deepEqual(r.director.calls.tick[1].entries, [], 'the director does not see its own entries again');
});

test('room: a card act with a ba figure pins the VM frame; at most 8 pinned frames are kept', async (t) => {
  const r = await start(t);
  await r.host.captureOnce();
  const cookie = await r.unlock();
  r.director.queue({ acts: Array.from({ length: MAX_PINNED_FRAMES + 2 }, (_, i) => card(`k${i}`, { ba: true })), ledger: [] });
  r.director.queue({ acts: [card('plain')], ledger: [] });
  r.host.tickOnce();
  r.host.tickOnce();
  const { events } = await r.state(cookie);
  const cards = events.filter((e) => e.kind === 'bero' && e.act.type === 'card').map((e) => e.act.card);
  assert.equal(cards.length, MAX_PINNED_FRAMES + 3);
  const frameIds = cards.slice(0, -1).map((c) => c.figure.before.frameId);
  assert.ok(frameIds.every((id) => typeof id === 'string'));
  assert.equal(new Set(frameIds).size, frameIds.length);
  assert.equal(cards.at(-1).figure, null);
  assert.equal((await r.get(`api/frames/${frameIds[0]}.png`, cookie)).status, 404, 'oldest dropped');
  assert.equal((await r.get(`api/frames/${frameIds[1]}.png`, cookie)).status, 404, 'oldest dropped');
  const latest = await r.get(`api/frames/${frameIds.at(-1)}.png`, cookie);
  assert.equal(latest.status, 200);
  assert.equal(latest.headers.get('content-type'), 'image/png');
  assert.equal((await r.get(`api/frames/${frameIds.at(-1)}.png`)).status, 401);
  assert.equal((await r.get('api/frames/nope.png', cookie)).status, 404);
});

test('room: a ba card before the first frame keeps frameId null', async (t) => {
  const broker = createMockDesktopBroker(screen);
  broker.failNext('desktop_unavailable');
  const r = await start(t, { broker, vms: [VMS[0]] });
  const cookie = await r.unlock();
  r.director.queue({ acts: [card('early', { ba: true })], ledger: [] });
  r.host.tickOnce();
  const [ev] = (await r.state(cookie)).events;
  assert.equal(ev.act.card.figure.before.frameId, null);
});

// ---- decide ----

async function withCard(t, options = {}) {
  const r = await start(t, options);
  const cookie = await r.unlock();
  r.director.queue({ acts: [card('c1')], ledger: [] });
  r.host.tickOnce();
  return { ...r, cookie };
}

test('decide: guards (cookie, Origin, Sec-Fetch-Site, content type, body) refuse without side effects', async (t) => {
  const r = await withCard(t);
  const body = { cardId: 'c1', choiceId: 'c1-c0' };
  assert.equal((await r.decide(null, body)).status, 401);
  assert.equal((await r.decide(r.cookie, body, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await r.decide(r.cookie, body, { Origin: `http://127.0.0.1:${r.address.port + 1}` })).status, 403);
  assert.equal((await r.decide(r.cookie, body, { 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal((await r.decide(r.cookie, body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await r.decide(r.cookie, body, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await r.decide(r.cookie, body, { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  const noOrigin = await fetch(`${r.address.url}api/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: r.cookie }, body: JSON.stringify(body) });
  assert.equal(noOrigin.status, 403, 'Origin is required on the write route');
  assert.equal((await r.decide(r.cookie, '{not json')).status, 400);
  const large = await r.decide(r.cookie, { ...body, pad: 'x'.repeat(400) }).then((res) => res.status, () => 'closed');
  assert.ok(large === 'closed' || large === 400, `body too large: ${large}`);
  assert.equal((await r.decide(r.cookie, { cardId: '../x', choiceId: 'c1-c0' })).status, 400);
  assert.equal((await r.decide(r.cookie, [body])).status, 400);
  assert.equal((await r.get('api/decide', r.cookie)).status, 405);
  assert.deepEqual(r.fleet.calls, []);
  assert.deepEqual(r.director.calls.decide, []);
  assert.equal(r.journal.entries.filter((e) => e.code === 'human_choice').length, 0);
});

test('decide: an unknown card or choice fails without side effects', async (t) => {
  const r = await withCard(t);
  assert.equal((await r.decide(r.cookie, { cardId: 'nope', choiceId: 'c1-c0' })).status, 404);
  const res = await r.decide(r.cookie, { cardId: 'c1', choiceId: 'c1-c9' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'choice_unknown');
  assert.deepEqual(r.fleet.calls, []);
  assert.equal(r.journal.entries.length, 0);
});

test('decide: stop runs fleet.stopVm once; a second choice on the same card is refused', async (t) => {
  const r = await withCard(t, { fleet: fakeFleet({ busy: new Set(['vm-a']) }) });
  const res = await r.decide(r.cookie, { cardId: 'c1', choiceId: 'c1-c0' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, effect: 'stop', result: 'stopped' });
  assert.deepEqual(r.fleet.calls, [['stopVm', 'vm-a']]);
  const twice = await r.decide(r.cookie, { cardId: 'c1', choiceId: 'c1-c1' });
  assert.equal(twice.status, 409);
  assert.equal((await twice.json()).error, 'card_closed');
  assert.deepEqual(r.fleet.calls, [['stopVm', 'vm-a']]);
  const choice = r.journal.entries.filter((e) => e.code === 'human_choice');
  assert.equal(choice.length, 1);
  assert.deepEqual([choice[0].actor, choice[0].vmId, choice[0].params], ['human', 'vm-a', { cardCode: 'stalled', choiceCode: 'pick_stop', effect: 'stop' }]);
  r.host.tickOnce();
  const kinds = (await r.state(r.cookie)).events.map((e) => (e.kind === 'ledger' ? e.entry.code : e.kind));
  assert.deepEqual(kinds, ['bero', 'card_closed', 'human_choice']);
});

test('decide: nudge starts the fixed task; extra text in the body never reaches a task', async (t) => {
  const r = await withCard(t, { fleet: fakeFleet({ busy: new Set(['vm-a']) }) });
  const res = await r.decide(r.cookie, { cardId: 'c1', choiceId: 'c1-c1', task: 'format C:', effect: 'stop', vmId: 'vm-b' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, effect: 'nudge', result: 'started' });
  assert.deepEqual(r.fleet.calls, [['stopVm', 'vm-a'], ['startJob', 'vm-a', NUDGE_TASK]]);
  assert.ok(!JSON.stringify(r.fleet.calls).includes('format C:'));
});

test('decide: recheck asks about the VM\'s original task; a VM with no task does not start', async (t) => {
  const r = await start(t);
  const cookie = await r.unlock();
  r.director.queue({ acts: [card('ra', { vmId: 'vm-a' }), card('rb', { vmId: 'vm-b' })], ledger: [] });
  r.host.tickOnce();
  assert.deepEqual(await (await r.decide(cookie, { cardId: 'ra', choiceId: 'ra-c2' })).json(), { ok: true, effect: 'recheck', result: 'started' });
  assert.deepEqual(r.fleet.calls, [['stopVm', 'vm-a'], ['startJob', 'vm-a', recheckTask('open notepad and write hello')]]);
  assert.match(recheckTask('open notepad and write hello'), /^Do not change anything.*"open notepad and write hello"/);
  assert.deepEqual(await (await r.decide(cookie, { cardId: 'rb', choiceId: 'rb-c2' })).json(), { ok: true, effect: 'recheck', result: 'no_task' });
  assert.equal(r.fleet.calls.length, 2);
});

test('decide: accept and dismiss run nothing; a refused startJob is reported by code', async (t) => {
  const r = await start(t, { fleet: { ...fakeFleet(), startJob: () => ({ ok: false, code: 'over_budget' }) } });
  const cookie = await r.unlock();
  r.director.queue({ acts: [card('a1', { effects: ['accept', 'dismiss'] }), card('a2', { effects: ['nudge'] })], ledger: [] });
  r.host.tickOnce();
  assert.deepEqual(await (await r.decide(cookie, { cardId: 'a1', choiceId: 'a1-c0' })).json(), { ok: true, effect: 'accept', result: 'none' });
  assert.deepEqual(r.fleet.calls, []);
  assert.deepEqual(await (await r.decide(cookie, { cardId: 'a2', choiceId: 'a2-c0' })).json(), { ok: true, effect: 'nudge', result: 'over_budget' });
});

test('decide: a card the director refuses is not run, and a card for an unknown VM is never shown', async (t) => {
  const director = fakeDirector();
  const r = await start(t, { director: { ...director, tick: director.tick, decide: () => ({ ok: false, code: 'card_closed' }) } });
  const cookie = await r.unlock();
  director.queue({ acts: [card('d1'), card('d2', { vmId: 'vm-zzz' })], ledger: [] });
  r.host.tickOnce();
  const shown = (await r.state(cookie)).events.map((e) => e.act.card.cardId);
  assert.deepEqual(shown, ['d1']);
  const res = await r.decide(cookie, { cardId: 'd1', choiceId: 'd1-c0' });
  assert.equal(res.status, 409);
  assert.equal((await r.decide(cookie, { cardId: 'd2', choiceId: 'd2-c0' })).status, 404);
  assert.deepEqual(r.fleet.calls, []);
});

// ---- cam helpers (pure parts of room-ui/cam.mjs) ----

test('cam: the cursor is scaled to an object-fit: contain image', () => {
  assert.deepEqual(cursorSpot([0, 0], { w: 100, h: 50 }, { w: 200, h: 200 }), { left: 0, top: 25 });
  assert.deepEqual(cursorSpot([100, 50], { w: 100, h: 50 }, { w: 200, h: 200 }), { left: 100, top: 75 });
  assert.equal(cursorSpot(null, { w: 1, h: 1 }, { w: 1, h: 1 }), null);
  assert.equal(cursorSpot([1, 1], { w: 0, h: 0 }, { w: 1, h: 1 }), null);
});

test('cam: a finished run is a claim (never a pass); words exist in en and ja', () => {
  const t = (code, params = {}) => `${code}${JSON.stringify(params)}`;
  assert.deepEqual(bandText({ state: 'done', outcome: 'claimed_done', claim: 'DONE: ok' }, t), { text: 'cam.claim{"claim":"DONE: ok"}', claim: true });
  assert.equal(bandText({ state: 'done', outcome: 'limit_reached' }, t).claim, true);
  assert.match(bandText({ state: 'running', step: 3, lastAction: 'left_click', usd: 0.0123 }, t).text, /"usd":"0.012"/);
  assert.equal(camTone({ status: 'live', agent: { state: 'running' } }), 'work');
  assert.equal(camTone({ status: 'live', agent: { state: 'done', outcome: 'claimed_done' } }), 'wait');
  assert.equal(camTone({ status: 'error', agent: null }), 'stuck');
  assert.match(WORDS_CAM.en['cam.claim'], /self-reported, check the VM/);
  assert.deepEqual(Object.keys(WORDS_CAM.ja).sort(), Object.keys(WORDS_CAM.en).sort());
});

// ---- entry and demo ----

test('room args: --demo, --job and the fleet limits', () => {
  assert.deepEqual(parseRuntimeArgs(['room', '--demo']), { command: 'room', demo: true, jobs: [], port: 0, help: false });
  assert.equal(parseRuntimeArgs(['room', '--demo', '--port', '8090']).port, 8090);
  const o = parseRuntimeArgs(['room', '--job', 'vm-a=open notepad', '--max-usd-total', '1', '--port', '0']);
  assert.deepEqual([o.command, o.demo, o.jobs[0].task, o.maxUsdTotal, o.maxUsdPerVm], ['room', false, 'open notepad', 1, 0.5]);
  const bad = (args, re) => assert.throws(() => parseRuntimeArgs(['room', ...args]), re, args.join(' '));
  bad([], /runtime_fleet_job_required/);
  bad(['--demo', '--job', 'vm-a=t'], /runtime_room_demo_takes_no_jobs/);
  bad(['--demo', '--demo'], /runtime_option_must_be_unique/);
  bad(['--demo', '--max-usd-total', '1'], /invalid_runtime_option/);
  bad(['--demo', '--port', '99999'], /runtime_port_invalid/);
  assert.ok(RUNTIME_HELP.includes('albera-runtime room --demo'));
});

test('demo: missing parts are named; the scripts click, stall behind a dialog and claim DONE', async () => {
  assert.deepEqual(missingRoomParts({}), ['room-journal (part C)', 'room-figures (part C)', 'bero-director (part D)']);
  await assert.rejects(startRoomDemo({ modules: {} }), (error) => error.code === 'room_parts_missing' && error.missing.length === 3);
  assert.equal(demoStep('clicker', 500).content[1].name, 'left_click');
  assert.equal(typeof demoStep('staller', 3), 'symbol');
  assert.match(demoStep('finisher', 4).content[0].text, /^DONE/);
  const broker = createDemoBroker();
  const png = await broker.captureVmScreen({ vmId: 'x' });
  assert.equal(png.readUInt32BE(16), DEMO_SCREEN.width);
  broker.openDialog('x');
  await broker.sendVmInput({ vmId: 'x', action: { action: 'left_click', coordinate: [400, 285] } });
  assert.equal(broker.hasDialog('x'), false);
  assert.equal(DEMO_VMS.length, 3);
});

test('demo: the room runs end to end with fake C/D parts and no network', async (t) => {
  const director = fakeDirector();
  const modules = {
    journalModule: { createRoomJournal: ({ now }) => fakeJournal(now) },
    figuresModule: { buildFigure: () => null },
    directorModule: { createBeroDirector: () => director },
  };
  const demo = await startRoomDemo({ modules, delayMs: 5 });
  t.after(() => demo.close());
  for (let i = 0; i < 400 && !demo.broker.hasDialog('demo-tests'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(demo.broker.hasDialog('demo-tests'), true, 'the staller opened its dialog');
  for (let i = 0; i < 400 && demo.fleet.isBusy('demo-form'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  demo.host.tickOnce();
  const codes = director.calls.tick.flatMap((c) => c.entries.map((e) => `${e.vmId}:${e.code}`));
  assert.ok(codes.includes('demo-photos:hands_started'));
  assert.ok(codes.includes('demo-form:hands_step'));
  assert.equal(demo.fleet.isBusy('demo-photos'), true, 'the clicker keeps going');
  assert.equal(demo.fleet.isBusy('demo-tests'), true, 'the staller is still running, not acting');
  assert.equal(demo.fleet.isBusy('demo-form'), false, 'the finisher ended');
  // a nudge from a card closes the dialog
  director.queue({ acts: [card('n1', { vmId: 'demo-tests', effects: ['nudge'] })], ledger: [] });
  demo.host.tickOnce();
  const origin = new URL(demo.url).origin;
  const session = await fetch(`${demo.url}api/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrapCode: demo.bootstrapCode }) });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${demo.url}api/decide`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ cardId: 'n1', choiceId: 'n1-c0' }) });
  assert.deepEqual(await res.json(), { ok: true, effect: 'nudge', result: 'started' });
  for (let i = 0; i < 400 && demo.broker.hasDialog('demo-tests'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(demo.broker.hasDialog('demo-tests'), false, 'the nudge job pressed OK');
});

test('room: two hosts on 127.0.0.1 use different cookie names, so one never replaces the other\'s session', async (t) => {
  const a = await start(t);
  const b = await start(t);
  assert.notEqual(a.host.cookieName, b.host.cookieName);
  const cookieA = await a.unlock();
  const cookieB = await b.unlock();
  // A browser sends every 127.0.0.1 cookie for /room/ to both ports.
  const both = `${cookieB}; ${cookieA}`;
  assert.equal((await a.get('api/state', both)).status, 200);
  assert.equal((await b.get('api/state', both)).status, 200);
});

test('room: a stale or malformed cookie of the same name does not hide a valid one', async (t) => {
  const r = await start(t);
  const cookie = await r.unlock();
  const name = r.host.cookieName;
  for (const header of [`${name}=bad!; ${cookie}`, `${name}=${'A'.repeat(43)}; ${cookie}`, `${cookie}; ${name}=bad!`]) {
    assert.equal((await r.get('api/state', header)).status, 200, header.slice(0, 40));
  }
});

test('room: a session in use stays valid past the idle limit; an idle one expires', async (t) => {
  const r = await start(t);
  const cookie = await r.unlock();
  for (let i = 0; i < 30; i++) {
    r.clock.t += 60_000;
    assert.equal((await r.get('api/state', cookie)).status, 200, `minute ${i + 1}`);
  }
  r.clock.t += 20 * 60_000 + 1;
  assert.equal((await r.get('api/state', cookie)).status, 401);
});
