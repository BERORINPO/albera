// @ts-check
// shared: 型の契約 (JSDoc のみ)。何も import しない。
// /api/board v2 は「コードは送るが言葉は送らない」(spec/board.md §10)。

/**
 * adapter が実際のフォルダを見て決めた、プロジェクト判定の手掛かり (core の判定にだけ使い、JSON には出さない)。
 * repo = そのパスは git の作業フォルダの中 (name はそのフォルダ名)。
 * container = 複数の repo をまとめて置くフォルダ (home など)。このパスからはプロジェクトを決めない。
 * @typedef {{kind: 'repo', name: string} | {kind: 'container'}} FolderHint
 */

/**
 * adapter が元の JSON から許可した項目だけを射影したもの。
 * @typedef {Object} SessionRecord
 * @property {string} sessionId            "local_<uuid>"
 * @property {'codex'|'copilot'|'opencode'=} source   CLI adapter の安全な source code
 * @property {'wsl'=} executionLocation WSL share 経由と確認できた実行場所
 * @property {string=} cliSessionId        会話ログ (jsonl) のファイル名
 * @property {string=} title
 * @property {string=} cwd
 * @property {string=} originCwd
 * @property {string=} worktreeName
 * @property {string=} branch
 * @property {number=} createdAt
 * @property {number=} lastActivityAt
 * @property {number=} lastFocusedAt
 * @property {boolean} isArchived
 * @property {boolean} isStarred
 * @property {boolean} autoArchiveExempt
 * @property {number=} completedTurns
 * @property {string=} scheduledTaskId
 * @property {{status_category?: string, status_detail?: string, needs_action?: string}=} postTurnSummary
 * @property {string=} postTurnSummaryFor
 * @property {string=} lastAssistantUuid
 * @property {string=} turnWrapUpDescription
 * @property {string=} lastTurnReport
 * @property {boolean} interruptedAwaitingPerson  元が null 以外なら true
 * @property {Array<{prNumber?: number, repo?: string, url?: string, state?: string}>} prs
 * @property {number=} prNumber
 * @property {string=} prRepository
 * @property {string=} prState
 * @property {string=} prUrl
 * @property {string=} spawnedFromId
 * @property {string=} forkedFromSessionId
 * @property {string=} dispatchParentId
 * @property {string=} error
 * @property {number=} errorAt
 * @property {string=} errorCategory
 * @property {{since: (number|null)}|null} pendingFirstStart
 * @property {{origin?: FolderHint, cwd?: FolderHint}=} folders  originCwd / cwd の手掛かり (attachFolders が付ける)。無い = 手掛かりなし
 * @property {string=} model                 (v0.2) CAP.MODEL まで。コンテキストの窓を決めるためだけに使い、JSON には出さない
 * @property {number=} contextExceededCount  (v0.2) 0 以上の整数。1 以上なら Card.detail.contextExceeded に出す
 * @property {{status:'active'|'complete'|'interrupted'|'unknown',startedAt?:number}=} lifecycle
 * @property {Array<{type:'turn_started'|'turn_completed'|'turn_aborted'|'turn_failed',at:number}>=} events
 * @property {GitWorktreeSummary=} gitWorktree  Git adapter が返す、パスを含まない作業状態の要約
 */

/** @typedef {{branch:string|null,status:'clean'|'changed'|'untracked'|'mixed'|'conflicted'|'unknown',changed:number,untracked:number,conflicted:number,locked:boolean,prunable:boolean}} GitWorktreeSummary */

/**
 * 会話ログの末尾 (adapter が返す生の材料。解釈は core)。
 * @typedef {Object} TranscriptInput
 * @property {string} tail           末尾の生テキスト
 * @property {boolean} truncatedHead 先頭行が途中から始まっている (ファイル全体を読んでいない)
 * @property {number} mainMtime      本体 jsonl の mtime
 * @property {number} subMtime       subagents 配下で一番新しいファイルの mtime (無ければ 0)
 * @property {number} size
 * @property {number} subLive       (v0.2) subagents 配下で、本体の最後の書き込みより後かつ QUIET_MS 以内に書かれた *.jsonl の数 (計算しなかったときは 0)
 */

/**
 * @typedef {'ended'|'inprogress'|'asking'|'unknown'} TurnState  asking = 質問ツール (AskUserQuestion など) の返事待ち
 * @typedef {'question'|'plan'} AskKind  question = AskUserQuestion、plan = ExitPlanMode
 * @typedef {Object} TurnResult
 * @property {TurnState} turn
 * @property {'tool'|'prompt'=} lastKind
 * @property {'interrupted'=} how
 * @property {string=} question     asking: 質問文 (CAP.BODY まで)。ツールの入力に無ければ ''
 * @property {AskKind=} askKind     asking: どのツールが返事を待っているか
 * @property {number=} startedAt    inprogress: 今のターンを始めた指示の行の timestamp (ms)。分からなければ無い
 * @property {number} relevant      読めた行の数
 */

/**
 * @typedef {'en'|'ja'} Lang
 * @typedef {'needs_you'|'trouble'|'unread'|'working'|'recent'|'cleanup'} BucketKey
 * @typedef {'waiting'|'stopped'|'stalled'|'ended'|'updated'|'ago'|'latest'} TimeKind
 * @typedef {'asking'|'asks'|'stalled'|'git_startup'|'not_started'|'limit'|'error'|'unread'|'turn'|'background'|'starting'
 *   |'recent'|'routine_old'|'retried'|'old_error'|'old_question'|'pr_done'|'idle_30d'|'idle_7d'} ReasonCode
 * @typedef {'open_pr'|'exempt'|'starred'|'unread'|'child'} NoteCode
 * @typedef {null|'no_timestamps'|'no_session_files'} FormatSuspect
 */

/**
 * 理由の変数。その reason に関係するキーだけが入る (変数の無い reason では reasonParams ごと省く)。
 * @typedef {Object} ReasonParams
 * @property {AskKind=} ask                    asking: どのツールが待っているか (body が '' のとき画面がこれで文を作る)
 * @property {'prompt'|'tool'=} via            stalled: transcript の最後にあったもの
 * @property {string=} reset                   limit: アプリの文の "resets ..." 以降 (CAP.RESET_SNIPPET まで。無ければ省く)
 * @property {string=} error                   error / old_error: アプリのエラー文 (CAP.ERROR_SNIPPET まで)
 * @property {string=} question                old_question: needs_action か status_detail (CAP.ERROR_SNIPPET まで。空なら省く)
 * @property {number=} older                   routine_old: 片付け候補に入った回の数
 * @property {number=} total                   routine_old: 非アーカイブの回の数
 * @property {BucketKey=} latestBucket         routine_old: 最新回が片付け候補以外にいるときだけ
 * @property {Array<{num: number, repo: string, state: string}>=} prs  pr_done: 紐づけた順の先頭 2 件
 * @property {number=} more                    pr_done: その 2 件より後ろの PR の数 (1 以上のときだけ)
 */

/**
 * 画面に送るカード (文字列は CAP で切ってある)。
 * @typedef {Object} Card
 * @property {string} id
 * @property {'codex'|'copilot'|'opencode'=} source
 * @property {Array<{type:'turn_started'|'turn_completed'|'turn_aborted'|'turn_failed',at:number}>=} events
 * @property {BucketKey} bucket
 * @property {ReasonCode} reason
 * @property {ReasonParams=} reasonParams
 * @property {string} title
 * @property {string} body          中身だけ。trouble と、質問文の無い asking は ''
 * @property {number} since
 * @property {TimeKind} timeKind
 * @property {number=} startedAt    working / turn: 今のターンが始まった時刻 (分からなければ無い)
 * @property {number} lastActivityAt
 * @property {number|null} createdAt
 * @property {{key: string, label: string|null, extra: number}} project  label null = フォルダなし ('(other)')
 * @property {Array<{num: number, repo: string, state: string, url: string|null}>} prs  state はコード (OPEN / MERGED / CLOSED、それ以外は生のまま)
 * @property {{id: string, runs: number, completed: number, stalled: number, latestBucket: BucketKey, runIds?: string[]}=} routine
 * @property {{rootId?: string, parentId?: string, parentTitle?: string|null, children?: {total: number, working: number, needs_you: number, trouble: number, unread: number}}=} family
 * @property {{executionLocation?:'wsl', statusDetail?: string, branch?: string, worktreeName?: string, gitWorktree?: GitWorktreeSummary, completedTurns?: number, error?: string, prsMore?: number, contextExceeded?: number}} detail
 *   prsMore = 一覧に載せきれなかった PR の数。contextExceeded (v0.2) = SessionRecord.contextExceededCount (1 以上のときだけ、片付けには付かない)
 * @property {{recommended: boolean, note?: NoteCode}=} cleanup
 * @property {Activity=} activity   (v0.2) 最近で transcript があるときだけ。返事待ちと片付けには付かない
 * @property {Context=} context     (v0.2) 最近で transcript があるときだけ。片付けには付かない。stats.contextSuspect なら全部外す
 */

/**
 * v0.2: していること (spec/board.md §5.1)。コードと短い安全な文字列だけ。言葉は画面 (doing.*)。
 * @typedef {'edit'|'write'|'read'|'search'|'run'|'test'|'git'|'web'|'browser'|'connector'|'agents'|'plan'|'wrap_up'|'think'|'tool'} ActivityKind
 * @typedef {Object} Activity
 * @property {ActivityKind} kind
 * @property {string=} target   basename・commandHead・ホスト・コネクタ名 (CAP.ACT_TARGET)
 * @property {number=} n        kind agents: 動いている subagent の transcript の数 (subLive)
 * @property {string=} note     Claude 自身の短い説明 (Bash / PowerShell の description、cleanText 済み、CAP.ACT_TEXT)
 * @property {string=} step     計画の進行中の手順 (cleanText 済み、CAP.ACT_TEXT)
 * @property {boolean} live     作業中のカードだけ true
 * @property {number=} at       その tool の行の時刻 (ms)
 */

/**
 * v0.2: コンテキスト (spec/board.md §5.2)。
 * @typedef {'notice'|'due'|'soon'} ContextLevel
 * @typedef {Object} Context
 * @property {number} used              最後の実際の API 呼び出しの input + cache_creation + cache_read (要約の直後は postTokens)
 * @property {200000|1000000} window
 * @property {boolean} inferred         true = 窓は推定 (画面は「約」/ "~")
 * @property {number} pct               min(100, floor(used / window × 100))
 * @property {number} compactAt         自動要約が起きると見込む量
 * @property {ContextLevel=} level      要約の直後は無い
 * @property {{at: number, trigger: 'auto'|'manual'}=} compacted  tail の中で一番新しい要約
 */

/**
 * v0.2: core の中間結果 (memo できる。now を使わない)。transcript の生のオブジェクトは入れない。
 * @typedef {{kind: ActivityKind, target?: string, note?: string, step?: string, at?: number} | null} ActivityFacts
 * @typedef {Object} ContextFacts
 * @property {{i: number, n: number, at?: number}=} lastUsage   i = entries の中の位置 (要約の直後かは位置で比べる)
 * @property {number} maxUsed
 * @property {number=} autoPre          一番新しい自動要約の preTokens
 * @property {{i: number, at?: number, trigger: 'auto'|'manual', pre?: number, post?: number}=} lastBoundary
 * @property {boolean} hasAssistant     本筋の合成でない assistant 行がある (contextSuspect の分母)
 * @typedef {{turn: TurnResult, activity: ActivityFacts, context: ContextFacts}} TailFacts
 * @typedef {{cli: string, level?: ContextLevel, used: number}} PrevContext  前回の盤面の段階 (entry がメモリに持つ)
 */

/**
 * @typedef {Object} ProjectGroup
 * @property {string} key
 * @property {string|null} label     null = フォルダなし
 * @property {number} lastActivityAt
 * @property {number} count
 * @property {number} recommendedCount
 * @property {Card[]} items
 */

/**
 * @typedef {Object} CleanupGroup
 * @property {ReasonCode} reason
 * @property {boolean} recommendedReason  この理由がおすすめに入る理由か
 * @property {number} count               セッション数 (定期実行の 1 行 = runIds の数)
 * @property {number} recommendedCount
 * @property {Card[]=} items              20 行以下のとき
 * @property {ProjectGroup[]=} projects   20 行を超えたとき
 */

/**
 * GET /api/board の本文 (v2)。
 * @typedef {Object} Board
 * @property {2} v
 * @property {number} generatedAt
 * @property {number} serverNow
 * @property {{needs_you: number, trouble: number, unread: number, working: number, recent: number, cleanup: number, recommended: number, active: number, archived: number}} counts
 * @property {{needs_you: Card[], trouble: Card[], unread: Card[], working: Card[]}} buckets
 * @property {Array<{key: string, label: string|null, items: Card[]}>} recentGroups
 * @property {CleanupGroup[]} cleanupGroups
 * @property {Record<string, {title: string, memberIds: string[]}>} families
 * @property {{files: number, parsed: number, bad: number, stale: number, archived: number, active: number, recentTotal: number,
 *   transcriptsMissingRecent: number, unknownTurnRecent: number, recentWithTranscript: number, transcriptsDirMissing: boolean,
 *   scanMs: number, formatSuspect: FormatSuspect, demo: boolean, contextSeen: number, activitySeen: number, contextSuspect: boolean,
 *   sources?: Record<string, {files:number, detected:number, working:number, trouble:number, recent:number, active:number, completed:number, interrupted:number, failed:number, unknown:number, rejected:number}>,
 *   worktrees?: {scanned:number,matched:number,unavailable:number,skipped:number}} stats
 *   contextSeen / activitySeen / contextSuspect は v0.2 (spec/board.md §9)
 */

export {};
