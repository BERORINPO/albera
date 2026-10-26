// @ts-check
// shared: しきい値・識別子・コードの registry。何も import しない。言葉は持たない
// (画面の言葉は public/dict-*.mjs、端末の言葉は src/entry/messages.mjs)。
// ブラウザにも /src/shared/constants.mjs として同じファイルを配信する (サーバーと画面で値がずれないように)。

// 名前・ロゴ・題名に "Claude" を入れない (非公式の道具なので)
export const PRODUCT = Object.freeze({ name: 'Pigeonholes', bin: 'pigeonholes' });

export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

// --- 分類のしきい値 (spec/board.md §3) ---
export const RECENT_MS = 7 * DAY; // 「最近」の窓。全バケット共通の 1 本だけ
export const QUIET_MS = 15 * MIN; // 作業中とみなす最大の無音時間。バックグラウンドの新しさにも使う
export const START_GRACE_MS = 10 * MIN; // pendingFirstStart の猶予
export const ERROR_CURRENT_MS = 60 * SEC; // errorAt >= lastActivityAt - これ ならエラーが最新の出来事
export const UNREAD_SKEW_MS = 2 * SEC;
export const BG_LEAD_MS = 5 * SEC; // subagent の書き込みが本体より後であること
export const RETRY_WINDOW_MS = 24 * HOUR;
export const PR_DONE_IDLE_MS = 24 * HOUR;
export const IDLE_SAFE_MS = 30 * DAY;
// 形式の異常検知: 日時の無いレコードの割合がこれを超えたら形式を疑う (非アーカイブが MIN 件以上のときだけ)
export const FORMAT_SUSPECT_RATIO = 0.2;
export const FORMAT_SUSPECT_MIN = 5;

// --- 読み込み ---
export const TAIL_BYTES = 200 * 1024;
export const TAIL_RETRY_BYTES = 2 * 1024 * 1024; // 該当行が 0 件なら 1 回だけこの大きさで読み直す
export const SUBAGENT_SCAN_MAX = 2000; // 1 セッションあたりの走査エントリ上限
export const SUBAGENT_SCAN_DEPTH = 4;
export const TRANSCRIPT_MAP_TTL_MS = 30 * SEC;
export const MISSING_REBUILD_MS = 3 * SEC; // 表に無い ID を頼まれたら、前回からこれだけ空けて作り直す
export const BOARD_CACHE_MS = 2 * SEC;
export const READ_CONCURRENCY = 8;
// folder hints (adapter が実際のフォルダの .git を見る)
export const FOLDER_WALK_MAX = 8; // .git を探して上に何階層たどるか
export const FOLDER_CHILD_SCAN_MAX = 200; // 「まとめフォルダ」判定で見る子フォルダの上限
export const FOLDER_HINT_TTL_MS = 5 * MIN; // フォルダの判定結果のキャッシュ
export const FOLDER_HINT_CACHE_MAX = 2000; // キャッシュの件数上限 (古いものから捨てる)
export const FOLDER_HINT_TIMEOUT_MS = 500; // 1 つのフォルダの判定をこれ以上待たない (届かないネットワークドライブで盤面を止めない)

// --- サーバー ---
export const DEFAULT_PORT = 8797;
export const DEMO_REBUILD_MS = MIN; // デモの合成データを今の時刻から作り直す間隔 (起動時の時刻のままだと作業中が止まったかもへ移っていく)

// --- 画面 (spec/ui.md) ---
export const POLL_MS = 5 * SEC;
export const HIDDEN_POLL_MS = 60 * SEC; // 通知 ON でタブが隠れているとき
export const FETCH_TIMEOUT_MS = 4 * SEC;
export const FIRST_FETCH_TIMEOUT_MS = 20 * SEC; // 初回は全件スキャンで約 3 秒かかるため長めに待つ
export const STALE_AFTER_MS = 15 * SEC; // 最後に取得できてからこれだけ経ったら「古い内容」と出す
export const NEW_BADGE_MS = 60 * SEC;
export const QUIET_HINT_MS = 5 * MIN; // 作業中の行で、これより長く書き込みが無ければ控えめに知らせる
export const COPIED_LABEL_MS = 2500; // 「コピーしました」のラベルを出しておく時間
export const FILTER_ANNOUNCE_MS = 700; // 絞り込みの文字を打ち終えてから一致数を読み上げるまで
export const SKIP_EXPLAIN_MS = 2 * MIN; // 最後のコピーからこれだけ経っても残っていれば、飛ばされた理由を説明する
export const COPY_CHUNK = 50;
export const PREVIEW = Object.freeze({ unread: 8, working: 8, recentGroup: 5 }); // 最初に見せる件数。超えたら「他 N 件を表示」
export const PAGE_SIZE = 20;
export const MAX_PRS = 10;
export const MAX_PR_BADGES = 2;
export const UI_STORAGE_KEY = 'pigeonholes:v1:ui';
export const DEEP_LINK_PREFIX = 'claude://claude.ai/epitaxy/';
export const GITHUB_URL_RE = /^https:\/\/github\.com\//;
export const COMPACT_SHOW_MS = 1 * HOUR; // 「要約済み」を行に出す時間
// 引き継ぎ (spec/ui.md §9): ボタンを出すのは動きが 24 時間以内、コピーの記録は 24 時間、+5 ポイントで出し直す
export const HANDOFF = Object.freeze({ ROW_MS: 24 * HOUR, COPIED_MS: 24 * HOUR, REARM_PCT: 5 });
// キャンバス (spec/ui.md §10)。大きさは world の単位 (100% の CSS px)。PAD・HEAD_ROOM・PAN_STEP・DRAG_SLOP・REVEAL_MARGIN・NARROW_PX は画面の px
// SLIP_W: 62% で 16px の題名が 2 行に収まる幅。BACK_HEAD: 用紙の帯 (「最近 N」「片付け N」の 1 行だけ)。FOLD_ROW: 片付けだけのプロジェクトの 1 行。
// GAP_Y: 用紙の上の柱が入る間 (遠くの 1 行の柱は 20% まで収まる)
export const CANVAS = Object.freeze({
  SLIP_W: 432,
  SLIP_H: 176,
  SLIP_H_MIN: 96,
  SLIP_H_MAX: 320,
  BACK_HEAD: 44,
  FOLD_ROW: 40,
  FOOT_H: 8,
  GAP_X: 96,
  GAP_Y: 120,
  COLS_MIN: 1,
  COLS_MAX: 6,
  Z_MIN: 0.15,
  Z_MAX: 1.5,
  Z_STEPS: Object.freeze([0.15, 0.2, 0.3, 0.45, 0.62, 0.8, 1, 1.25, 1.5]),
  Z_OPEN: 0.62,
  LEVEL_MID: 0.6,
  LEVEL_NEAR: 1,
  PAD_WIDE: 40,
  PAD_NARROW: 12,
  HEAD_ROOM: 56,
  PAN_STEP: 80,
  PAN_STEP_BIG: 400,
  NUDGE: 32,
  SNAP: 8,
  DRAG_SLOP: 4,
  REVEAL_MARGIN: 24,
  NARROW_PX: 640,
  SEAT_KEEP_MS: 7 * DAY,
});
export const CANVAS_STORAGE_KEY = 'pigeonholes:v1:canvas'; // キャンバスの席 (画面の localStorage だけ)

// --- 文字数の上限 (code point 単位。切ったら末尾に「…」) ---
export const CAP = Object.freeze({
  TITLE: 200,
  BODY: 600,
  PARENT_TITLE: 40,
  ERROR_SNIPPET: 80,
  RESET_SNIPPET: 40,
  RAW: 4000, // adapter が保持する生テキストの上限 (メモリ保護)
  MODEL: 80, // SessionRecord.model (窓を決めるためだけ。JSON には出さない)
  ACT_TARGET: 32, // Card.activity.target (basename・commandHead・ホスト・コネクタ名)
  ACT_TEXT: 40, // Card.activity.note / step (Claude 自身の短い言葉、cleanText 済み)
});
export const FAMILY_MAX_DEPTH = 10;
export const PROJECT_PARENT_MAX_DEPTH = 5;

// --- 識別子 ---
export const SESSION_ID_RE = /^local_[0-9a-f-]{36}$/;
// 利用者の返事を待つツール。tool_result がまだ無ければ「あなたの返事待ち」に出す
export const ASK_TOOLS = Object.freeze(['AskUserQuestion', 'ExitPlanMode']);
export const CLI_SESSION_ID_RE = /^[0-9a-f-]{36}$/i;

// --- バケット (上から固定順)。名前と動詞は画面の辞書 (bucket.<key>.*) が持つ ---
// tone は画面では使わない (色で状態を分けない)。recent だけ既定で閉じる
export const BUCKETS = Object.freeze([
  Object.freeze({ key: 'needs_you', tone: 'orange', defaultOpen: true }),
  Object.freeze({ key: 'trouble', tone: 'red', defaultOpen: true }),
  Object.freeze({ key: 'unread', tone: 'blue', defaultOpen: true }),
  Object.freeze({ key: 'working', tone: 'green', defaultOpen: true }),
  Object.freeze({ key: 'recent', tone: 'gray', defaultOpen: false }),
  Object.freeze({ key: 'cleanup', tone: 'gray', defaultOpen: true }),
]);
export const ACTION_BUCKETS = Object.freeze(['needs_you', 'trouble', 'unread']);

// --- 片付け候補の理由 (固定順)。名前は画面の辞書 (cleanup.<key>) が持つ ---
export const CLEANUP_REASONS = Object.freeze([
  Object.freeze({ key: 'retried', recommended: true }),
  Object.freeze({ key: 'routine_old', recommended: true }),
  Object.freeze({ key: 'pr_done', recommended: true }),
  Object.freeze({ key: 'old_error', recommended: false }),
  Object.freeze({ key: 'old_question', recommended: false }),
  Object.freeze({ key: 'idle_30d', recommended: true }),
  Object.freeze({ key: 'idle_7d', recommended: false }),
]);
export const CLEANUP_SUBGROUP_THRESHOLD = 20; // 理由グループの行がこれを超えたらプロジェクト別に分ける

// おすすめから外す条件のコード (この順に試し、最初に当たったものを cleanup.note に出す)。文は画面の辞書 (note.<code>)
export const CLEANUP_NOTES = Object.freeze(['open_pr', 'exempt', 'starred', 'unread', 'child']);

// フォルダの決まらない会話のまとまり。label は null で送り、画面が「フォルダなし」と書く
export const OTHER_PROJECT = Object.freeze({ key: '(other)' });

// 画面に出してはいけない項目 (テストと smoke で検査に使う)。folders は adapter 内部の手掛かり
export const FORBIDDEN_OUTPUT_KEYS = Object.freeze([
  'remoteMcpServersConfig',
  'promptAppendSnapshot',
  'enabledMcpTools',
  'sessionPermissionUpdates',
  'toolSurfaceSnapshot',
  'alwaysAllowedReasons',
  'backgroundTaskSuggestions',
  'sideSessionNotes',
  'spawnSeed',
  'permissionMode',
  'folders',
]);
// /api/board の JSON にだけ無いこと (model と contextExceededCount は SessionRecord にはある)。
// 'state' はここに入れない: prs[] の要素の中 (Card.prs[i].state・reasonParams.prs[i].state) だけ許す (テストが木を歩いて調べる)
export const FORBIDDEN_WIRE_KEYS = Object.freeze([
  'model',
  'command',
  'input',
  'file_path',
  'notebook_path',
  'description',
  'usage',
  'compactMetadata',
  'todos',
  'contextExceededCount',
  'cwd',
  'gitDir',
  'commonDir',
  'worktreePath',
  'lockedReason',
  'porcelain',
]);

// --- v0.2: していること・コンテキスト (spec/board.md §5.1・§5.2)。言葉は持たない (doing.* / ctx.* は画面の辞書) ---
export const ACTIVITY_KINDS = Object.freeze([
  'edit', 'write', 'read', 'search', 'run', 'test', 'git', 'web', 'browser', 'connector', 'agents', 'plan', 'wrap_up', 'think', 'tool',
]);
// commandHead が 2・3 つ目の単語を残すプログラム (それ以外はプログラム名だけ)
export const COMMAND_RUNNERS = Object.freeze([
  'npm', 'pnpm', 'yarn', 'bun', 'npx', 'node', 'deno', 'python', 'py', 'uv', 'pip', 'pytest', 'cargo', 'go', 'git', 'gh', 'make', 'dotnet', 'docker', 'mvn', 'gradle',
]);
export const CONTEXT = Object.freeze({
  WINDOW_BASE: 200_000,
  WINDOW_LARGE: 1_000_000,
  PROOF_USED: 200_000, // maxUsed がこれを超えたら 1M (200K の窓では起きない)
  PROOF_PRE: 210_000, // 自動要約の preTokens がこれを超えたら 1M、以下なら 200K
  COMPACT_AT_BASE: 167_000, // 200K の自動要約点。推定 (spec/board.md §15)
  COMPACT_AT_LARGE: 967_000,
  LEARN_MIN: 100_000, // autoPre を要約点として使う下限
  // 段階は自動要約点に対する割合 f で決める。上がるときは enter、下がるときは enter − BAND まで同じ段階にとどまる
  LEVELS: Object.freeze([
    Object.freeze({ key: 'notice', enter: 0.6 }),
    Object.freeze({ key: 'due', enter: 0.83 }),
    Object.freeze({ key: 'soon', enter: 0.93 }),
  ]),
  BAND: 0.05,
  RESET_DROP: 0.3, // used が前回からこれより大きく減ったら前回の段階を持ち越さない
});
// 1M が標準の系列。2026-10-18 に docs の model-config で確認: Fable、Sonnet 5 以降、Haiku 5.5 以降、Opus 4.7 以降。
// [1m] を除いて小文字にした model (modelBase) に使う。系列が増えたら日付つきのコメントと一緒に直す
export const ONE_M_MODEL_RE = /(?:^|[./:])claude-(?:fable|sonnet-(?:[5-9]|[1-9]\d)|haiku-(?:5-(?:[5-9]|[1-9]\d)|[6-9]|[1-9]\d)|opus-(?:4-(?:[7-9]|[1-9]\d)|[5-9]|[1-9]\d))(?![0-9])/;
export const FACTS_CACHE_MAX = 2000; // entry が持つ tail 解析結果 (TailFacts) の memo の件数上限 (古いものから捨てる)
