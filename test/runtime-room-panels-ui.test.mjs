// The credential panel and the job panel in room-ui (settings.mjs, jobs.mjs): the parts that are plain functions, the words, the calls api.mjs makes, and that the host serves the files.
// The DOM part is not run here (there is no browser in the test run); the source guards below pin the two rules it must keep.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as api from '../src/runtime/room-ui/api.mjs';
import { JOBS_POLL_MS, TASK_MAX_BYTES, codeOf, jobLine, requestFlow, resultLine, targetLabel, taskBytes, taskProblem } from '../src/runtime/room-ui/jobs.mjs';
import { CREDENTIAL_KINDS, clearClipboard, isAcceptableValue, saveFlow, savedLine, tidyValue } from '../src/runtime/room-ui/settings.mjs';
import panelWords from '../src/runtime/room-ui/words-panels.mjs';
import { makeWords } from '../src/runtime/room-ui/i18n.mjs';
import { startRouteHost } from './helpers/room-route-host.mjs';

const words = makeWords(panelWords);
const source = (name) => fs.readFileSync(new URL(`../src/runtime/room-ui/${name}`, import.meta.url), 'utf8');
const TOKEN = 'sk-ant-oat01-FAKE-0123456789';

// ---- calls ----

test('api.mjs: the new calls use relative paths and post exactly the documented bodies', async (t) => {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({ url, init }); return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  t.after(() => { globalThis.fetch = real; });
  await api.getCredentials();
  await api.saveCredential('claude-oauth-token', TOKEN);
  await api.eraseCredential('anthropic-api-key');
  await api.getJobs();
  await api.startJob('pc-01', 'do it');
  await api.stopAllJobs();
  await api.approvalTest();
  assert.deepEqual(seen.map((s) => [s.init.method ?? 'GET', s.url, s.init.body ?? null]), [
    ['GET', 'api/settings/credentials', null],
    ['POST', 'api/settings/credential', JSON.stringify({ name: 'claude-oauth-token', value: TOKEN })],
    ['POST', 'api/settings/credential/erase', JSON.stringify({ name: 'anthropic-api-key' })],
    ['GET', 'api/jobs', null],
    ['POST', 'api/jobs', JSON.stringify({ computerId: 'pc-01', task: 'do it' })],
    ['POST', 'api/jobs/stop-all', '{}'],
    ['POST', 'api/jobs/approval-test', '{}'],
  ]);
  assert.ok(seen.every((s) => s.init.credentials === 'same-origin' && s.init.cache === 'no-store'));
  assert.ok(seen.slice(1).filter((s) => s.init.method === 'POST').every((s) => s.init.headers['Content-Type'] === 'application/json'));
  assert.ok(!seen.some((s) => s.url.includes(TOKEN) || s.url.includes('?')), 'no value in an address');
});

// ---- credential panel ----

test('credential value check matches the host: printable ASCII, no whitespace, 1 to 1024', () => {
  for (const ok of [TOKEN, 'a', 'a'.repeat(1024), '!~']) assert.equal(isAcceptableValue(ok), true, ok.slice(0, 8));
  for (const bad of ['', ' ', 'a b', 'a\tb', 'a\nb', 'a'.repeat(1025), '\u3042', 'x\u007f', 5, null, undefined]) assert.equal(isAcceptableValue(bad), false, String(bad));
  assert.deepEqual(CREDENTIAL_KINDS.map((k) => k.name), ['claude-oauth-token', 'anthropic-api-key']);
});

test('savedLine shows only the hash prefix and the date, or that nothing is saved', () => {
  assert.equal(savedLine(words, { present: false }), words.t('panel.settings.not_saved'));
  assert.equal(savedLine(words, undefined), words.t('panel.settings.not_saved'));
  const line = savedLine(words, { present: true, sha256Prefix: 'a1b2c3d4', savedAt: '2026-11-03T09:00:00.000Z' });
  assert.match(line, /a1b2c3d4/);
  assert.match(line, /2026-11-03T09:00:00\.000Z/);
  assert.equal(savedLine(words, { present: true, sha256Prefix: null, savedAt: null }), words.t('panel.settings.saved_unknown'));
});

test('clearClipboard: true when the browser accepted it, false when it refused or there is none', async () => {
  const written = [];
  assert.equal(await clearClipboard({ writeText: async (text) => { written.push(text); } }), true);
  assert.deepEqual(written, ['']);
  assert.equal(await clearClipboard({ writeText: async () => { throw new Error('NotAllowedError'); } }), false);
  assert.equal(await clearClipboard({}), false);
  assert.equal(await clearClipboard(undefined), false);
});

test('saveFlow: the clipboard is emptied only after the host stored the value, and a failure is told, not hidden', async () => {
  const order = [];
  const clipboard = { writeText: async () => { order.push('clipboard'); } };
  const save = (result) => async (name, value) => { order.push(`save:${name}:${value.length}`); return result; };
  const stored = { ok: true, status: 200, body: { ok: true, credential: { name: 'claude-oauth-token', present: true, sha256Prefix: 'a1b2c3d4', savedAt: 'x' } } };

  const done = await saveFlow({ name: 'claude-oauth-token', value: TOKEN, save: save(stored), clipboard });
  assert.deepEqual(order, [`save:claude-oauth-token:${TOKEN.length}`, 'clipboard']);
  assert.deepEqual([done.code, done.clipboardCleared, done.credential.sha256Prefix], ['saved', true, 'a1b2c3d4']);
  assert.ok(!JSON.stringify(done).includes(TOKEN));

  const notCleared = await saveFlow({ name: 'claude-oauth-token', value: TOKEN, save: save(stored), clipboard: { writeText: async () => { throw new Error('no'); } } });
  assert.deepEqual([notCleared.code, notCleared.clipboardCleared], ['saved', false]);

  order.length = 0;
  for (const [result, code] of [
    [{ ok: false, status: 401, body: null }, 'locked'], [{ ok: false, status: 0, body: null }, 'unreachable'],
    [{ ok: false, status: 503, body: { error: 'store_unavailable' } }, 'store_unavailable'], [{ ok: false, status: 500, body: null }, 'save_failed'],
  ]) {
    const failed = await saveFlow({ name: 'claude-oauth-token', value: TOKEN, save: save(result), clipboard });
    assert.equal(failed.code, code);
  }
  assert.ok(!order.includes('clipboard'), 'a value that was not stored leaves the clipboard alone');

  order.length = 0;
  for (const value of ['', 'has space', undefined, ' \r\n \n']) assert.notEqual((await saveFlow({ name: 'claude-oauth-token', value, save: save(stored), clipboard })).code, 'saved');
  assert.deepEqual(order, [], 'a value the host would refuse is not sent');
  assert.equal((await saveFlow({ name: 'claude-oauth-token', value: ' \r\n ', save: save(stored), clipboard })).code, 'empty', 'only spaces and line breaks is no value');
});

test('saveFlow sends the token without what a terminal copy adds (owner run 2026-11-04: an indented token was refused while the field emptied)', async () => {
  const sent = [];
  const save = async (name, value) => { sent.push(value); return { ok: true, status: 200, body: { ok: true, credential: { present: true } } }; };
  const half = TOKEN.slice(0, 14);
  for (const copied of [`  ${TOKEN}`, `${TOKEN}\r\n`, `\t${TOKEN} `, `${half}\r\n${TOKEN.slice(14)}`, `  ${half}  \n  ${TOKEN.slice(14)}\n`]) {
    assert.equal((await saveFlow({ name: 'claude-oauth-token', value: copied, save, clipboard: undefined })).code, 'saved', JSON.stringify(copied.replace(TOKEN.slice(4), '…')));
  }
  assert.deepEqual(sent, Array(5).fill(TOKEN), 'the host gets the token itself, every time');
  for (const inside of [`${half} ${TOKEN.slice(14)}`, `${half}　${TOKEN.slice(14)}`]) assert.equal(tidyValue(inside), inside, 'a space inside a line is kept, so the host refuses it');
  assert.equal(tidyValue(undefined), undefined);
});

test('settings.mjs source: a refused save is marked and announced, and the saved line is read again either way', () => {
  const text = source('settings.mjs');
  assert.match(text, /note\.classList\.toggle\('bad', !saved\)/);
  assert.match(text, /setAttribute\('role', saved \? 'status' : 'alert'\)/);
  for (const key of ['panel.settings.invalid_value', 'panel.settings.empty', 'panel.settings.failed']) {
    assert.match(panelWords.ja[key], /^保存されていません/u, key);
    assert.match(panelWords.en[key], /^Not saved/u, key);
  }
});

test('settings.mjs source: the field is a password field, is emptied before the call, and nothing is put in an address, storage or the log', () => {
  const text = source('settings.mjs');
  assert.match(text, /input\.type = 'password'/);
  assert.match(text, /autocomplete = 'new-password'/);
  const read = text.indexOf('const value = input.value;');
  const empty = text.indexOf("input.value = '';", read);
  const call = text.indexOf('await saveFlow(', read);
  assert.ok(read > 0 && empty > read && call > empty, 'the value is read, the field emptied, and only then the call made');
  for (const forbidden of [/localStorage/, /sessionStorage/, /console\./, /location\./, /document\.cookie/, /\.innerHTML/]) assert.doesNotMatch(text, forbidden);
});

// ---- job panel ----

test('taskProblem: the same limits as the gate, with a reason that can be shown', () => {
  assert.equal(TASK_MAX_BYTES, 256);
  assert.equal(taskProblem('Open Notepad'), null);
  assert.equal(taskProblem('x'.repeat(256)), null);
  assert.equal(taskProblem('x'.repeat(257)), 'panel.jobs.task_too_long');
  assert.equal(taskProblem('\u3042'.repeat(85)), null); // 255 bytes
  assert.equal(taskProblem('\u3042'.repeat(86)), 'panel.jobs.task_too_long'); // 258 bytes
  for (const bad of ['a\nb', 'a\u0000b', 'a\u202eb', 'a\u200fb', 'a\u2028b', '\ud800']) assert.equal(taskProblem(bad), 'panel.jobs.task_unsafe', JSON.stringify(bad));
  for (const empty of ['', undefined, null, 5]) assert.equal(taskProblem(empty), 'panel.jobs.task_empty');
  assert.equal(taskBytes('\u3042a'), 4);
});

test('jobLine: what it is and where it stands, with the host code when there is one', () => {
  assert.equal(jobLine(words, { kind: 'task', task: 'Open Notepad', state: 'awaiting_approval' }), `Open Notepad \u2014 ${words.t('panel.jobs.state_awaiting_approval')}`);
  assert.match(jobLine(words, { kind: 'task', task: 'Open Notepad', computerId: 'pc-02', state: 'starting' }), /^Open Notepad \[pc-02\] /);
  assert.match(jobLine(words, { kind: 'test', state: 'approved' }), new RegExp(words.t('panel.jobs.kind_test')));
  assert.match(jobLine(words, { kind: 'task', task: 'x', state: 'refused', code: 'start_denied' }), /\(start_denied\)$/);
});

test('requestFlow: a task the host would refuse is not sent; the host answers become short codes', async () => {
  const calls = [];
  const start = (result) => async (computerId, task) => { calls.push([computerId, task]); return result; };
  const job = { jobId: 'job-1', matchCode: '1234', state: 'awaiting_approval' };
  assert.deepEqual(await requestFlow({ computerId: 'pc-01', task: 'ok', start: start({ ok: true, status: 202, body: { ok: true, job } }) }), { code: 'requested', job });
  assert.deepEqual(calls, [['pc-01', 'ok']]);
  calls.length = 0;
  assert.equal((await requestFlow({ computerId: 'pc-01', task: '', start: start({}) })).code, 'panel.jobs.task_empty');
  assert.equal((await requestFlow({ computerId: 'pc-01', task: 'a\nb', start: start({}) })).code, 'panel.jobs.task_unsafe');
  assert.deepEqual(calls, []);
  for (const [result, code] of [[{ ok: false, status: 401, body: null }, 'locked'], [{ ok: false, status: 0, body: null }, 'unreachable'],
    [{ ok: false, status: 409, body: { error: 'approval_in_progress' } }, 'approval_in_progress'], [{ ok: true, status: 200, body: {} }, 'request_failed']]) {
    assert.equal((await requestFlow({ computerId: 'pc-01', task: 'ok', start: start(result) })).code, code);
  }
  assert.ok(JOBS_POLL_MS >= 1000);
});

test('codeOf: only a job still waiting for approval has a code to press', () => {
  assert.equal(codeOf({ state: 'awaiting_approval', matchCode: '0042' }), '0042');
  for (const job of [{ state: 'submitting' }, { state: 'started', matchCode: '0042' }, { state: 'awaiting_approval', matchCode: '42' }, { state: 'awaiting_approval' }, null]) assert.equal(codeOf(job), null);
});

test('jobs.mjs source: match code in a large element, the buttons the owner asked for, and no HTML injection', () => {
  const text = source('jobs.mjs');
  for (const id of ['panel.jobs.request', 'panel.jobs.stop_all', 'panel.jobs.test', 'panel.jobs.match_title']) assert.ok(text.includes(`'${id}'`), id);
  assert.match(text, /el\(document, 'p', 'match-code', code\)/);
  assert.match(text, /jobs\.map\(\(job\) => jobItem\(job\)\)|map\(\(job\) => jobItem\(job\)\)/, 'each job in the list builds its own code');
  assert.doesNotMatch(text, /showCode|matchBox/, 'there is no single shared code box');
  assert.match(source('panels.css'), /\.match-code \{[^}]*font-size: 56px/);
  assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

// ---- words and serving ----

test('words: en and ja have the same keys, and every panel.* key the two scripts use exists', () => {
  assert.deepEqual(Object.keys(panelWords.en).sort(), Object.keys(panelWords.ja).sort());
  const used = new Set();
  for (const name of ['settings.mjs', 'jobs.mjs']) for (const m of source(name).matchAll(/'(panel\.[a-z_.]+)'/g)) used.add(m[1]);
  for (const key of ['notes']) used.delete(key);
  for (const key of ['how', 'write_only', 'unchecked', 'revoke', 'clipboard', 'no_browser_save']) used.add(`panel.settings.${key}`); // built as `panel.settings.${key}` in settings.mjs
  for (const state of ['submitting', 'awaiting_approval', 'starting', 'started', 'approved', 'refused', 'start_failed', 'cancelled']) used.add(`panel.jobs.state_${state}`); // built from the job's state
  for (const key of used) assert.ok(Object.hasOwn(panelWords.en, key), `missing in en: ${key}`);
  for (const text of Object.values(panelWords.en)) assert.ok(!/<[a-z]/i.test(text), 'no markup in words');
  assert.match(panelWords.en['panel.settings.how'], /claude setup-token/);
  assert.match(panelWords.ja['panel.settings.how'], /claude setup-token/);
  assert.match(panelWords.ja['panel.settings.revoke'], /Anthropic/);
});

test('the host serves the panel scripts, words and styles (and the page links them)', async (t) => {
  const r = await startRouteHost(t, []);
  for (const [name, type] of [['settings.mjs', 'text/javascript'], ['jobs.mjs', 'text/javascript'], ['words-panels.mjs', 'text/javascript'], ['panels.css', 'text/css']]) {
    const res = await fetch(`${r.address.url}${name}`);
    assert.equal(res.status, 200, name);
    assert.match(res.headers.get('content-type'), new RegExp(type));
    assert.equal(await res.text(), source(name));
  }
  const page = await (await fetch(r.address.url)).text();
  for (const needle of ['panels.css', 'settings.mjs', 'jobs.mjs', 'id="open-settings"', 'id="open-jobs"', 'id="settings-panel"', 'id="jobs-panel"']) assert.ok(page.includes(needle), needle);
});

test('a WSL2 computer says its level, and a result line holds fixed words and hex only', () => {
  assert.match(targetLabel(words, { label: 'pc-wsl', level: 'wsl2' }), /^pc-wsl \u2014 .*WSL2/u);
  assert.equal(targetLabel(words, { label: 'vm-1' }), 'vm-1');
  const oid = 'a'.repeat(40);
  assert.match(resultLine(words, { ok: true, baseOid: 'b'.repeat(40), resultOid: oid, files: [{}, {}], fileCount: 10000 }), /aaaaaaaaaaaa.*10000/u);
  assert.ok(!resultLine(words, { ok: true, baseOid: oid, resultOid: oid, files: [] }).includes('aaaa'), 'no change');
  assert.match(resultLine(words, { ok: false, code: 'symlink' }), /symlink/u);
});
