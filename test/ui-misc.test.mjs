import assert from 'node:assert/strict';
import { test } from 'node:test';
import { faviconHref, faviconKind } from '../public/favicon.mjs';
import { canvasSwitchVisible, ledeState } from '../public/front.mjs';
import { makeT } from '../public/i18n.mjs';
import { arrivals, notificationsFor } from '../public/notify.mjs';

const en = makeT('en');
const ja = makeT('ja');
/** @param {string} id @param {Record<string, any>} [o] */
const c = (id, o = {}) => ({ id, title: id, body: '', ...o });

test('faviconKind: 返事待ち > 止まったかも > なし', () => {
  assert.equal(faviconKind({ needs_you: 2, trouble: 1 }), 'needs');
  assert.equal(faviconKind({ needs_you: 0, trouble: 1 }), 'stuck');
  assert.equal(faviconKind({ needs_you: 0, trouble: 0, unread: 3 }), 'none');
  assert.equal(faviconKind(null), 'none');
});

test('faviconHref: 青 (accent) は needs のときだけ。数字は入れない', () => {
  const accent = encodeURIComponent('#2e54ae');
  assert.ok(faviconHref('needs').includes(accent));
  assert.ok(!faviconHref('stuck').includes(accent));
  assert.ok(!faviconHref('none').includes(accent));
  assert.ok(faviconHref('none').startsWith('data:image/svg+xml,'));
  assert.notEqual(faviconHref('stuck'), faviconHref('none'));
  assert.ok(!/%3Ctext/.test(faviconHref('needs')));
});

test('arrivals: 最初の盤面では空。未読は対象外。新しく来た返事待ちと止まったかもだけ', () => {
  const b1 = { buckets: { needs_you: [c('a')], trouble: [], unread: [c('u')] } };
  const b2 = { buckets: { needs_you: [c('a'), c('b')], trouble: [c('t')], unread: [c('u'), c('v')] } };
  assert.deepEqual(arrivals(null, b1), []);
  assert.deepEqual(arrivals(b1, b2).map((x) => [x.pile, x.card.id]), [['needs_you', 'b'], ['trouble', 't']]);
  assert.deepEqual(arrivals(b2, b2), []);
});

test('notificationsFor: 1〜2 件は 1 件ずつ (質問か理由を本文に)、3 件以上は 1 つにまとめる', () => {
  const one = notificationsFor(en, [{ pile: 'needs_you', card: c('a', { title: 'Pick a colour', body: 'Blue or green?' }) }]);
  assert.deepEqual(one, [{ title: 'Needs you: Pick a colour', body: 'Blue or green?', tag: 'a', id: 'a' }]);
  const plan = notificationsFor(ja, [{ pile: 'needs_you', card: c('p', { title: '', reasonParams: { ask: 'plan' } }) }]);
  assert.equal(plan[0].title, '返事待ち: (無題)');
  assert.equal(plan[0].body, 'プランを確認して、進めてよいか答えてください');
  const stuck = notificationsFor(en, [{ pile: 'trouble', card: c('t', { reason: 'not_started' }) }]);
  assert.deepEqual([stuck[0].title, stuck[0].body], ['Stuck?: t', 'It never started.']);
  const many = notificationsFor(en, ['a', 'b', 'c'].map((id) => ({ pile: 'needs_you', card: c(id) })));
  assert.equal(many.length, 1);
  assert.equal(many[0].title, '3 sessions need you or may be stuck');
  assert.equal(notificationsFor(ja, ['a', 'b', 'c'].map((id) => ({ pile: 'trouble', card: c(id) })))[0].title, '返事待ち・止まったかもが 3 件', '止まったかもも名前で数える');
});

test('ledeState: 読み込み中・繋がらない・サーバー・版・空・返事・確認・未読・静か', () => {
  const b = (/** @type {Record<string, any>} */ counts, /** @type {Record<string, any[]>} */ buckets = {}) => ({ counts: { active: 5, ...counts }, buckets: { needs_you: [], trouble: [], unread: [], working: [], ...buckets } });
  assert.equal(ledeState({ board: null, loading: true, fail: null }), 'loading');
  assert.equal(ledeState({ board: null, loading: true, fail: 'offline' }), 'offline');
  assert.equal(ledeState({ board: null, loading: false, fail: 'server' }), 'server');
  assert.equal(ledeState({ board: null, loading: false, fail: 'version' }), 'version');
  assert.equal(ledeState({ board: b({ active: 0 }), loading: false, fail: null }), 'empty');
  assert.equal(ledeState({ board: b({}, { needs_you: [c('a')], trouble: [c('t')] }), loading: false, fail: null }), 'busy');
  assert.equal(ledeState({ board: b({}, { trouble: [c('t')], unread: [c('u')] }), loading: false, fail: 'offline' }), 'stuck', 'データがあれば繋がらなくても中身のまま');
  assert.equal(ledeState({ board: b({}, { unread: [c('u')] }), loading: false, fail: null }), 'unread');
  assert.equal(ledeState({ board: b({}, { working: [c('w')] }), loading: false, fail: null }), 'quiet');
});

test('canvasSwitchVisible: active件数やboard取得の状態に依存せず、対応viewでは切替を表示する', () => {
  assert.equal(canvasSwitchVisible('list'), true, '空一覧・読み込み中・errorでもキャンバスへ入れる');
  assert.equal(canvasSwitchVisible('canvas'), true, 'キャンバスから一覧へ戻れる');
  assert.equal(canvasSwitchVisible('unknown'), false, '未対応viewは出さない');
});
