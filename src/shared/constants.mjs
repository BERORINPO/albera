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
export const OVERVIEW_SHELF_MAX = 60;
export const UI_STORAGE_KEY = 'pigeonholes:v1:ui';
export const DEEP_LINK_PREFIX = 'claude://claude.ai/epitaxy/';
export const GITHUB_URL_RE = /^https:\/\/github\.com\//;

// --- 文字数の上限 (code point 単位。切ったら末尾に「…」) ---
export const CAP = Object.freeze({
  TITLE: 200,
  BODY: 600,
  PARENT_TITLE: 40,
  CWD: 260,
  ERROR_SNIPPET: 80,
  RESET_SNIPPET: 40,
  RAW: 4000, // adapter が保持する生テキストの上限 (メモリ保護)
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
