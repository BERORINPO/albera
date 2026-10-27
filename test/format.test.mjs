import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY, HOUR, MIN, QUIET_HINT_MS, SEC } from '../src/shared/constants.mjs';
import {
  absoluteTime, agoText, agoWords, archiveInstruction, askText, asOfText, cardTime, childrenText, cleanupGroupName, contentLang, contextMeta, contextValueText,
  createdText, dateline, deepLink, doingMainSpec, doingSpec, doingText, durationText, ledeTimeLine, matches, parseResetTime, prLabel, projectLabel, quietHint,
  reasonLine, routineFlaky, routineHistory, shortDoing, tabTitle, timeText, tokensText, waitWordsKey,
} from '../public/format.mjs';
import { makeT } from '../public/i18n.mjs';

const en = makeT('en');
const ja = makeT('ja');
const NOW = new Date(2026, 9, 18, 14, 52).getTime();
const card = (/** @type {Record<string, any>} */ o) => ({ id: 'local_00000000-0000-4000-8000-000000000001', bucket: 'trouble', title: 'Demo', body: '', project: { key: 'demo-app', label: 'demo-app', extra: 0 }, ...o });

test('durationText: 1 分未満は空、分・時間・日に切り捨て。短い単位と長い単位、n = 0 / 1 / 2', () => {
  assert.equal(durationText(en, 0), '');
  assert.equal(durationText(en, 59 * SEC), '');
  assert.equal(durationText(en, MIN), '1 min');
  assert.equal(durationText(en, MIN, 'long'), '1 minute');
  assert.equal(durationText(en, 2 * MIN, 'long'), '2 minutes');
  assert.equal(durationText(en, HOUR + 59 * MIN), '1 h');
  assert.equal(durationText(en, 2 * HOUR, 'long'), '2 hours');
  assert.equal(durationText(en, DAY), '1 day');
  assert.equal(durationText(en, 2 * DAY + HOUR), '2 days');
  assert.equal(durationText(en, DAY, 'long'), '1 day');
  assert.equal(durationText(ja, 0), '');
  assert.equal(durationText(ja, MIN), '1 分');
  assert.equal(durationText(ja, 2 * HOUR, 'long'), '2 時間');
  assert.equal(durationText(ja, 35 * DAY), '35 日');
  assert.equal(durationText(en, -5 * MIN), '', '未来はたった今扱い');
});

test('agoText: 1 分未満は秒で数える (古い内容の知らせ用)', () => {
  assert.equal(agoText(en, 40 * SEC), '40 s ago');
  assert.equal(agoText(ja, 40 * SEC), '40 秒前');
  assert.equal(agoText(en, 3 * MIN), '3 min ago');
  assert.equal(agoText(ja, 3 * MIN), '3 分前');
});

test('timeText: 全部の種類と、それぞれの「たった今」の形 (en / ja)', () => {
  /** @type {Array<[string, number, string, string, string, string]>} */
  const cases = [
    ['waiting', 2 * HOUR, 'waiting 2 h', '2 時間待ち', 'waiting <1 min', 'たった今から待ち'],
    ['stopped', 40 * MIN, 'stopped 40 min ago', '40 分前に停止', 'stopped just now', 'たった今停止'],
    ['stalled', 3 * HOUR, 'quiet 3 h', '3 時間動きなし', 'quiet <1 min', 'たった今から動きなし'],
    ['ended', 12 * MIN, 'done 12 min ago', '12 分前に終了', 'done just now', 'たった今終了'],
    ['updated', MIN, 'updated 1 min ago', '1 分前に更新', 'updated just now', 'たった今更新'],
    ['running', 23 * MIN, '23 min running', '23 分経過', 'just started', 'たった今開始'],
    ['latest', DAY, 'latest run 1 day ago', '最新回 1 日前', 'latest run just now', '最新回 たった今'],
    ['moved', 35 * DAY, 'last active 35 days ago', '最後に動いたのは 35 日前', 'last active just now', '最後に動いたのはたった今'],
    ['ago', 9 * DAY, 'active 9 days ago', '9 日前に更新', 'active just now', 'たった今更新'],
  ];
  for (const [kind, d, e, j, en0, ja0] of cases) {
    assert.equal(timeText(en, kind, NOW - d, NOW), e, kind);
    assert.equal(timeText(ja, kind, NOW - d, NOW), j, kind);
    assert.equal(timeText(en, kind, NOW - 10 * SEC, NOW), en0, `${kind}_now`);
    assert.equal(timeText(ja, kind, NOW - 10 * SEC, NOW), ja0, `${kind}_now`);
  }
  assert.equal(timeText(en, 'nope', NOW - 2 * DAY, NOW), 'active 2 days ago', '知らない種類は ago');
  assert.equal(timeText(ja, 'waiting', NOW + MIN, NOW), 'たった今から待ち', '未来はたった今');
});

test('cardTime: 作業中で startedAt があれば経過、無ければ更新の時刻', () => {
  assert.deepEqual(cardTime({ bucket: 'working', startedAt: 5, since: 9, timeKind: 'updated' }), { kind: 'running', since: 5 });
  assert.deepEqual(cardTime({ bucket: 'working', since: 9, timeKind: 'updated' }), { kind: 'updated', since: 9 });
  assert.deepEqual(cardTime({ bucket: 'needs_you', startedAt: 5, since: 9, timeKind: 'waiting' }), { kind: 'waiting', since: 9 });
});

test('ledeTimeLine: 文なので長い単位。1 分未満は _now', () => {
  assert.equal(ledeTimeLine(en, 'needs_you', { since: NOW - 2 * HOUR }, NOW), 'Waiting for 2 hours');
  assert.equal(ledeTimeLine(ja, 'needs_you', { since: NOW - 2 * HOUR }, NOW), '2 時間待っています');
  assert.equal(ledeTimeLine(en, 'needs_you', { since: NOW }, NOW), 'Waiting since just now');
  assert.equal(ledeTimeLine(ja, 'trouble', { since: NOW - 3 * HOUR, timeKind: 'stalled' }, NOW), '3 時間、動きがありません');
  assert.equal(ledeTimeLine(en, 'trouble', { since: NOW - 40 * MIN, timeKind: 'stopped' }, NOW), 'Stopped 40 minutes ago');
  assert.equal(ledeTimeLine(ja, 'unread', { since: NOW - 12 * MIN }, NOW), '12 分前に終わりました');
  assert.equal(ledeTimeLine(en, 'unread', { since: NOW }, NOW), 'Finished just now');
});

test('parseResetTime: 24 時間制の HH:mm。読めないものは null', () => {
  assert.equal(parseResetTime('resets 1:50pm'), '13:50');
  assert.equal(parseResetTime('5-hour limit reached ∙ resets 1:50pm (Asia/Tokyo)'), '13:50');
  assert.equal(parseResetTime('resets at 13:00'), '13:00');
  assert.equal(parseResetTime('resets 9am'), '09:00');
  assert.equal(parseResetTime('resets 12am'), '00:00');
  assert.equal(parseResetTime('resets 12 p.m.'), '12:00');
  assert.equal(parseResetTime('resets soon'), null);
  assert.equal(parseResetTime('resets 5 hours later'), null);
  assert.equal(parseResetTime('resets 25:00'), null);
  assert.equal(parseResetTime(undefined), null);
});

test('reasonLine: 止まったかもの全部の理由 (en / ja)', () => {
  const r = (/** @type {any} */ t, /** @type {string} */ reason, /** @type {any} */ reasonParams) => reasonLine(t, card({ reason, reasonParams }));
  assert.equal(r(en, 'stalled', { via: 'prompt' }), 'No reply to your last message yet.');
  assert.equal(r(ja, 'stalled', { via: 'prompt' }), '送った指示に返事がありません');
  assert.equal(r(en, 'stalled', { via: 'tool' }), 'Stopped during a tool. It may be waiting for permission.');
  assert.equal(r(ja, 'stalled', { via: 'tool' }), 'ツールの途中で止まっています。許可の確認待ちかもしれません');
  assert.equal(r(en, 'git_startup'), "Failed to start (Git isn't working).");
  assert.equal(r(ja, 'git_startup'), '起動に失敗しました (Git が使えない状態)');
  assert.equal(r(en, 'not_started'), 'It never started.');
  assert.equal(r(ja, 'not_started'), '起動しないまま止まっています');
  assert.equal(r(en, 'limit', { reset: 'resets 1:50pm' }), 'Hit the usage limit. The limit resets at 13:50.');
  assert.equal(r(ja, 'limit', { reset: 'resets 1:50pm' }), '使用上限で止まりました。上限は 13:50 に戻ります');
  assert.equal(r(en, 'limit', { reset: 'resets soon' }), 'Hit the usage limit. The app says “resets soon”.');
  assert.equal(r(ja, 'limit', { reset: 'resets soon' }), '使用上限で止まりました。アプリの表示は「resets soon」');
  assert.equal(r(en, 'limit'), 'Hit the usage limit.');
  assert.equal(r(ja, 'limit'), '使用上限で止まりました');
  assert.equal(r(en, 'error', { error: 'API Error: demo' }), 'Stopped by an error: “API Error: demo”');
  assert.equal(r(ja, 'error', { error: 'API Error: demo' }), 'エラーで止まりました: 「API Error: demo」');
});

test('reasonLine: 片付けの理由 (en / ja)', () => {
  const r = (/** @type {any} */ t, /** @type {string} */ reason, /** @type {any} */ reasonParams) => reasonLine(t, card({ bucket: 'cleanup', reason, reasonParams }));
  assert.equal(r(en, 'retried'), 'Started again later with the same task.');
  assert.equal(r(ja, 'retried'), 'あとで同じ内容で起動し直しています');
  assert.equal(r(en, 'routine_old', { older: 3, total: 3 }), 'All 3 runs');
  assert.equal(r(en, 'routine_old', { older: 1, total: 1 }), '1 run');
  assert.equal(r(ja, 'routine_old', { older: 3, total: 3 }), '全 3 回');
  assert.equal(r(en, 'routine_old', { older: 4, total: 5, latestBucket: 'unread' }), '4 older runs (of 5). The latest run is under “Unread”.');
  assert.equal(r(ja, 'routine_old', { older: 4, total: 5, latestBucket: 'unread' }), '古い回 4 件 (全 5 回)。最新回は「未読」にあります');
  assert.equal(r(en, 'routine_old', { older: 1, total: 2 }), '1 older run (of 2)');
  const prs = [{ num: 9, repo: 'o/demo-app', state: 'MERGED' }];
  assert.equal(r(en, 'pr_done', { prs }), 'PR #9 merged');
  assert.equal(r(ja, 'pr_done', { prs }), 'PR #9 マージ済み');
  const two = [{ num: 3, repo: 'o/demo-web', state: 'MERGED' }, { num: 4, repo: 'o/demo-api', state: 'CLOSED' }];
  assert.equal(r(en, 'pr_done', { prs: two, more: 2 }), 'demo-web #3 merged, demo-api #4 closed +2 more');
  assert.equal(r(ja, 'pr_done', { prs: two, more: 2 }), 'demo-web #3 マージ済み、demo-api #4 クローズ済み ほか 2 件');
  assert.equal(r(en, 'old_error', { error: 'boom' }), 'Error: “boom”');
  assert.equal(r(ja, 'old_error', { error: 'boom' }), 'エラー: 「boom」');
  assert.equal(r(en, 'old_error'), '');
  assert.equal(r(en, 'old_question', { question: 'Go on?' }), 'Question: “Go on?”');
  assert.equal(r(ja, 'old_question', { question: '進めますか?' }), '質問: 「進めますか?」');
  assert.equal(r(ja, 'old_question'), '');
  for (const reason of ['asks', 'asking', 'unread', 'turn', 'recent', 'idle_30d', 'idle_7d', 'background', 'starting']) assert.equal(r(en, reason), '', reason);
});

test('askText: 質問文の無い返事待ち (ExitPlanMode と AskUserQuestion)', () => {
  assert.equal(askText(en, { reasonParams: { ask: 'plan' } }), 'Review the plan and say whether to go ahead.');
  assert.equal(askText(ja, { reasonParams: { ask: 'question' } }), '質問に答えてください');
  assert.equal(askText(en, {}), '');
});

test('projectLabel: label が null なら「フォルダなし」。別の repo の数は +N', () => {
  assert.equal(projectLabel(en, { label: null }), 'No project folder');
  assert.equal(projectLabel(ja, { label: null }), 'フォルダなし');
  assert.equal(projectLabel(en, { label: 'demo-app', extra: 2 }), 'demo-app +2');
});

test('prLabel: 2 つ以上の repo にまたがるときだけ repo 名を付ける。知らない状態はそのまま', () => {
  const a = { num: 1, repo: 'o/demo-web', state: 'OPEN' };
  assert.equal(prLabel(en, a, true), 'demo-web #1 open');
  assert.equal(prLabel(en, a, false), 'PR #1 open');
  assert.equal(prLabel(ja, a, false), 'PR #1 マージ前');
  assert.equal(prLabel(en, { num: 2, repo: 'o/x', state: 'DRAFT' }, false), 'PR #2 DRAFT');
});

test('contentLang: 仮名か漢字があれば ja', () => {
  assert.equal(contentLang('ボタンの色'), 'ja');
  assert.equal(contentLang('漢字'), 'ja');
  assert.equal(contentLang('Waiting for approval.'), 'en');
  assert.equal(contentLang(''), 'en');
});

test('tabTitle: 返事待ち > 止まったかも > 名前だけ。オフラインなら印', () => {
  assert.equal(tabTitle(en, { needs_you: 4, trouble: 2 }), '(4) Needs you — Pigeonholes');
  assert.equal(tabTitle(ja, { needs_you: 4, trouble: 2 }), '(4) 返事待ち — Pigeonholes');
  assert.equal(tabTitle(en, { needs_you: 0, trouble: 2 }), '(2) Stuck? — Pigeonholes');
  assert.equal(tabTitle(en, { needs_you: 0, trouble: 0 }), 'Pigeonholes');
  assert.equal(tabTitle(en, null), 'Pigeonholes');
  assert.equal(tabTitle(en, { needs_you: 1 }, true), '(1) Needs you — Pigeonholes (offline)');
  assert.equal(tabTitle(ja, { needs_you: 0 }, true), 'Pigeonholes (オフライン)');
});

test('dateline と絶対時刻: 自前のテンプレートで (Intl を使わない)', () => {
  assert.equal(dateline(en, NOW), 'Sun 18 Oct, as of 14:52');
  assert.equal(dateline(ja, NOW), '10 月 18 日 (日) 14:52 時点');
  assert.equal(absoluteTime(NOW), '2026-10-18 14:52');
  assert.equal(absoluteTime(null), '');
  assert.equal(createdText(en, NOW - HOUR, NOW), 'today 13:52');
  assert.equal(createdText(ja, NOW - HOUR, NOW), '今日 13:52');
  assert.equal(createdText(en, NOW - 2 * DAY, NOW), '2026-10-16 14:52');
});

test('matches: 止まったかもを理由の文で、フォルダなしを「フォルダなし」で見つける (今の言語で)', () => {
  const stuck = card({ reason: 'stalled', reasonParams: { via: 'tool' } });
  assert.equal(matches(stuck, 'permission', en), true);
  assert.equal(matches(stuck, '許可', ja), true);
  assert.equal(matches(stuck, 'permission', ja), false);
  const other = card({ bucket: 'recent', project: { key: '(other)', label: null, extra: 0 } });
  assert.equal(matches(other, 'no project', en), true);
  assert.equal(matches(other, 'フォルダなし', ja), true);
  assert.equal(matches(card({ title: 'Fix Login' }), 'login', en), true);
  assert.equal(matches(card({ title: 'x' }), '', en), true);
});

test('archiveInstruction: 3 行の頼み方 + 1 行に 1 つの ID (en / ja)', () => {
  const ids = ['local_00000000-0000-4000-8000-000000000001', 'local_00000000-0000-4000-8000-000000000002'];
  const e = archiveInstruction(en, ids).split('\n');
  assert.equal(e.length, 3 + 2);
  assert.equal(e[0], 'Please archive the following 2 sessions (archiving can be undone).');
  assert.match(e[1], /Skip this session itself, any session that is still working, and pinned sessions/);
  assert.equal(e[2], 'When done, reply only with "archived N, skipped N".');
  assert.deepEqual(e.slice(3), ids);
  assert.equal(archiveInstruction(en, ids.slice(0, 1)).split('\n')[0], 'Please archive the following session (archiving can be undone).');
  const j = archiveInstruction(ja, ids).split('\n');
  assert.equal(j.length, 5);
  assert.equal(j[0], '次の 2 件のセッションをアーカイブしてください (アーカイブは後から元に戻せます)。');
  assert.match(j[1], /このセッション自身・作業中のもの・ピン留めしたものは飛ばしてください/);
  assert.deepEqual(j.slice(3), ids);
});

test('childrenText: 0 件の項目は省く', () => {
  assert.equal(childrenText(en, { total: 3, working: 1, needs_you: 1, trouble: 0, unread: 0 }), '3 child sessions (1 needs you, 1 working)');
  assert.equal(childrenText(en, { total: 1, working: 0, needs_you: 0, trouble: 0, unread: 0 }), '1 child session');
  assert.equal(childrenText(ja, { total: 3, working: 1, needs_you: 2, trouble: 0, unread: 0 }), '子 3 件 (返事待ち 2、作業中 1)');
});

test('routineHistory / routineFlaky: 最新回を除いた過去の回', () => {
  assert.equal(routineHistory(en, { runs: 5, completed: 2, stalled: 2 }), 'Last 4 runs: 2 finished, 2 stopped midway');
  assert.equal(routineHistory(en, { runs: 2, completed: 1, stalled: 0 }), 'Last run: 1 finished, 0 stopped midway');
  assert.equal(routineHistory(ja, { runs: 5, completed: 2, stalled: 2 }), '過去 4 回: 完了 2、途中で止まった 2');
  assert.equal(routineHistory(en, { runs: 1, completed: 0, stalled: 0 }), '');
  assert.equal(routineHistory(en, { runs: 4, completed: 0, stalled: 0 }), '');
  assert.equal(routineFlaky(ja, { runs: 5, stalled: 2 }), '過去 4 回のうち 2 回は途中で止まりました');
  assert.equal(routineFlaky(en, { runs: 5, stalled: 1 }), '');
});

test('quietHint: 5 分を超えて静かな作業中だけ', () => {
  assert.equal(quietHint(en, NOW - QUIET_HINT_MS, NOW), '');
  assert.equal(quietHint(en, NOW - 9 * MIN, NOW), 'Quiet 9 min. Moves to “Stuck?” at 15 min.');
  assert.equal(quietHint(ja, NOW - 9 * MIN, NOW), '9 分動きなし。15 分たつと「止まったかも」に移ります');
});

test('cleanupGroupName: 日数は定数から', () => {
  assert.equal(cleanupGroupName(en, 'idle_30d'), 'Untouched for 30+ days');
  assert.equal(cleanupGroupName(ja, 'idle_7d'), '7〜30 日さわっていない');
  assert.equal(cleanupGroupName(ja, 'old_error'), '7 日以上エラーのまま');
});

test('deepLink: Claude app session ID のときだけ', () => {
  assert.equal(deepLink('local_00000000-0000-4000-8000-000000000001'), 'claude://claude.ai/epitaxy/local_00000000-0000-4000-8000-000000000001');
  assert.equal(deepLink('codex_00000000-0000-4000-8000-000000000001'), null);
  assert.equal(deepLink('copilot_00000000-0000-4000-8000-000000000001'), null);
  assert.equal(deepLink('opencode_00000000-0000-4000-8000-000000000001'), null);
  assert.equal(deepLink('local_x'), null);
  assert.equal(deepLink('javascript:alert(1)'), null);
});

// ---------- v0.2: していること・コンテキストの言葉 (spec/ui.md §8.4・§8.5・§10.3) ----------

test('tokensText: 1000 未満はそのまま、K は四捨五入、M は小数 1 桁 (末尾の .0 は付けない)', () => {
  const cases = [[0, '0'], [999, '999'], [1000, '1K'], [150000, '150K'], [167000, '167K'], [967000, '967K'], [999600, '1M'], [1000000, '1M'], [1200000, '1.2M']];
  for (const [n, s] of cases) assert.equal(tokensText(Number(n)), s, String(n));
});

test('doingSpec: 全部の種類を target あり / なしで。agents は n、知らない種類は doing.tool', () => {
  const k = (/** @type {any} */ a) => doingSpec(a).key;
  const withTarget = { edit: 'doing.edit', write: 'doing.write', read: 'doing.read', run: 'doing.run', test: 'doing.test', git: 'doing.git', web: 'doing.webHost', connector: 'doing.connector' };
  const bare = { edit: 'doing.edit_bare', write: 'doing.edit_bare', read: 'doing.read_bare', run: 'doing.run_bare', test: 'doing.test_bare', git: 'doing.git_bare', web: 'doing.web', connector: 'doing.connector_bare' };
  for (const [kind, key] of Object.entries(withTarget)) assert.deepEqual(doingSpec({ kind, target: 'board.mjs' }), { key, params: { target: 'board.mjs' } }, kind);
  for (const [kind, key] of Object.entries(bare)) assert.equal(k({ kind }), key, kind);
  for (const kind of ['search', 'browser', 'plan', 'wrap_up', 'think']) assert.equal(k({ kind, target: 'x' }), `doing.${kind}`, kind);
  assert.deepEqual(doingSpec({ kind: 'agents', n: 1 }), { key: 'doing.agents', params: { n: 1 } });
  assert.equal(en(doingSpec({ kind: 'agents', n: 2 }).key, { n: 2 }), '2 helpers at work');
  assert.equal(en(doingSpec({ kind: 'agents', n: 1 }).key, { n: 1 }), '1 helper at work');
  assert.equal(k({ kind: 'agents' }), 'doing.agents_bare');
  assert.equal(k({ kind: 'tool' }), 'doing.tool');
  assert.equal(k({ kind: 'teleport' }), 'doing.tool');
  assert.equal(k({ kind: 'constructor' }), 'doing.tool', 'Object の名前を種類と取り違えない');
  assert.equal(k(null), 'doing.tool');
  for (const key of [...Object.values(withTarget), ...Object.values(bare), 'doing.agents', 'doing.agents_bare', 'doing.tool']) assert.ok(en.has(key) && ja.has(key), key);
});

test('doingMainSpec と doingText: Claude の説明は実行・テスト・Git だけ。手順は先頭に', () => {
  assert.deepEqual(doingMainSpec({ kind: 'test', target: 'npm test', note: 'Run the unit tests' }), { key: 'doing.note', params: { note: 'Run the unit tests' } });
  assert.equal(doingMainSpec({ kind: 'edit', target: 'a.mjs', note: 'x' }).key, 'doing.edit', 'edit の note は使わない');
  assert.equal(doingText(en, { kind: 'edit', target: 'board.mjs' }), 'Editing board.mjs');
  assert.equal(doingText(ja, { kind: 'edit', target: 'board.mjs' }), 'board.mjs を編集中');
  assert.equal(doingText(en, { kind: 'run', note: 'Build the site', step: 'Write the spec' }), 'Step: Write the spec “Build the site”');
  assert.equal(doingText(ja, { kind: 'test', note: 'テストを実行', step: '仕様を書く' }), '手順: 仕様を書く 「テストを実行」');
  assert.equal(doingText(en, undefined), '');
});

test('asOfText: 「N 前の時点: …」は長い単位、時刻が無ければ空、1 分未満は 1 分', () => {
  const a = { kind: 'run', target: 'npm', at: NOW - 3 * HOUR };
  assert.equal(asOfText(en, a, NOW), 'As of 3 hours ago: Running npm');
  assert.equal(asOfText(ja, a, NOW), '3 時間前の時点: npm を実行中');
  assert.equal(asOfText(en, { kind: 'run', target: 'npm' }, NOW), '');
  assert.equal(asOfText(en, null, NOW), '');
  assert.equal(asOfText(en, { kind: 'think', at: NOW - 10 * SEC }, NOW), 'As of 1 minute ago: Thinking');
  assert.equal(agoWords(en, 'ctx.copied', NOW - 2 * HOUR, NOW), 'hand-off copied 2 h ago', '行の言葉は短い単位');
});

test('shortDoing: 欄と理由ごと (キャンバスの中くらいの縮尺)', () => {
  const s = (/** @type {Record<string, any>} */ o) => shortDoing(en, card(o));
  // 返事待ちと未読は '' (印と時刻の言葉が同じことを言う)
  assert.equal(s({ bucket: 'needs_you', reason: 'asking', reasonParams: { ask: 'plan' } }), '');
  assert.equal(s({ bucket: 'needs_you', reason: 'asks' }), '');
  assert.equal(s({ bucket: 'trouble', reason: 'stalled', reasonParams: { via: 'tool' } }), 'Stopped mid-tool');
  assert.equal(s({ bucket: 'trouble', reason: 'stalled', reasonParams: { via: 'prompt' } }), 'No reply yet');
  assert.equal(s({ bucket: 'trouble', reason: 'limit' }), 'Hit the usage limit');
  assert.equal(s({ bucket: 'trouble', reason: 'git_startup' }), 'Failed to start');
  assert.equal(s({ bucket: 'trouble', reason: 'not_started' }), 'Never started');
  assert.equal(s({ bucket: 'trouble', reason: 'error' }), 'Stopped on an error');
  assert.equal(s({ bucket: 'unread', reason: 'unread' }), '');
  assert.equal(s({ bucket: 'working', reason: 'turn', activity: { kind: 'git', target: 'git push' } }), 'Using Git (git push)');
  // 1 行の形: 手順と主の部分の片方だけ (主の部分が具体的なら主の部分、そうでなければ手順)
  assert.equal(s({ bucket: 'working', reason: 'turn', activity: { kind: 'test', target: 'npm test', note: 'Run the unit tests', step: 'Write tests' } }), '“Run the unit tests”');
  assert.equal(s({ bucket: 'working', reason: 'turn', activity: { kind: 'edit', target: 'a.mjs', step: 'Write tests' } }), 'Editing a.mjs');
  assert.equal(s({ bucket: 'working', reason: 'turn', activity: { kind: 'think', step: 'Write tests' } }), 'Step: Write tests');
  assert.equal(s({ bucket: 'working', reason: 'turn', activity: { kind: 'agents', n: 2, step: 'Write tests' } }), '2 helpers at work');
  assert.equal(s({ bucket: 'working', reason: 'background' }), 'Working in the background');
  assert.equal(s({ bucket: 'working', reason: 'starting' }), 'Starting');
  assert.equal(s({ bucket: 'working', reason: 'turn' }), '');
  assert.equal(s({ bucket: 'recent', reason: 'recent' }), '');
  assert.equal(s({ bucket: 'cleanup', reason: 'idle_7d' }), '');
  assert.equal(shortDoing(ja, card({ bucket: 'trouble', reason: 'limit' })), '使用上限で停止');
});

test('contextMeta: 段階なし・notice・推定・due・soon・always、要約は 1 時間以内だけ', () => {
  const ctx = (/** @type {Record<string, any>} */ o) => ({ used: 120000, window: 200000, inferred: false, pct: 60, compactAt: 167000, ...o });
  assert.deepEqual(contextMeta(en, ctx({}), NOW), []);
  assert.deepEqual(contextMeta(en, ctx({}), NOW, { always: true }), [{ text: 'context 60%', strong: false }]);
  assert.deepEqual(contextMeta(en, ctx({ level: 'notice' }), NOW), [{ text: 'context 60%', strong: false }]);
  assert.deepEqual(contextMeta(ja, ctx({ level: 'notice', inferred: true }), NOW), [{ text: 'コンテキスト 約 60%', strong: false }]);
  assert.deepEqual(contextMeta(en, ctx({ level: 'due', pct: 80 }), NOW), [{ text: 'context 80% time to hand off', strong: true }]);
  assert.deepEqual(contextMeta(ja, ctx({ level: 'soon', pct: 90 }), NOW), [{ text: 'コンテキスト 90% まもなく自動で要約', strong: true }]);
  const inside = contextMeta(en, ctx({ compacted: { at: NOW - 20 * MIN, trigger: 'auto' } }), NOW);
  assert.equal(inside.length, 1);
  assert.equal(inside[0].text, 'summarized 20 min ago');
  assert.deepEqual(inside[0].ago, { key: 'ctx.compacted', at: NOW - 20 * MIN, until: NOW - 20 * MIN + HOUR });
  assert.deepEqual(contextMeta(en, ctx({ compacted: { at: NOW - 61 * MIN, trigger: 'auto' } }), NOW), [], '1 時間を過ぎた要約は行に出さない');
  assert.deepEqual(contextMeta(en, undefined, NOW), []);
});

test('contextValueText: 割合・使用量・窓・要約の点、推定の一言、要約はいつでも (en / ja)', () => {
  const c = { used: 164000, window: 200000, inferred: true, pct: 82, compactAt: 167000, level: 'due', compacted: { at: NOW - 3 * HOUR, trigger: 'manual' } };
  assert.equal(contextValueText(en, c, NOW), '82% (164K of 200K tokens). It summarizes itself at about 167K. The size limit is a guess. summarized 3 h ago');
  assert.equal(contextValueText(ja, c, NOW), '82% (200K トークン中 164K)。約 167K で自動で要約されます。上限の大きさは推定です。3 時間前に要約済み');
  const big = { ...c, inferred: false, window: 1000000, used: 812000, compactAt: 967000, pct: 81 };
  assert.equal(contextValueText(en, big, NOW, { compacted: false }), '81% (812K of 1M tokens). It summarizes itself at about 967K.');
  assert.equal(contextValueText(en, null, NOW), '');
});

test('waitWordsKey: 引き継げない欄の言葉は due / soon のときだけ', () => {
  const due = { level: 'due', pct: 80 };
  assert.equal(waitWordsKey(card({ bucket: 'working', context: due })), 'ctx.afterWork');
  assert.equal(waitWordsKey(card({ bucket: 'needs_you', context: { ...due, level: 'soon' } })), 'ctx.answerFirst');
  assert.equal(waitWordsKey(card({ bucket: 'trouble', reason: 'limit', context: due })), 'ctx.afterLimit');
  assert.equal(waitWordsKey(card({ bucket: 'trouble', reason: 'stalled', context: due })), null);
  assert.equal(waitWordsKey(card({ bucket: 'working', context: { level: 'notice', pct: 60 } })), null);
  assert.equal(waitWordsKey(card({ bucket: 'unread', context: due })), null);
});

test('matches (v0.2): していること・target・手順・「引き継ぎ」/ "hand off" (due) でも見つける', () => {
  const w = card({ bucket: 'working', activity: { kind: 'edit', target: 'board.mjs', step: 'Write the canvas spec', live: true } });
  assert.equal(matches(w, 'editing', en), true);
  assert.equal(matches(w, 'board.mjs', en), true);
  assert.equal(matches(w, 'canvas spec', en), true);
  assert.equal(matches(w, '編集中', ja), true);
  const due = card({ bucket: 'unread', context: { used: 166000, window: 200000, inferred: false, pct: 83, compactAt: 167000, level: 'due' } });
  assert.equal(matches(due, 'hand off', en), true);
  assert.equal(matches(due, '引き継ぎ', ja), true);
  assert.equal(matches(card({ bucket: 'unread', context: { pct: 60, level: 'notice' } }), 'hand off', en), false);
  assert.equal(matches(card({ bucket: 'working', context: { pct: 80, level: 'due' } }), '終わってから', ja), true, '作業中は「終わってから引き継げます」');
  const comp = card({ bucket: 'recent', context: { pct: 10, compacted: { at: NOW - 5 * MIN, trigger: 'auto' } } });
  assert.equal(matches(comp, 'summarized', en, NOW), true);
  assert.equal(matches(comp, 'summarized', en), false, '今を渡さなければ要約の言葉は探さない');
});
