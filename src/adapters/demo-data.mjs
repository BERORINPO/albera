// @ts-check
// adapter (Fake 用データ): `npm run demo` とテストで使う合成のセッションと会話ログ。
// 実際のセッションの title や報告は入れない。すべて作り物。パスは OS に依らない POSIX の文字列 (~/projects/...)。
// 中身の言語は端末の言語 (buildDemo の lang)。画面の言葉ではなく「中身」なので、この file は arch 6 の対象外。

import { DAY, HOUR, MIN, SEC } from '../shared/constants.mjs';

/** @typedef {import('../shared/types.mjs').FolderHint} FolderHint */
/** @typedef {import('../shared/types.mjs').TranscriptInput} TranscriptInput */

/** 決まった形の UUID を作る。 @param {number} n */
export const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
/** @param {number} n */
export const sid = (n) => `local_${uuid(n)}`;
/** @param {number} n */
export const cid = (n) => uuid(100000 + n);

const line = (/** @type {object} */ o) => JSON.stringify(o);

/**
 * 会話ログの 1 行に "timestamp" (ISO 文字列) を付ける。at が無ければそのまま返す。
 * @param {string} text JSON 1 行
 * @param {number|undefined} at ms
 */
export function stamp(text, at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return text;
  return JSON.stringify({ ...JSON.parse(text), timestamp: new Date(at).toISOString() });
}

/** 会話ログの 1 行を作る道具 (合成)。 */
export const synth = {
  /** @param {string} text @param {number} [at] 指示を送った時刻 (ms)。あれば timestamp を付ける */
  prompt: (text, at) => stamp(line({ type: 'user', message: { role: 'user', content: text } }), at),
  text: (/** @type {string} */ text, stop = 'end_turn') =>
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop } }),
  toolUse: () =>
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop_reason: 'tool_use' } }),
  toolResult: () => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
  /** 利用者に質問するツール (AskUserQuestion / ExitPlanMode) の呼び出し */
  ask: (/** @type {string} */ id, /** @type {string} */ question, name = 'AskUserQuestion') =>
    line({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input: name === 'AskUserQuestion' ? { questions: [{ question, header: 'h', options: [] }] } : { plan: question } }],
        stop_reason: 'tool_use',
      },
    }),
  toolUseId: (/** @type {string} */ id, name = 'Bash') =>
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }], stop_reason: 'tool_use' } }),
  resultFor: (/** @type {string} */ id) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }),
  stopHook: () => line({ type: 'system', subtype: 'stop_hook_summary' }),
  otherSystem: () => line({ type: 'system', subtype: 'compact_boundary' }),
  notification: () => line({ type: 'user', message: { role: 'user', content: '<task-notification>終わりました</task-notification>' } }),
  reminder: () => line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>メモ</system-reminder>' }] } }),
  interrupted: () => line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
  meta: () => line({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } }),
  commandName: () => line({ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' } }),
  commandStdout: () => line({ type: 'user', message: { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' } }),
  noise: () => line({ type: 'file-history-snapshot', snapshot: {} }),
};

/**
 * 末尾の行に付ける時刻。start = 今のターンを始めた指示の行、end = それ以外の行 (無ければ start)。両方無ければ timestamp なし。
 * @typedef {{start?: number, end?: number}} Times
 */

/** @param {Times} [w] */
const clocks = (w = {}) => ({
  p: (/** @type {string} */ l) => stamp(l, w.start),
  r: (/** @type {string} */ l) => stamp(l, w.end ?? w.start),
});

/** よく使う末尾の形。引数の Times を渡すと timestamp が付く (startedAt の材料)。 */
export const tails = {
  /** @param {Times} [w] */
  ended: (w) => {
    const c = clocks(w);
    return [c.p(synth.prompt('進めてください')), c.r(synth.toolUse()), c.r(synth.toolResult()), c.r(synth.text('終わりました')), c.r(synth.stopHook()), ''].join('\n');
  },
  /** @param {Times} [w] */
  tool: (w) => {
    const c = clocks(w);
    return [c.p(synth.prompt('調べてください')), c.r(synth.toolUse()), ''].join('\n');
  },
  /** @param {Times} [w] */
  toolResult: (w) => {
    const c = clocks(w);
    return [c.p(synth.prompt('調べてください')), c.r(synth.toolUse()), c.r(synth.toolResult()), ''].join('\n');
  },
  /** @param {Times} [w] */
  prompt: (w) => {
    const c = clocks(w);
    return [c.r(synth.text('どうしますか')), c.r(synth.stopHook()), c.p(synth.prompt('こちらでお願いします')), ''].join('\n');
  },
  /** @param {string} [question] @param {Times} [w] @param {string} [name] AskUserQuestion か ExitPlanMode */
  asking: (question = 'どちらの案で進めますか?', w, name = 'AskUserQuestion') => {
    const c = clocks(w);
    return [c.p(synth.prompt('進めてください')), c.r(synth.toolUse()), c.r(synth.toolResult()), c.r(synth.ask('q1', question, name)), ''].join('\n');
  },
};

/** 大きすぎる項目 (画面に出てはいけないもの) の見本 */
const HEAVY = {
  remoteMcpServersConfig: [{ name: 'demo-server', url: 'http://example.invalid/mcp', secretish: 'x'.repeat(64) }],
  promptAppendSnapshot: { text: 'p'.repeat(256) },
  enabledMcpTools: { demo: true },
  permissionMode: 'default',
  model: 'demo-model',
};

// --- パス (POSIX の文字列。実在の場所ではない) ---
const HOME = '~';
const APP = '~/projects/demo-app';
const NOTES = '~/projects/notes';
const SITE = '~/projects/site';
const WORKTREE = '~/projects/demo-app/.claude/worktrees/fix-login';

/** デモの folder hints (fake-folder-hints に渡す合成の表)。 @type {Record<string, FolderHint>} */
const FOLDER_HINTS = {
  [APP]: { kind: 'repo', name: 'demo-app' },
  [NOTES]: { kind: 'repo', name: 'notes' },
  [SITE]: { kind: 'repo', name: 'site' },
  '~/projects': { kind: 'container' },
  [HOME]: { kind: 'container' },
};

/** 中身の文 (端末の言語ごと)。実在の定期実行・人物・組織を思わせる題名は使わない。 */
const TEXT = {
  en: {
    config: 'Decide where the config file goes',
    configDetail: 'Two options are ready.',
    configAsk: 'Should it go in folder A or folder B?',
    wording: 'Plan the wording for the demo screen',
    colour: 'Pick the button colour',
    colourAsk: 'Should the button be blue or green?',
    tally: 'Tally the weekly report (demo)',
    limit: 'Demo that hit the usage limit',
    failed: 'Demo that failed to start',
    readme: 'Tidy up the README',
    readmeWrap: 'Split it into 4 headings and cut the setup steps to 3 lines. Not committed yet.',
    login: 'Fix the login screen bug',
    loginReport: '"[PR #12](https://github.com/demo-org/demo-app/pull/12) is up. All 21 tests pass. ⏎ Details here"',
    search: 'Add a search box',
    background: 'Research in the background',
    release: 'Release prep (demo)',
    changelog: 'Write the changelog',
    version: 'Choose the next version number',
    versionDetail: 'Need a decision.',
    versionAsk: 'Should the next release be 1.1 or 2.0?',
    deps: 'Check the dependencies',
    recent: ['Settle the design colours', 'Sort the notes', 'Loose notes', 'Adjust the page margins', 'Sort the table'],
    routine: 'Daily link check (demo)',
    merged: 'Remove the old feature (merged)',
    buildFail: 'Build still failing',
    oldQuestion: 'An old question is still open',
    oldQuestionDetail: 'Waiting.',
    oldQuestionAsk: 'Is it OK to go ahead as is?',
    halfway: 'Research I stopped halfway',
    compress: 'Compress the images',
    oldChat: (/** @type {number} */ i) => `Old chat ${i}`,
    oldParent: 'Old parent session',
    fromParent: 'Work started from the parent',
    archived: (/** @type {number} */ i) => `Archived ${i}`,
  },
  ja: {
    config: '設定ファイルの置き場所を決める',
    configDetail: '案を 2 つ用意しました。',
    configAsk: 'A と B のどちらのフォルダに置きますか?',
    wording: 'デモ画面の文言を決める',
    colour: 'ボタンの色を相談する',
    colourAsk: 'ボタンは青と緑のどちらにしますか?',
    tally: '週次レポートの集計 (デモ)',
    limit: '使用上限で止まったデモ',
    failed: '起動に失敗したデモ',
    readme: 'README を日本語で整える',
    readmeWrap: '見出しを 4 つに分け、起動手順を 3 行にまとめた。まだ commit はしていない。',
    login: 'ログイン画面の不具合を直す',
    loginReport: '"[PR #12](https://github.com/demo-org/demo-app/pull/12) を出しました。テストは 21 件とも通っています。 ⏎ 詳細はこちら"',
    search: '検索機能を追加する',
    background: 'バックグラウンドで調べ物をする',
    release: 'リリース準備 (デモ)',
    changelog: '変更履歴を書く',
    version: '版番号の付け方を相談',
    versionDetail: '決めてほしいことがあります。',
    versionAsk: '次の版は 1.1 と 2.0 のどちらにしますか?',
    deps: '依存関係を確認',
    recent: ['デザインの色を決めた', 'メモの整理', '雑談メモ', '画面の余白を調整', '表の並び替え'],
    routine: '【毎日】リンク切れを調べる (デモ)',
    merged: '古い機能の削除 (merge 済み)',
    buildFail: 'ビルドが失敗したまま',
    oldQuestion: '古い質問が残っている',
    oldQuestionDetail: '返事を待っています。',
    oldQuestionAsk: 'このまま進めてよいですか?',
    halfway: '途中でやめた調査',
    compress: '画像を圧縮する',
    oldChat: (/** @type {number} */ i) => `古い会話 ${i}`,
    oldParent: '古い親セッション',
    fromParent: '親から始めた作業',
    archived: (/** @type {number} */ i) => `アーカイブ済み ${i}`,
  },
};

/**
 * @param {number} n
 * @param {Record<string, unknown>} fields
 */
function raw(n, fields) {
  return { sessionId: sid(n), cliSessionId: cid(n), isArchived: false, cwd: APP, originCwd: APP, ...HEAVY, ...fields };
}

/**
 * 全バケットが少なくとも 1 件ずつ出るデモ盤面。
 * 返事待ち 4 / 止まったかも 3 / 未読 3 / 作業中 4 / 最近 7 (3 プロジェクト + フォルダなし) / 片付け候補 35 / アーカイブ済み 3。
 * @param {number} now
 * @param {string} [lang] 端末の言語 ('en' | 'ja')。それ以外は en
 * @returns {{raws: Array<Record<string, unknown>>, archivedIds: string[], transcripts: Map<string, TranscriptInput>, folderHints: Record<string, FolderHint>}}
 */
export function buildDemo(now, lang = 'en') {
  const x = lang === 'ja' ? TEXT.ja : TEXT.en;
  const t = (/** @type {number} */ ms) => now - ms;
  /** @type {Array<Record<string, unknown>>} */
  const raws = [];
  /** @type {Map<string, TranscriptInput>} */
  const transcripts = new Map();
  /** 会話ログ。mainAgo = 本体の最後の書き込み、subAgo = subagents の最後の書き込み (無ければ -1) */
  const tr = (/** @type {number} */ n, /** @type {string} */ tail, /** @type {number} */ mainAgo, subAgo = -1) =>
    transcripts.set(cid(n), { tail, truncatedHead: false, mainMtime: t(mainAgo), subMtime: subAgo < 0 ? 0 : t(subAgo), size: tail.length });
  /** 指示を startAgo 前に送り、最後の書き込みが endAgo 前の時刻 */
  const w = (/** @type {number} */ startAgo, /** @type {number} */ endAgo) => ({ start: t(startAgo), end: t(endAgo) });
  const add = (/** @type {number} */ n, /** @type {Record<string, unknown>} */ f) => raws.push(raw(n, f));

  // 返事待ち (待ち時間はそれぞれ違う: 2 時間 = 家族の子 / 50 分 = 質問文の無い ExitPlanMode / 20 分 = AskUserQuestion / 4 分)
  add(1, { title: x.config, createdAt: t(2 * HOUR), lastActivityAt: t(4 * MIN), lastFocusedAt: t(30 * MIN),
    postTurnSummary: { status_category: 'blocked', status_detail: x.configDetail, needs_action: x.configAsk } });
  tr(1, tails.ended(w(10 * MIN, 4 * MIN)), 4 * MIN);
  add(2, { title: x.wording, cwd: NOTES, originCwd: NOTES, createdAt: t(5 * HOUR), lastActivityAt: t(50 * MIN), lastFocusedAt: t(50 * MIN) });
  tr(2, tails.asking('', w(70 * MIN, 50 * MIN), 'ExitPlanMode'), 50 * MIN);
  add(19, { title: x.colour, createdAt: t(1 * HOUR), lastActivityAt: t(20 * MIN), lastFocusedAt: t(20 * MIN) });
  tr(19, tails.asking(x.colourAsk, w(25 * MIN, 20 * MIN)), 20 * MIN);
  // 止まっているかも (無音で止まった・使用上限・起動失敗)
  add(3, { title: x.tally, createdAt: t(4 * HOUR), lastActivityAt: t(3 * HOUR), lastFocusedAt: t(4 * HOUR) });
  tr(3, tails.tool(w(3 * HOUR + 5 * MIN, 3 * HOUR)), 3 * HOUR);
  add(4, { title: x.limit, createdAt: t(3 * HOUR), lastActivityAt: t(40 * MIN), error: "You've hit your session limit · resets 1:50pm", errorAt: t(40 * MIN) });
  tr(4, tails.toolResult(w(45 * MIN, 40 * MIN)), 40 * MIN);
  add(5, { title: x.failed, createdAt: t(20 * MIN), lastActivityAt: t(20 * MIN), error: "Git is installed but isn't working (demo).", errorAt: t(20 * MIN), errorCategory: 'git_startup_failed' });
  // 終わった・未読 (PR 付き・定期実行の回は下の定期実行)
  add(6, { title: x.readme, createdAt: t(3 * HOUR), lastActivityAt: t(12 * MIN), lastFocusedAt: t(1 * HOUR), turnWrapUp: { description: x.readmeWrap } });
  tr(6, tails.ended(w(30 * MIN, 12 * MIN)), 12 * MIN);
  add(7, { title: x.login, cwd: WORKTREE, originCwd: APP, createdAt: t(6 * HOUR), lastActivityAt: t(25 * MIN), lastFocusedAt: t(2 * HOUR),
    branch: 'fix/login', worktreeName: 'fix-login', completedTurns: 6,
    prs: [{ prNumber: 12, repo: 'demo-org/demo-app', url: 'https://github.com/demo-org/demo-app/pull/12', state: 'OPEN' }],
    lastTurnReport: x.loginReport });
  tr(7, tails.ended(w(40 * MIN, 25 * MIN)), 25 * MIN);
  // 作業中 (ターンの途中 = startedAt あり / バックグラウンドの subagent / 家族の子 2 件)
  add(8, { title: x.search, createdAt: t(40 * MIN), lastActivityAt: t(1 * MIN), lastFocusedAt: t(1 * MIN) });
  tr(8, tails.toolResult(w(23 * MIN, 30 * SEC)), 30 * SEC);
  add(9, { title: x.background, cwd: NOTES, originCwd: NOTES, createdAt: t(1 * HOUR), lastActivityAt: t(20 * MIN), lastFocusedAt: t(20 * MIN) });
  tr(9, tails.ended(w(25 * MIN, 20 * MIN)), 20 * MIN, 1 * MIN);
  // 家族 (親 1・子 3): 親は最近、子は作業中・返事待ち・最近 (フォルダ無し = 親から継承)
  add(10, { title: x.release, createdAt: t(1 * DAY), lastActivityAt: t(5 * HOUR), lastFocusedAt: t(4 * HOUR) });
  tr(10, tails.ended(w(5 * HOUR + 10 * MIN, 5 * HOUR)), 5 * HOUR);
  add(11, { title: x.changelog, createdAt: t(4 * HOUR), lastActivityAt: t(2 * MIN), lastFocusedAt: t(2 * MIN), spawnedFrom: { sessionId: sid(10), taskId: 'x' } });
  tr(11, tails.tool(w(6 * MIN, 20 * SEC)), 20 * SEC);
  add(12, { title: x.version, createdAt: t(4 * HOUR), lastActivityAt: t(2 * HOUR), lastFocusedAt: t(3 * HOUR), spawnedFrom: { sessionId: sid(10), taskId: 'y' },
    postTurnSummary: { status_category: 'blocked', status_detail: x.versionDetail, needs_action: x.versionAsk } });
  tr(12, tails.ended(w(2 * HOUR + 15 * MIN, 2 * HOUR)), 2 * HOUR);
  add(13, { title: x.deps, cwd: '', originCwd: '', createdAt: t(4 * HOUR), lastActivityAt: t(3 * HOUR), lastFocusedAt: t(2 * HOUR), spawnedFrom: { sessionId: sid(10), taskId: 'z' } });
  tr(13, tails.ended(w(3 * HOUR + 10 * MIN, 3 * HOUR)), 3 * HOUR);
  // 最近 (読んだ。demo-app・notes・site と、home で開いた会話 = フォルダなし)
  const recentCwd = [APP, NOTES, HOME, SITE, APP];
  x.recent.forEach((title, i) => {
    const n = 14 + i;
    const d = i + 1;
    add(n, { title, cwd: recentCwd[i], originCwd: recentCwd[i], createdAt: t(d * DAY + HOUR), lastActivityAt: t(d * DAY), lastFocusedAt: t(d * DAY - MIN) });
    tr(n, tails.ended(w(d * DAY + 10 * MIN, d * DAY)), d * DAY);
  });
  // 定期実行 (5 回。最新は未読、古い 4 回は片付け候補。そのうち 2 回はツールの途中で止まった)
  for (let i = 0; i < 5; i++) {
    const n = 20 + i;
    const ago = i * DAY + 2 * HOUR;
    add(n, { title: x.routine, scheduledTaskId: 'demo-daily-link-check', cwd: NOTES, originCwd: NOTES, createdAt: t(ago + 10 * MIN), lastActivityAt: t(ago) });
    tr(n, i === 1 || i === 3 ? tails.tool(w(ago + 5 * MIN, ago)) : tails.ended(w(ago + 10 * MIN, ago)), ago);
  }
  // 片付け候補: PR 済み / 古いエラー / 古い質問 / 7〜30 日 / やり直し済み / 30 日以上 (多数)
  add(30, { title: x.merged, createdAt: t(4 * DAY), lastActivityAt: t(3 * DAY), lastFocusedAt: t(2 * DAY),
    prs: [{ prNumber: 9, repo: 'demo-org/demo-app', url: 'https://github.com/demo-org/demo-app/pull/9', state: 'MERGED' }] });
  add(31, { title: x.buildFail, createdAt: t(11 * DAY), lastActivityAt: t(10 * DAY), lastFocusedAt: t(10 * DAY), error: 'API Error: demo failure', errorAt: t(10 * DAY) });
  add(32, { title: x.oldQuestion, createdAt: t(10 * DAY), lastActivityAt: t(9 * DAY), lastFocusedAt: t(9 * DAY),
    postTurnSummary: { status_category: 'blocked', status_detail: x.oldQuestionDetail, needs_action: x.oldQuestionAsk } });
  add(33, { title: x.halfway, createdAt: t(13 * DAY), lastActivityAt: t(12 * DAY), lastFocusedAt: t(12 * DAY) });
  add(34, { title: x.compress, createdAt: t(9 * DAY), lastActivityAt: t(9 * DAY), errorCategory: 'git_startup_failed', error: 'Git is not working (demo).', errorAt: t(9 * DAY) });
  add(35, { title: x.compress, createdAt: t(9 * DAY - HOUR), lastActivityAt: t(8 * DAY), lastFocusedAt: t(8 * DAY) });
  const projects = [APP, NOTES, SITE];
  for (let i = 0; i < 24; i++) {
    const n = 40 + i;
    const cwd = projects[i % 3];
    add(n, { title: x.oldChat(i + 1), cwd, originCwd: cwd, createdAt: t((40 + i) * DAY), lastActivityAt: t((35 + i) * DAY), lastFocusedAt: t((35 + i) * DAY),
      ...(i === 0 ? { isStarred: true } : {}), ...(i === 1 ? { autoArchiveExempt: true } : {}) });
  }
  // 片付け候補の親に、作業中の子がいる (おすすめから外れる)
  add(70, { title: x.oldParent, createdAt: t(60 * DAY), lastActivityAt: t(50 * DAY), lastFocusedAt: t(50 * DAY) });
  add(71, { title: x.fromParent, createdAt: t(30 * MIN), lastActivityAt: t(1 * MIN), lastFocusedAt: t(1 * MIN), spawnedFrom: { sessionId: sid(70), taskId: 'w' } });
  tr(71, tails.toolResult(w(2 * MIN, 10 * SEC)), 10 * SEC);
  // アーカイブ済み (表示しない。件数だけ)
  for (let i = 0; i < 3; i++) add(80 + i, { title: x.archived(i + 1), isArchived: true, createdAt: t(90 * DAY), lastActivityAt: t(80 * DAY) });
  return { raws, archivedIds: [sid(80)], transcripts, folderHints: { ...FOLDER_HINTS } };
}
