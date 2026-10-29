// @ts-check
// adapter (Fake 用データ): `npm run demo` とテストで使う合成のセッションと会話ログ。
// 実際のセッションの title や報告は入れない。すべて作り物。パスは OS に依らない POSIX の文字列 (~/projects/...)。
// 中身の言語は端末の言語 (buildDemo の lang)。画面の言葉ではなく「中身」なので、この file は arch 6 の対象外。
// (v0.2) 会話ログは本物と同じ形の行 (usage・tool_use・計画・要約) で作る。していることの種類 15 個と、
// コンテキストの段階 (notice・due・soon)・要約の直後・200K の窓・Claude 自身の短い言葉 (Bash の説明と計画の手順) が全部出る。

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
const iso = (/** @type {number} */ at) => new Date(at).toISOString();

/**
 * 会話ログの 1 行に "timestamp" (ISO 文字列) を付ける。at が無ければそのまま返す。
 * @param {string} text JSON 1 行
 * @param {number|undefined} at ms
 */
export function stamp(text, at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return text;
  return JSON.stringify({ ...JSON.parse(text), timestamp: iso(at) });
}

/** 会話ログの 1 行を作る道具 (合成。adapter のテスト用の最小の形)。 */
export const synth = {
  /** @param {string} text @param {number} [at] 指示を送った時刻 (ms)。あれば timestamp を付ける */
  prompt: (text, at) => stamp(line({ type: 'user', message: { role: 'user', content: text } }), at),
  text: (/** @type {string} */ text, stop = 'end_turn') =>
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop } }),
  toolUse: () =>
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop_reason: 'tool_use' } }),
  toolResult: () => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
  stopHook: () => line({ type: 'system', subtype: 'stop_hook_summary' }),
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

/** よく使う末尾の形 (adapter のテスト用)。引数の Times を渡すと timestamp が付く。 */
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
};

// --- 本物と同じ形の行 (usage・tool_use・計画・要約)。中身・パス・コマンドは合成 ---

/** 窓の決まり方がそれぞれ違う model (board.md §5.2: [1m] 付き = 1M、系列の表で 1M、200K の推定)。 */
const MODEL = Object.freeze({ M1: 'claude-opus-4-7[1m]', OPUS: 'claude-opus-4-7', SONNET: 'claude-sonnet-4-5', HAIKU: 'claude-haiku-4-5' });
const PLAN_TOOL = 'mcp__ccd_turn__update_plan';

/**
 * usage を本物と同じ 4 項目に分ける (input + cache_creation + cache_read = used。output は数に入らない)。
 * @param {number} used
 */
function usage(used) {
  const input = Math.min(used, 6);
  const creation = Math.min(used - input, 1500);
  return { input_tokens: input, cache_creation_input_tokens: creation, cache_read_input_tokens: used - input - creation, output_tokens: 380 };
}

/**
 * 1 セッション分の行を作る道具。message.id と tool_use の id はセッションごとの通し番号 (合成)。
 * @param {number} n セッションの番号
 * @param {string} model
 */
function chat(n, model) {
  let k = 0;
  let toolId = '';
  /** @param {object[]} content @param {string|null} stop @param {number} used @param {number} at @param {string} id */
  const assistant = (content, stop, used, at, id) =>
    line({ type: 'assistant', isSidechain: false, timestamp: iso(at), message: { id, type: 'message', role: 'assistant', model, content, stop_reason: stop, usage: usage(used) } });
  return {
    /** @param {string} text @param {number} at */
    prompt: (text, at) => synth.prompt(text, at),
    /** tool_use の行。lead があれば同じ message.id の文の行を先に出す (本物は 1 回の呼び出しを複数の行に分ける)。
     * @param {string} name @param {object} input @param {number} used @param {number} at @param {string} [lead] */
    tool: (name, input, used, at, lead) => {
      const id = `msg_demo${n}_${++k}`;
      toolId = `toolu_demo${n}_${k}`;
      const use = assistant([{ type: 'tool_use', id: toolId, name, input }], 'tool_use', used, at, id);
      return lead ? `${assistant([{ type: 'text', text: lead }], null, used, at, id)}\n${use}` : use;
    },
    /** 直前の tool_use への結果。 @param {number} at */
    result: (at) => line({ type: 'user', isSidechain: false, timestamp: iso(at), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] } }),
    /** @param {string} text @param {number} used @param {number} at */
    say: (text, used, at) => assistant([{ type: 'text', text }], 'end_turn', used, at, `msg_demo${n}_${++k}`),
    /** @param {number} at */
    stop: (at) => line({ type: 'system', subtype: 'stop_hook_summary', timestamp: iso(at) }),
    /** @param {'auto'|'manual'} trigger @param {number} pre @param {number} post @param {number} at */
    compact: (trigger, pre, post, at) => line({ type: 'system', subtype: 'compact_boundary', timestamp: iso(at), compactMetadata: { trigger, preTokens: pre, postTokens: post } }),
  };
}

/**
 * @typedef {[string, object] | [string, object, string]} ToolCall  [名前, input, (同じ呼び出しの前置きの文)]
 * @typedef {'done'|'open'|'result'|'ask'} TurnEnd  done = 報告して終わった / open = 最後のツールが動いている /
 *   result = 最後のツールの結果を受け取ったところ / ask = 最後に ask のツールで返事を待っている
 * @typedef {{prompt: string, start: number, end: number, used: number, tools: ToolCall[], how: TurnEnd, done?: string, ask?: ToolCall}} TurnSpec
 */

/**
 * 1 ターン分の行。指示を start に送り、tools を順に使い、最後の行が end の時刻。
 * used は最後の API 呼び出しの量 (それより前の呼び出しは少しずつ少ない)。
 * @param {ReturnType<typeof chat>} c
 * @param {TurnSpec} o
 * @returns {string[]}
 */
function turn(c, o) {
  const calls = o.how === 'ask' && o.ask ? [...o.tools, o.ask] : o.tools;
  const apiCalls = calls.length + (o.how === 'done' ? 1 : 0);
  const step = Math.min(3000, Math.floor(o.used / (apiCalls * 4 + 1)));
  const usedAt = (/** @type {number} */ i) => o.used - (apiCalls - 1 - i) * step;
  /** @type {Array<(at: number) => string>} */
  const rest = [];
  calls.forEach(([name, input, lead], i) => {
    rest.push((at) => c.tool(name, input, usedAt(i), at, lead));
    const last = i === calls.length - 1;
    if (!last || o.how === 'done' || o.how === 'result') rest.push((at) => c.result(at));
  });
  if (o.how === 'done') {
    rest.push((at) => c.say(o.done ?? '', usedAt(apiCalls - 1), at));
    rest.push((at) => c.stop(at));
  }
  return [c.prompt(o.prompt, o.start), ...rest.map((f, j) => f(o.start + Math.round(((o.end - o.start) * (j + 1)) / rest.length)))];
}

/** 大きすぎる項目 (画面に出てはいけないもの) の見本 */
const HEAVY = {
  remoteMcpServersConfig: [{ name: 'demo-server', url: 'http://example.invalid/mcp', secretish: 'x'.repeat(64) }],
  promptAppendSnapshot: { text: 'p'.repeat(256) },
  enabledMcpTools: { demo: true },
  permissionMode: 'default',
};

// --- パス (POSIX の文字列。実在の場所ではない) ---
const HOME = '~';
const APP = '~/projects/demo-app';
const NOTES = '~/projects/notes';
const SITE = '~/projects/site';
const API = '~/projects/api-server';
const WORKTREE = '~/projects/demo-app/.claude/worktrees/fix-login';

/** デモの folder hints (fake-folder-hints に渡す合成の表)。 @type {Record<string, FolderHint>} */
const FOLDER_HINTS = {
  [APP]: { kind: 'repo', name: 'demo-app' },
  [NOTES]: { kind: 'repo', name: 'notes' },
  [SITE]: { kind: 'repo', name: 'site' },
  [API]: { kind: 'repo', name: 'api-server' },
  '~/projects': { kind: 'container' },
  [HOME]: { kind: 'container' },
};

/** @param {string} dir @param {string} name */
const file = (dir, name) => ({ file_path: `${dir}/${name}` });
/** @param {string} command @param {string} [description] */
const sh = (command, description) => (description ? { command, description } : { command });
/** @param {string[]} items @param {number} current 進行中の位置 (0 始まり) */
const planItems = (items, current) => ({ items: items.map((content, i) => ({ content, status: i < current ? 'completed' : i === current ? 'in_progress' : 'pending' })) });

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
    explain: 'Explain the failing build',
    archived: (/** @type {number} */ i) => `Archived ${i}`,
    // 会話ログの中身 (指示・報告・Claude 自身の短い言葉)
    go: 'Go ahead, please.',
    ask: 'Why does the build fail?',
    done: 'Done. Details are in the report.',
    searchLead: 'Now I will wire the search box into the header.',
    testNote: 'Run the unit tests',
    loginTest: 'Run the login tests',
    sortNote: 'Sort ~/projects/notes/inbox.md by date',
    buildNote: 'Build the server',
    steps: ['Read the parser', 'Write tests for the parser', 'Fix the edge cases'],
    todos: [
      { content: 'Write the release notes', activeForm: 'Writing the release notes' },
      { content: 'Tag the release', activeForm: 'Tagging the release' },
      { content: 'Announce the release', activeForm: 'Announcing the release' },
    ],
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
    explain: 'ビルドが失敗する理由を説明する',
    archived: (/** @type {number} */ i) => `アーカイブ済み ${i}`,
    go: '進めてください',
    ask: 'ビルドが失敗するのはなぜですか?',
    done: '終わりました。詳しくは報告に書きました。',
    searchLead: '検索ボックスをヘッダーにつなぎます。',
    testNote: '単体テストを実行',
    loginTest: 'ログインのテストを実行',
    sortNote: '~/projects/notes/inbox.md を日付順に並べ替え',
    buildNote: 'サーバーをビルド',
    steps: ['パーサーを読む', 'パーサーのテストを書く', '境界の場合を直す'],
    todos: [
      { content: 'リリースノートを書く', activeForm: 'リリースノートを書いています' },
      { content: 'タグを付ける', activeForm: 'タグを付けています' },
      { content: 'リリースを知らせる', activeForm: 'リリースを知らせています' },
    ],
  },
  zh: {
    config: '决定配置文件放在哪里',
    configDetail: '已准备好两个方案。',
    configAsk: '放在文件夹 A 还是文件夹 B?',
    wording: '确定演示界面的文案',
    colour: '商量按钮的颜色',
    colourAsk: '按钮用蓝色还是绿色?',
    tally: '汇总每周报告 (演示)',
    limit: '因用量上限而停下的演示',
    failed: '启动失败的演示',
    readme: '整理 README',
    readmeWrap: '分成了 4 个标题,把启动步骤缩成 3 行。还没有 commit。',
    login: '修复登录界面的缺陷',
    loginReport: '"[PR #12](https://github.com/demo-org/demo-app/pull/12) 已提交。21 项测试全部通过。 ⏎ 详情见这里"',
    search: '添加搜索框',
    background: '在后台调研',
    release: '发布准备 (演示)',
    changelog: '编写更新日志',
    version: '商量版本号怎么定',
    versionDetail: '有件事需要你决定。',
    versionAsk: '下一个版本用 1.1 还是 2.0?',
    deps: '检查依赖项',
    recent: ['确定设计配色', '整理笔记', '随手记', '调整页面边距', '表格排序'],
    routine: '【每日】检查失效链接 (演示)',
    merged: '删除旧功能 (已 merge)',
    buildFail: '构建一直失败',
    oldQuestion: '有个旧问题还没回答',
    oldQuestionDetail: '正在等你回复。',
    oldQuestionAsk: '就这样继续可以吗?',
    halfway: '中途放弃的调研',
    compress: '压缩图片',
    oldChat: (/** @type {number} */ i) => `旧对话 ${i}`,
    oldParent: '旧的父会话',
    fromParent: '从父会话开始的工作',
    explain: '说明构建失败的原因',
    archived: (/** @type {number} */ i) => `已归档 ${i}`,
    go: '请继续。',
    ask: '构建为什么会失败?',
    done: '完成了。详情见报告。',
    searchLead: '现在把搜索框接到页眉上。',
    testNote: '运行单元测试',
    loginTest: '运行登录测试',
    sortNote: '按日期排序 ~/projects/notes/inbox.md',
    buildNote: '构建服务器',
    steps: ['阅读解析器', '为解析器编写测试', '修复边界情况'],
    todos: [
      { content: '编写发布说明', activeForm: '正在编写发布说明' },
      { content: '打标签', activeForm: '正在打标签' },
      { content: '发布公告', activeForm: '正在发布公告' },
    ],
  },
};

/**
 * @param {number} n
 * @param {Record<string, unknown>} fields
 */
function raw(n, fields) {
  return { sessionId: sid(n), cliSessionId: cid(n), isArchived: false, cwd: APP, originCwd: APP, model: MODEL.M1, ...HEAVY, ...fields };
}

/**
 * 全バケットが少なくとも 1 件ずつ出るデモ盤面。
 * 返事待ち 4 / 止まったかも 3 / 未読 3 / 作業中 5 / 最近 7 (3 プロジェクト + フォルダなし) / 片付け候補 35 / アーカイブ済み 3。
 * プロジェクトは demo-app・notes・site・api-server の 4 つ (+ フォルダなし)。
 * @param {number} now
 * @param {string} [lang] 端末の言語 ('en' | 'ja' | 'zh')。それ以外は en
 * @returns {{raws: Array<Record<string, unknown>>, archivedIds: string[], transcripts: Map<string, TranscriptInput>, folderHints: Record<string, FolderHint>}}
 */
export function buildDemo(now, lang = 'en') {
  const x = lang === 'ja' || lang === 'zh' ? TEXT[lang] : TEXT.en;
  const t = (/** @type {number} */ ms) => now - ms;
  /** @type {Array<Record<string, unknown>>} */
  const raws = [];
  /** @type {Map<string, TranscriptInput>} */
  const transcripts = new Map();
  /** 会話ログ。mainAgo = 本体の最後の書き込み、subAgo = subagents の最後の書き込み (無ければ -1)、subLive = いま書かれている subagent の数 */
  const tr = (/** @type {number} */ n, /** @type {string[]} */ lines, /** @type {number} */ mainAgo, subAgo = -1, subLive = 0) => {
    const tail = [...lines, ''].join('\n');
    transcripts.set(cid(n), { tail, truncatedHead: false, mainMtime: t(mainAgo), subMtime: subAgo < 0 ? 0 : t(subAgo), subLive, size: tail.length });
  };
  /** 1 ターンだけの会話ログ。end の時刻が本体の最後の書き込み。 @param {number} n @param {string} model @param {Omit<TurnSpec, 'prompt'|'start'|'end'|'done'> & {from: number, to: number}} o */
  const one = (n, model, o, subAgo = -1, subLive = 0) =>
    tr(n, turn(chat(n, model), { ...o, prompt: x.go, done: x.done, start: t(o.from), end: t(o.to) }), o.to, subAgo, subLive);
  const add = (/** @type {number} */ n, /** @type {Record<string, unknown>} */ f) => raws.push(raw(n, f));

  // 返事待ち (待ち時間はそれぞれ違う: 2 時間 = 家族の子 / 50 分 = 質問文の無い ExitPlanMode / 20 分 = AskUserQuestion / 4 分)
  add(1, { title: x.config, createdAt: t(2 * HOUR), lastActivityAt: t(4 * MIN), lastFocusedAt: t(30 * MIN),
    postTurnSummary: { status_category: 'blocked', status_detail: x.configDetail, needs_action: x.configAsk } });
  one(1, MODEL.M1, { from: 10 * MIN, to: 4 * MIN, used: 140_000, tools: [['Read', file(APP, 'config/default.json')]], how: 'done' });
  add(2, { title: x.wording, cwd: NOTES, originCwd: NOTES, createdAt: t(5 * HOUR), lastActivityAt: t(50 * MIN), lastFocusedAt: t(50 * MIN) });
  one(2, MODEL.M1, { from: 70 * MIN, to: 50 * MIN, used: 220_000, tools: [['Glob', { pattern: '**/*.md' }]], how: 'ask', ask: ['ExitPlanMode', { plan: '' }] });
  add(19, { title: x.colour, createdAt: t(1 * HOUR), lastActivityAt: t(20 * MIN), lastFocusedAt: t(20 * MIN) });
  one(19, MODEL.M1, { from: 25 * MIN, to: 20 * MIN, used: 840_000, tools: [['Read', file(APP, 'src/theme.css')]], how: 'ask',
    ask: ['AskUserQuestion', { questions: [{ question: x.colourAsk, header: 'h', options: [] }] }] });
  // 止まっているかも (無音で止まった = 古い tool_use とコンテキストの限界 / 使用上限 / 起動失敗)
  add(3, { title: x.tally, createdAt: t(4 * HOUR), lastActivityAt: t(3 * HOUR), lastFocusedAt: t(4 * HOUR), contextExceededCount: 1 });
  one(3, MODEL.M1, { from: 3 * HOUR + 5 * MIN, to: 3 * HOUR, used: 940_000, how: 'open',
    tools: [['Read', file(APP, 'reports/weekly.csv')], ['WebFetch', { url: 'https://example.com/weekly-report' }]] });
  add(4, { title: x.limit, cwd: API, originCwd: API, createdAt: t(3 * HOUR), lastActivityAt: t(40 * MIN), error: "You've hit your session limit · resets 1:50pm", errorAt: t(40 * MIN) });
  one(4, MODEL.M1, { from: 45 * MIN, to: 40 * MIN, used: 850_000, how: 'result', tools: [['Grep', { pattern: 'limit' }], ['Read', file(API, 'docs/usage-notes.md')]] });
  add(5, { title: x.failed, cwd: API, originCwd: API, createdAt: t(20 * MIN), lastActivityAt: t(20 * MIN), error: "Git is installed but isn't working (demo).", errorAt: t(20 * MIN), errorCategory: 'git_startup_failed' });
  // 終わった・未読 (引き継ぎどき・PR 付き。定期実行の回は下の定期実行)
  add(6, { title: x.readme, createdAt: t(3 * HOUR), lastActivityAt: t(12 * MIN), lastFocusedAt: t(1 * HOUR), turnWrapUp: { description: x.readmeWrap } });
  one(6, MODEL.M1, { from: 30 * MIN, to: 12 * MIN, used: 820_000, how: 'done', tools: [['Read', file(APP, 'README.md')], ['Write', file(APP, 'README.md')]] });
  add(7, { title: x.login, cwd: WORKTREE, originCwd: APP, createdAt: t(6 * HOUR), lastActivityAt: t(25 * MIN), lastFocusedAt: t(2 * HOUR),
    branch: 'fix/login', worktreeName: 'fix-login', completedTurns: 6,
    prs: [{ prNumber: 12, repo: 'demo-org/demo-app', url: 'https://github.com/demo-org/demo-app/pull/12', state: 'OPEN' }],
    lastTurnReport: x.loginReport });
  one(7, MODEL.M1, { from: 40 * MIN, to: 25 * MIN, used: 410_000, how: 'done', tools: [
    ['Edit', file(WORKTREE, 'src/login.mjs')], ['Bash', sh('npm test', x.loginTest)], ['Bash', sh('gh pr create --fill')], ['mcp__ccd_turn__wrap_up', {}]] });
  // 作業中 (編集 = notice / バックグラウンドの subagent = due (終わってから引き継ぐ) / Git = 200K の窓 / テスト = 説明と計画の手順 / 考え中 = 要約の直後)
  add(8, { title: x.search, createdAt: t(40 * MIN), lastActivityAt: t(1 * MIN), lastFocusedAt: t(1 * MIN) });
  one(8, MODEL.M1, { from: 23 * MIN, to: 30 * SEC, used: 620_000, how: 'result', tools: [
    ['Read', file(APP, 'src/search.mjs')], ['Grep', { pattern: 'search' }], ['Edit', file(APP, 'src/search-box.mjs'), x.searchLead]] });
  add(9, { title: x.background, cwd: NOTES, originCwd: NOTES, createdAt: t(1 * HOUR), lastActivityAt: t(20 * MIN), lastFocusedAt: t(20 * MIN) });
  one(9, MODEL.M1, { from: 25 * MIN, to: 20 * MIN, used: 870_000, how: 'done', tools: [['Agent', { description: x.background, subagent_type: 'general-purpose' }]] }, 1 * MIN, 2);
  // 家族 (親 1・子 3): 親は最近 (計画の更新・まもなく要約)、子は作業中・返事待ち・最近 (フォルダ無し = 親から継承)
  add(10, { title: x.release, createdAt: t(1 * DAY), lastActivityAt: t(5 * HOUR), lastFocusedAt: t(4 * HOUR) });
  one(10, MODEL.M1, { from: 5 * HOUR + 10 * MIN, to: 5 * HOUR, used: 920_000, how: 'done',
    tools: [['TodoWrite', { todos: x.todos.map((d, i) => ({ ...d, status: i === 0 ? 'completed' : i === 1 ? 'in_progress' : 'pending' })) }]] });
  add(11, { title: x.changelog, model: MODEL.SONNET, createdAt: t(4 * HOUR), lastActivityAt: t(2 * MIN), lastFocusedAt: t(2 * MIN), spawnedFrom: { sessionId: sid(10), taskId: 'x' } });
  one(11, MODEL.SONNET, { from: 6 * MIN, to: 20 * SEC, used: 58_000, how: 'open', tools: [['Read', file(APP, 'CHANGELOG.md')], ['Bash', sh('git log --oneline -20')]] });
  add(12, { title: x.version, model: MODEL.SONNET, createdAt: t(4 * HOUR), lastActivityAt: t(2 * HOUR), lastFocusedAt: t(3 * HOUR), spawnedFrom: { sessionId: sid(10), taskId: 'y' },
    postTurnSummary: { status_category: 'blocked', status_detail: x.versionDetail, needs_action: x.versionAsk } });
  one(12, MODEL.SONNET, { from: 2 * HOUR + 15 * MIN, to: 2 * HOUR, used: 40_000, how: 'done', tools: [['Read', file(APP, 'package.json')]] });
  add(13, { title: x.deps, cwd: '', originCwd: '', createdAt: t(4 * HOUR), lastActivityAt: t(3 * HOUR), lastFocusedAt: t(2 * HOUR), spawnedFrom: { sessionId: sid(10), taskId: 'z' } });
  one(13, MODEL.M1, { from: 3 * HOUR + 10 * MIN, to: 3 * HOUR, used: 150_000, how: 'done', tools: [['Grep', { pattern: 'TODO' }], ['Glob', { pattern: '**/package.json' }]] });
  // 最近 (読んだ。demo-app・notes・site と、home で開いた会話 = フォルダなし)。種類と窓はそれぞれ違う
  /** @type {Array<{cwd: string, model: string, used: number, tools: ToolCall[]}>} */
  const recent = [
    { cwd: APP, model: MODEL.M1, used: 300_000, tools: [['mcp__playwright__browser_take_screenshot', {}]] },
    { cwd: NOTES, model: MODEL.SONNET, used: 90_000, tools: [['Read', file(NOTES, 'inbox.md')], ['Bash', sh('npm run sort', x.sortNote)]] },
    { cwd: HOME, model: MODEL.HAIKU, used: 110_000, tools: [['ToolSearch', { query: 'calendar' }]] },
    { cwd: SITE, model: MODEL.M1, used: 70_000, tools: [['WebSearch', { query: 'css margin collapse' }]] },
    { cwd: APP, model: MODEL.OPUS, used: 500_000, tools: [['Read', file(APP, 'data/table.csv')]] },
  ];
  x.recent.forEach((title, i) => {
    const n = 14 + i;
    const d = i + 1;
    const r = recent[i];
    add(n, { title, cwd: r.cwd, originCwd: r.cwd, model: r.model, createdAt: t(d * DAY + HOUR), lastActivityAt: t(d * DAY), lastFocusedAt: t(d * DAY - MIN) });
    const c = chat(n, r.model);
    // 1 件目は、前のターンで自動要約が済んでいる (要約点を tail から学ぶ。要約の直後ではない)
    const earlier = i === 0
      ? [...turn(c, { prompt: x.go, start: t(d * DAY + 40 * MIN), end: t(d * DAY + 30 * MIN), used: 940_000, tools: [['Edit', file(APP, 'src/colours.css')]], how: 'done', done: x.done }),
        c.compact('auto', 965_000, 61_000, t(d * DAY + 20 * MIN))]
      : [];
    tr(n, [...earlier, ...turn(c, { prompt: x.go, done: x.done, start: t(d * DAY + 10 * MIN), end: t(d * DAY), used: r.used, tools: r.tools, how: 'done' })], d * DAY);
  });
  // 定期実行 (5 回。最新は未読、古い 4 回は片付け候補。そのうち 2 回はツールの途中で止まった)
  for (let i = 0; i < 5; i++) {
    const n = 20 + i;
    const ago = i * DAY + 2 * HOUR;
    add(n, { title: x.routine, model: MODEL.HAIKU, scheduledTaskId: 'demo-daily-link-check', cwd: NOTES, originCwd: NOTES, createdAt: t(ago + 10 * MIN), lastActivityAt: t(ago) });
    one(n, MODEL.HAIKU, { from: ago + (i === 1 || i === 3 ? 5 : 10) * MIN, to: ago, used: 30_000 + i * 1000, how: i === 1 || i === 3 ? 'open' : 'done', tools: [['mcp__link-checker__check_links', {}]] });
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
  const projects = [APP, NOTES, SITE, API];
  for (let i = 0; i < 24; i++) {
    const n = 40 + i;
    const cwd = projects[i % projects.length];
    add(n, { title: x.oldChat(i + 1), cwd, originCwd: cwd, createdAt: t((40 + i) * DAY), lastActivityAt: t((35 + i) * DAY), lastFocusedAt: t((35 + i) * DAY),
      ...(i === 0 ? { isStarred: true } : {}), ...(i === 1 ? { autoArchiveExempt: true } : {}) });
  }
  // 片付け候補の親に、作業中の子がいる (おすすめから外れる)。子はテストの実行中 (Bash の説明と計画の手順つき、窓は系列の表で 1M と推定)
  add(70, { title: x.oldParent, createdAt: t(60 * DAY), lastActivityAt: t(50 * DAY), lastFocusedAt: t(50 * DAY) });
  add(71, { title: x.fromParent, model: MODEL.OPUS, createdAt: t(30 * MIN), lastActivityAt: t(1 * MIN), lastFocusedAt: t(1 * MIN), spawnedFrom: { sessionId: sid(70), taskId: 'w' } });
  one(71, MODEL.OPUS, { from: 2 * MIN, to: 10 * SEC, used: 120_000, how: 'open', tools: [
    [PLAN_TOOL, planItems(x.steps, 0)], ['Read', file(APP, 'src/parser.mjs')], [PLAN_TOOL, { advance: true }],
    ['Edit', file(APP, 'test/parser.test.mjs')], ['Bash', sh('npm test', x.testNote)]] });
  // 作業中: 手で要約 (/compact) した直後に質問を送ったところ (ツールはまだ無い = 考え中)。量は要約の後の数
  add(72, { title: x.explain, cwd: API, originCwd: API, createdAt: t(3 * HOUR), lastActivityAt: t(15 * SEC), lastFocusedAt: t(15 * SEC) });
  const c72 = chat(72, MODEL.M1);
  tr(72, [
    ...turn(c72, { prompt: x.go, done: x.done, start: t(50 * MIN), end: t(45 * MIN), used: 610_000, how: 'done', tools: [['Bash', sh('npm run build', x.buildNote)]] }),
    c72.compact('manual', 610_000, 38_000, t(1 * MIN)),
    c72.prompt(x.ask, t(15 * SEC)),
  ], 15 * SEC);
  // アーカイブ済み (表示しない。件数だけ)
  for (let i = 0; i < 3; i++) add(80 + i, { title: x.archived(i + 1), isArchived: true, createdAt: t(90 * DAY), lastActivityAt: t(80 * DAY) });
  return { raws, archivedIds: [sid(80)], transcripts, folderHints: { ...FOLDER_HINTS } };
}
