# Pigeonholes: 判定・API・起動の仕様

> この文書は「どのセッションをどの欄に入れるか」「/api/board が何を返すか」「どう起動するか」を決める。画面は `spec/ui.md`、見た目は `spec/design.md`、ファイルの形は `spec/architecture.md`。
> 合成データ以外の実データ (件数・題名・パス) はこの文書に書かない。

## 1. 経緯

- 最初の設計は 3 案コンペで、**A TRIAGE** (次にやることが 3 秒で分かる、規則を上から順に試す) を採用した。B MAP と C DECLUTTER から次を移植した。
  - C から: 片付け候補の理由別グループ、おすすめ除外と cascade guard (親を archive すると終わった子も一緒に archive されるため)、ID だけを 50 件ずつコピー、「片付けると残り N 件」、ETag/304。
  - B から: `summaryFresh`、task-notification の読み飛ばし、`stop_hook_summary`、未読判定の 2 秒の余裕、ID の正規表現、`errorNow` の時刻チェック。
  - 実データでの確認で追加: subagents フォルダでのバックグラウンド検出、ローカルコマンド行の読み飛ばし、無音しきい値 15 分、tail の 2MB 再読込。gitAnchors / writtenBranches は当たらなかったので削った。
- 2026-10-18 の作り直し (公開に向けて): 名前を **Pigeonholes** にし、`/api/board` を v2 (**言葉ではなくコード**) にし、返事待ち・止まったかも・未読を古い順にし、作業中の経過時間 (`startedAt`)、形式の異常検知 (`formatSuspect`)、実際のフォルダを見るプロジェクト判定 (folder hints) を足した。画面は 2 言語 (en 既定・ja)。

## 2. 設計の前提になった観察

- **バックグラウンド作業**: subagent やワークフローが動いている間、親の transcript は `stop_hook_summary` で終わった状態に見え、書き込みは `<cliSessionId>/subagents/**` 側だけに起きる。subagents フォルダの mtime を見ないと、作業中のものが「未読」や「最近」に誤分類される。
- **質問ツールの返事待ち**: AskUserQuestion / ExitPlanMode で返事を待つターンは tool_use の途中に見えるが、止まっているのは利用者の返事。作業中や止まったかもに出すと気づけない (R0)。
- **許可の確認待ち**: 許可を待つターンも tool_use の途中に見え、15 分で止まったかもに出る。理由の文で「許可の確認待ちかもしれません」と言う。

---

## 3. 定数 (`src/shared/constants.mjs`)

shared は言葉を持たない (表示の言葉は `public/dict-*.mjs` と `src/entry/messages.mjs`)。

```
PRODUCT              = { name: 'Pigeonholes', bin: 'pigeonholes' }   // 名前・ロゴ・題名に "Claude" を入れない

// 分類
RECENT_MS            = 7 days     // 「最近」の窓。全バケット共通の 1 本だけ
QUIET_MS             = 15 min     // 作業中とみなす最大の無音時間。バックグラウンドの新しさにも使う
START_GRACE_MS       = 10 min     // pendingFirstStart の猶予
ERROR_CURRENT_MS     = 60 s       // errorAt >= lastActivityAt - これ のとき、エラーが最新の出来事
UNREAD_SKEW_MS       = 2 s
BG_LEAD_MS           = 5 s        // subagent の書き込みが本体より後であること
RETRY_WINDOW_MS      = 24 h
PR_DONE_IDLE_MS      = 24 h
IDLE_SAFE_MS         = 30 days
FORMAT_SUSPECT_RATIO = 0.2        // 日時の無いレコードの割合がこれを超えたら形式を疑う
FORMAT_SUSPECT_MIN   = 5          // ただし非アーカイブが 5 件以上のときだけ

// 読み込み
TAIL_BYTES 200 KB / TAIL_RETRY_BYTES 2 MB (該当行が 0 件なら 1 回だけ読み直す)
SUBAGENT_SCAN_MAX 2000 entries / session, SUBAGENT_SCAN_DEPTH 4
TRANSCRIPT_MAP_TTL_MS 30 s, MISSING_REBUILD_MS 3 s, BOARD_CACHE_MS 2 s, READ_CONCURRENCY 8
FOLDER_WALK_MAX      = 8          // .git を探して上に何階層たどるか
FOLDER_CHILD_SCAN_MAX= 200        // 「まとめフォルダ」判定で見る子フォルダの上限
FOLDER_HINT_TTL_MS   = 5 min      // フォルダの判定結果のキャッシュ
FOLDER_HINT_CACHE_MAX= 2000       // キャッシュの件数上限 (古いものから捨てる)

// サーバー
DEFAULT_PORT         = 8797

// 画面 (spec/ui.md)
POLL_MS 5 s, HIDDEN_POLL_MS 60 s (通知 ON でタブが隠れているとき), FETCH_TIMEOUT_MS 4 s, FIRST_FETCH_TIMEOUT_MS 20 s
STALE_AFTER_MS 15 s, NEW_BADGE_MS 60 s, QUIET_HINT_MS 5 min, COPIED_LABEL_MS 2.5 s, SKIP_EXPLAIN_MS 2 min
COPY_CHUNK 50, PREVIEW = { unread: 8, working: 8, recentGroup: 5 }, PAGE_SIZE 20, MAX_PRS 10, MAX_PR_BADGES 2
OVERVIEW_SHELF_MAX 60, UI_STORAGE_KEY 'pigeonholes:v1:ui', DEEP_LINK_PREFIX 'claude://claude.ai/epitaxy/', GITHUB_URL_RE
(PREVIEW_COUNT と TOAST_MS は削除)

CAP: TITLE 200 / BODY 600 / PARENT_TITLE 40 / CWD 260 / ERROR_SNIPPET 80 / RESET_SNIPPET 40 / RAW 4000
     (code point 単位。切ったら末尾に「…」。CAP.REASON は削除: 理由の文を作るものが無くなった)
FAMILY_MAX_DEPTH 10, PROJECT_PARENT_MAX_DEPTH 5
SESSION_ID_RE = /^local_[0-9a-f-]{36}$/   // これに合わない ID のセッションは捨てて stats.bad に数える
CLI_SESSION_ID_RE = /^[0-9a-f-]{36}$/i, ASK_TOOLS = ['AskUserQuestion', 'ExitPlanMode']

BUCKETS         = [{key, tone, defaultOpen}] × 6 (needs_you, trouble, unread, working, recent, cleanup の順)
                  defaultOpen: recent だけ false (cleanup は true に変更)。tone は画面では使わない (色で状態を分けない)
ACTION_BUCKETS  = ['needs_you', 'trouble', 'unread']
CLEANUP_REASONS = [{key, recommended}] (§7 の順)
CLEANUP_SUBGROUP_THRESHOLD = 20
CLEANUP_NOTES   = ['open_pr', 'exempt', 'starred', 'unread', 'child']   // この順に試す
OTHER_PROJECT   = { key: '(other)' }
FORBIDDEN_OUTPUT_KEYS = 元データの巨大項目と秘密 (remoteMcpServersConfig ほか) + 'folders' (adapter 内部の手掛かり)
```

## 4. データの読み方 (adapter)

**app-sessions-fs.mjs**
- `<sessionsDir>/*/*/` (アカウント / 組織) の `local_*.json` と `archived-sessions.idx` を読む。`deleted_*` は無視する。sessionsDir は entry が決める (§11)。
- ファイル単位のキャッシュは `{mtimeMs, size}` をキーにする。変わったファイルだけ parse し直す。
- parse 直後に許可したフィールドだけに射影し、元のオブジェクトは捨てる (`session-record.mjs`、fs 版と Fake が同じ関数を通す)。保持するのは:
  - `sessionId, cliSessionId, title, cwd, originCwd, worktreeName, branch, createdAt, lastActivityAt, lastFocusedAt, isArchived, isStarred, autoArchiveExempt, completedTurns, scheduledTaskId`
  - `postTurnSummary{status_category,status_detail,needs_action}, postTurnSummaryFor, lastAssistantUuid`
  - `turnWrapUp.description, lastTurnReport, interruptedAwaitingPerson (null かどうかだけ)`
  - `prs[]{prNumber,repo,url,state}, prNumber, prRepository, prState, prUrl`
  - `spawnedFrom.sessionId, forkedFromSessionId, dispatchParentId`
  - `error, errorAt, errorCategory, pendingFirstStart (有無と since だけ)`
- 射影の後に `attachFolders(records, hintFor)` (session-record.mjs) で `folders: {origin?, cwd?}` を付ける (下の folder hints)。
- parse に失敗したとき: 前回の正常な射影があればそれを使い `stale++`。なければ飛ばして `bad++`。例外は投げない。
- `sourceStats = {files, parsed, bad, stale, dirs}`。`dirs` = 見つかった組織フォルダの数、`files` = 見つかった `local_*.json` の数。
- 開き方は `fs.promises.readFile` (読み取り専用、ロックしない) だけ。書き込み・rename・watch はしない。アーカイブ済みも parse してキャッシュする (親の title とプロジェクト継承のため)。

**folder-hints-fs.mjs** (新規。Fake は `fake-folder-hints.mjs` = 合成の表)
- `createFolderHints({home})` → `hintFor(path): Promise<FolderHint|undefined>`。`FolderHint = {kind: 'repo', name} | {kind: 'container'}`。
- 手順 (stat と readdir だけ。書き込まない):
  1. 末尾の `.claude/worktrees/<x>` (区切りは `/` でも `\` でも) から後ろを切る。
  2. その場所がもう無い (stat に失敗、またはフォルダでない) → hint なし。
  3. その場所自身と、上へ最大 `FOLDER_WALK_MAX` 階層までのフォルダについて、`.git` (ファイルでもフォルダでもよい) があれば `{kind: 'repo', name: basename(そのフォルダ)}`。home に着いたら止まる (home 自体は repo 扱いにしない: dotfiles の repo があっても全部が 1 プロジェクトにならないように)。ドライブ直下・ルートでも止まる。
  4. repo の中でなければ: その場所が home そのもの、または直下の子フォルダ (dotfile を除く、先頭 `FOLDER_CHILD_SCAN_MAX` 個) のうち `.git` を持つものが 2 つ以上 → `{kind: 'container'}`。
  5. それ以外 → hint なし。
- パスを正規化した文字列ごとにキャッシュする (`FOLDER_HINT_TTL_MS`、最大 `FOLDER_HINT_CACHE_MAX` 件)。同時に調べる数は `READ_CONCURRENCY`。
- `name` は CAP.TITLE で切る。hints は core の判定にだけ使い、盤面の JSON には出さない。

**transcripts-fs.mjs**
- `cliSessionId → path` の表を `<projectsDir>/*/*.jsonl` から作り、30 秒ごとに作り直す。cwd からパスを組み立て直さない。表に無い ID を頼まれたら、TTL を待たずに MISSING_REBUILD_MS 空けて作り直す。
- tail を読むのは `age < RECENT_MS` のセッションだけ。読む内容: 末尾 200KB (`{path,size,mtimeMs}` でキャッシュ)、`mainMtime`、`subMtime` (= `<dir>/<cliSessionId>/subagents/**` で一番新しいファイルの mtime。stat だけ、上限 SUBAGENT_SCAN_MAX、各階層で新しい順に降り、bg と silent の判定が決まったら打ち切る)。
- adapter は生の tail 文字列を返す。解釈は core。

**demo-data.mjs** — `buildDemo(now, lang)` (`lang` は端末の言語、§11)。英語の一式と日本語の一式。
- パスは OS に依らない POSIX 文字列 (`~/projects/demo-app` など)。実在の定期実行や人物を思わせる題名は使わない。合成の folder hints の表 (`~/projects/demo-app` → repo `demo-app` など) を一緒に返す。
- transcript の合成行には `"timestamp"` を付ける (startedAt を出すため)。
- entry (`src/entry/demo.mjs` の `liveDemoSources`) は `DEMO_REBUILD_MS` (1 分) ごとに今の時刻で `buildDemo` を呼び直す。起動時の 1 回だけだと、作業中の行が 15 分ほどで止まったかもへ移っていく。ID は毎回同じ。
- 最低限含めるもの: 返事待ち 4 (待ち時間がそれぞれ違う。1 つは AskUserQuestion、1 つは質問文の無い ExitPlanMode)、止まったかも 3 (無音で止まった・使用上限・起動失敗)、未読 3 (1 つは PR 付き、1 つは定期実行の回)、作業中 4 (1 つはバックグラウンド subagent、1 つは親子の子)、最近を 3 プロジェクトにまたがって、片付け候補 約 35 (全理由を含む)、4 件の家族、アーカイブ済みの一式。

## 5. ターン状態 (`core/turn.mjs`、純粋関数)

```
parseTurn(tailText, truncatedHead): TurnResult
  = {turn: 'ended'|'inprogress'|'asking'|'unknown', lastKind?: 'tool'|'prompt', how?: 'interrupted',
     question?: string, askKind?: 'question'|'plan', startedAt?: number, relevant: number}
lines = split('\n'); truncatedHead なら先頭行を捨てる; JSON.parse できた行のうち type ∈ {user, assistant, system} だけ残す
後ろから順に見る (skipCmd = false):
  system:    subtype === 'stop_hook_summary' → ended。それ以外の system は読み飛ばす
  user:      isMeta === true → 読み飛ばす
             content に tool_result ブロックがある → inprogress (lastKind 'tool')
             text = 文字列 content か、最初の text ブロック (trimStart)
             text が '<local-command-stdout' か '<local-command-caveat' で始まる → skipCmd = true にして読み飛ばす
             skipCmd かつ text が '<command-name' か '<command-message' で始まる → 読み飛ばす
             skipCmd = false
             text が '<task-notification' か '<system-reminder' で始まる → 読み飛ばす
             text が '[Request interrupted' で始まる → ended (how 'interrupted')
             それ以外 → inprogress (lastKind 'prompt')
  assistant: message.stop_reason ∈ {end_turn, stop_sequence} → ended。それ以外 → inprogress (lastKind 'tool')
最後まで決まらない → unknown
inprogress (lastKind 'tool') に決まったら pendingAsk を見る:
  後ろからターンの区切り (指示・中断・stop_hook_summary・end_turn) まで、tool_result の tool_use_id を集めながらたどる
  name ∈ ASK_TOOLS の tool_use で、まだ tool_result が無いものがある → asking
  pendingAsk は {question, kind} を返す: question = input.questions[0].question (CAP.BODY まで、無ければ '')、
  kind = ExitPlanMode なら 'plan'、AskUserQuestion なら 'question'。決まり文句は入れない (言葉は画面が持つ)
```

**startedAt** (turn が `inprogress` のときだけ): 後ろから、上と同じ読み飛ばし規則 (system・isMeta・tool_result・ローカルコマンド行・task-notification・system-reminder・assistant 行) でたどり、最初に当たった「指示」の user 行 (上の判定で lastKind 'prompt' になる行) の `timestamp` を `Date.parse` した値。区切り (stop_hook_summary・end_turn・中断) に先に当たった、tail の先頭まで見つからない、または `timestamp` が無い・読めない → 省く。

## 6. バケット分類 (`core/classify.mjs`、最初に当たったものに決める)

アーカイブ済み (`isArchived === true` か、idx に載っている ID) は分類しない。件数だけ出す。

```
入力: sessions, turnInputs, now
act        = s.lastActivityAt ?? s.createdAt;  age = max(0, now - act)   // 未来の時刻は 0 にそろえる
T          = age < RECENT かつ transcript がある ? parseTurn(...) : {turn:'unknown'}
quietSince = max(mainMtime, subMtime);  silent = now - quietSince
bg         = subMtime > mainMtime + BG_LEAD_MS かつ now - subMtime < QUIET_MS
fresh      = postTurnSummary があり、かつ (lastAssistantUuid が無い、postTurnSummaryFor が無い、または postTurnSummaryFor === lastAssistantUuid)
asks       = (fresh かつ (needs_action.trim() !== '' または status_category === 'blocked')) または interruptedAwaitingPerson
unreadExplicit = lastFocusedAt != null かつ (lastActivityAt - lastFocusedAt) > UNREAD_SKEW_MS
unread     = lastFocusedAt == null ? true : unreadExplicit
errorNow   = error.trim() !== '' かつ (errorAt == null または errorAt >= lastActivityAt - ERROR_CURRENT_MS)
failedStart= errorCategory === 'git_startup_failed' または (pendingFirstStart があり、!errorNow、now - createdAt > START_GRACE_MS)
retried    = title が空でなく、次を満たす別の非アーカイブ o がある: o.title === s.title、parentOf(o) === parentOf(s)、
             0 < o.createdAt - s.createdAt < RETRY_WINDOW_MS、!errorNow(o)
superseded = scheduledTaskId があり、同じ id の非アーカイブの回の中で最新 (createdAt 最大、同じなら sessionId) でない
prList     = prs[] + 旧形式の prNumber/prRepository/prState (同じ番号は重ねない)
hasOpenPr  = prList に state === 'OPEN' がある;  prDone = prList が 1 件以上あり、全部 MERGED か CLOSED
```

| # | 判定 | bucket / reason | since / timeKind |
|---|---|---|---|
| R0 | `T.turn==='asking' && !superseded && !errorNow` | `needs_you` / `asking`、reasonParams `{ask: T.askKind}` | quietSince / waiting |
| R1 | `T.turn==='inprogress' && silent < QUIET_MS` | `working` / `turn` (+ `startedAt`) | quietSince / updated |
|    | `bg` | `working` / `background` | quietSince / updated |
|    | `pendingFirstStart && !errorNow && now-createdAt <= START_GRACE_MS` | `working` / `starting` | since / updated |
| R2 | `superseded` | `cleanup` / `routine_old` | act / ago |
| R3 | `errorNow \|\| failedStart`: retried なら `cleanup/retried`。age<RECENT なら `trouble` (下の表)。それ以外は `cleanup/old_error` | | |
| R4 | `T.turn==='inprogress'` (ここに来る時点で silent ≥ QUIET) | `trouble` / `stalled` | |
| R5 | `asks`: age<RECENT なら `needs_you/asks`、それ以外は `cleanup/old_question` | | act / waiting |
| R6 | `age < RECENT && unread` | `unread` / `unread` | act / ended |
| R7 | `prDone && age >= PR_DONE_IDLE_MS && !unreadExplicit` | `cleanup` / `pr_done` | act / ago |
| R8 | `age < RECENT` | `recent` / `recent` | act / ago |
| R9 | 残り全部 | `cleanup` / age ≥ IDLE_SAFE なら `idle_30d`、それ以外は `idle_7d` | act / ago |

R1 を先に置く理由: 動いているセッションは決して隠さない (前のターンの needs_action よりターンの状態を優先)。R0 をその前に置く理由: §2 の「質問ツールの返事待ち」。

**trouble の reason と reasonParams** (時間は含めない。言葉は画面が作る):

| 条件 (上から) | reason | reasonParams | since / timeKind |
|---|---|---|---|
| `!errorNow && !failedStart && T.turn==='inprogress'` | `stalled` | `{via: T.lastKind}` ('prompt' か 'tool') | quietSince \|\| act / stalled |
| `errorCategory==='git_startup_failed'` | `git_startup` | なし | errorAt ?? createdAt / stopped |
| `pendingFirstStart && !errorNow` | `not_started` | なし | pendingFirstStart.since ?? createdAt / stopped |
| error が `/limit/i` に当たる | `limit` | `{reset}` (`/resets?\s.+$/` に当たった部分を CAP.RESET_SNIPPET まで。無ければ省く) | errorAt ?? act / stopped |
| その他の error | `error` | `{error}` (先頭 CAP.ERROR_SNIPPET) | errorAt ?? act / stopped |

## 7. 片付け候補の理由とおすすめ (`core/board.mjs`)

理由グループは次の固定順。グループに言葉は付けない (画面が `cleanup.<reason>` で名前を付ける)。

| 順 | reason | おすすめに入るか | 行の reasonParams |
|---|---|---|---|
| 1 | `retried` | 入る | なし |
| 2 | `routine_old` | 入る | `{older, total, latestBucket?}` (下の定期実行) |
| 3 | `pr_done` | 入る | `{prs: 先頭 2 件 [{num, repo, state}] (紐づけた順), more?: 残りの数}` |
| 4 | `old_error` | 入らない | `{error}` (先頭 80 字) |
| 5 | `old_question` | 入らない | `{question}` (needs_action か status_detail の先頭 80 字。空なら省く) |
| 6 | `idle_30d` | 入る | なし |
| 7 | `idle_7d` | 入らない | なし |

**おすすめから外す条件** (この順に試し、最初に当たったものを `cleanup.note` に NoteCode で入れる。外れた行も個別には選べる):
1. `hasOpenPr` → `open_pr`
2. `autoArchiveExempt === true` → `exempt`
3. `isStarred === true` → `starred`
4. `unreadExplicit` (定期実行の回は除く) → `unread`
5. cascade guard: 非アーカイブの子 (`parentOf(child) === s.sessionId`) のうち 1 件でも cleanup 以外にいる → `child`

`cleanup.recommended = reason がおすすめに入る && note が無い && formatSuspect が null`。

**グループ内の並び**: 行が CLEANUP_SUBGROUP_THRESHOLD (20) を超えたら、プロジェクトごとのサブグループ (`projects[]`) にする。どちらも lastActivityAt の新しい順。各グループとサブグループに `count` / `recommendedCount` (セッション数。定期実行の 1 行 = runIds の数) を付ける。

## 8. 定期実行・家族・プロジェクト

**定期実行**
- 同じ `scheduledTaskId` の非アーカイブの回は、最新回だけがカードになり、最新回が当たったバケットに置く。
- `routine = {id, runs, completed, stalled, latestBucket}`。completed = turn が ended で中断ではない回、stalled = inprogress・asking・中断で終わった回 (最新回は数えない。状態の分からない回は数えない)。
- 非アーカイブの回が 2 回以上ある定期実行で、cleanup に入った回すべてを `routine_old` グループの 1 行にまとめる (`routine.runIds`)。行の `reasonParams = {older: runIds.length, total: runs, latestBucket}` (latestBucket は最新回が cleanup 以外にいるときだけ)。行の title は最新回の title、`since` は最新回の activity、`timeKind` は `latest`。チェック 1 つで全回を選ぶ。

**家族**
- `parentOf(s) = spawnedFrom?.sessionId ?? forkedFromSessionId ?? dispatchParentId`。SESSION_ID_RE に合う ID だけ (ディスパッチの擬似 ID は親にしない)。
- `card.family = {rootId?, parentId?, parentTitle?, children?}`。parentTitle は親が見つからなければ `null`、無題なら `''`。children は直下の非アーカイブの子だけを `{total, working, needs_you, trouble, unread}` で数える。
- `families[rootId] = {title, memberIds}` (2 人以上の家族だけ)。根は parentOf を上へたどったもの (深さ FAMILY_MAX_DEPTH、visited で循環を止める)。

**プロジェクト** (`core/project.mjs`)
- `roots`: entry が決める (§11)。既定は `[home]` だけ。
- 判定順 (最初に決まったものを使う):
  1. **フォルダ**: `originCwd` (hint は `folders.origin`)、次に `cwd` (hint は `folders.cwd`) の順に 1 つずつ見る。
     - hint が `repo` → その `name` (how `folder`)
     - hint が `container` → このパスからは決めない (次のパスへ)
     - hint が無い → 今までの `folderSegment(path, roots)`: `.claude\worktrees\` の手前で切る → ドライブ直下か root と一致なら null → root の下なら root 直下の最初のフォルダ名 → どの root の下でもなければ最後のフォルダ名
  2. **PR の多数決**: `prs[].repo` と `prRepository` で一番多い repo。同数なら先頭の PR (prs[0]、無ければ prRepository)。'/' より後ろを名前にし、別の repo が混ざっていれば `extra` = その種類数。
  3. **親から継承**: parentOf で再帰 (深さ PROJECT_PARENT_MAX_DEPTH、visited で循環を止める、親はアーカイブ済みでもよい)。`extra` は継承しない。
  4. どれも無い → key `(other)`、`project.label = null` (画面が「フォルダなし / No project folder」と書く)。
- key は小文字の名前。label は最も多い表記。名前は CAP.TITLE で切る。title や会話の中身からは推測しない。

## 9. 並び・startedAt・formatSuspect

- **並び**: `needs_you`・`trouble`・`unread` は `since` の古い順 (一番長く待っているものが先頭。同時刻は id 順)。`working` は `since` の新しい順。recent はプロジェクト別 (グループは中の最新の新しい順、`(other)` は最後。中は新しい順)。cleanup は §7。画面は needs_you と trouble を打ち切らない。
- **startedAt**: `bucket === 'working' && reason === 'turn'` で `T.startedAt` が有限の数のときだけ Card に付ける。画面は「23 分経過 / 23 min running」と出す。無ければ従来どおり「更新」の時刻。
- **formatSuspect** (`stats.formatSuspect`、上から最初に当たったもの):
  1. `sourceStats.dirs > 0 && sourceStats.files === 0` → `'no_session_files'`
  2. 非アーカイブが FORMAT_SUSPECT_MIN 件以上で、そのうち `lastActivityAt` も `createdAt` も無いものの割合 > FORMAT_SUSPECT_RATIO → `'no_timestamps'`
  3. それ以外 → `null`
  - null でないとき、すべての `cleanup.recommended` を false にし、`recommendedCount` と `counts.recommended` を 0 にする (日時が読めないと全部が「30 日以上動きなし」に見え、おすすめで一括に片付けてしまうため)。画面は警告の帯を出し、「おすすめをまとめて選ぶ」を出さない。

## 10. API (`GET /api/board`、v2 = コードは送るが言葉は送らない)

- 画面が 5 秒ごとに `If-None-Match` 付きで取得する (詳しくは ui.md §16)。サーバーは盤面の計算を最大 2 秒に 1 回にし、同時に来たリクエストは計算中の Promise を共有する。ETag は `generatedAt`・`serverNow`・`stats.scanMs` を除いた本文の sha1。変わっていなければ 304。`Cache-Control: no-store`。
- 盤面は言語によらず同じ (Accept-Language も `?lang=` も見ない)。
- 計算に失敗したら HTTP 500 と `{"error":"board_failed"}`。端末には `term.boardFailed` (エラーの name だけ。title や本文は書かない)。

```
{ v: 2, generatedAt, serverNow,
  counts: {needs_you, trouble, unread, working, recent, cleanup, recommended, active, archived},
  buckets: {needs_you: Card[], trouble: Card[], unread: Card[], working: Card[]},
  recentGroups: [{key, label: string|null, items: Card[]}],                       // label null = (other)。gloss は無い
  cleanupGroups: [{reason, recommendedReason, count, recommendedCount,
                   items?: Card[], projects?: [{key, label: string|null, lastActivityAt, count, recommendedCount, items: Card[]}]}],
  families: {[rootId]: {title, memberIds}},
  stats: {files, parsed, bad, stale, archived, active, recentTotal, transcriptsMissingRecent, unknownTurnRecent,
          recentWithTranscript, transcriptsDirMissing, scanMs,
          formatSuspect: null|'no_timestamps'|'no_session_files', demo: boolean} }

Card = { id, bucket, reason: ReasonCode, reasonParams?, title, body, since, timeKind, startedAt?,
         lastActivityAt, createdAt, project: {key, label: string|null, extra},
         prs: [{num, repo, state, url|null}],
         routine?: {id, runs, completed, stalled, latestBucket, runIds?},
         family?: {rootId?, parentId?, parentTitle?, children?: {total, working, needs_you, trouble, unread}},
         detail: {statusDetail?, branch?, worktreeName?, cwd?, completedTurns?, error?, prsMore?},
         cleanup?: {recommended, note?: NoteCode} }

ReasonCode = asking | asks | stalled | git_startup | not_started | limit | error | unread | turn | background | starting
           | recent | routine_old | retried | old_error | old_question | pr_done | idle_30d | idle_7d
NoteCode   = open_pr | exempt | starred | unread | child
ReasonParams (その reason のキーだけ): ask: 'question'|'plan' / via: 'prompt'|'tool' / reset / error / question /
           older / total / latestBucket / prs: [{num, repo, state}] / more
TimeKind   = waiting | stopped | stalled | ended | updated | ago | latest
```

- **body** は中身だけ: needs_you は質問文 (asking) → fresh な needs_action → fresh な status_detail → 一般の要約。`asking` で質問文が無いときは `''` (古い needs_action に落とさない。画面が `ask.<kind>` を出す)。trouble は `''` (画面が reasonParams から理由の文を作る)。working は `''`。それ以外は turnWrapUp.description → fresh な status_detail → lastTurnReport の要約。
- **stats.demo**: デモデータで動いているとき true (entry が service に渡す)。
- `prs[].state` はコードのまま (OPEN / MERGED / CLOSED、それ以外は生のまま)。文字列はすべて §3 の上限で切る。

## 11. 起動と端末 (entry)

**起動のしかた**: `npx pigeonholes` (bin)、`npm start`、`node src/entry/server.mjs`。`server.mjs` の 1 行目は `#!/usr/bin/env node`。package.json の `bin` は `{ "pigeonholes": "src/entry/server.mjs" }`。

**設定** (フラグは環境変数に勝つ。`--flag value` と `--flag=value` の両方を受ける):

| フラグ | 環境変数 | 既定 / 検証 |
|---|---|---|
| `--port <n>` | `PIGEONHOLES_PORT` | 8797。1024〜65535 の整数でなければ exit 1 |
| `--lang en\|ja` | `PIGEONHOLES_LANG` | 下の言語の決め方。en / ja 以外は exit 1 |
| `--demo` | `PIGEONHOLES_DEMO=1` | 合成データで動かす (Fake adapter)。デモの中身の言語は端末の言語 |
| `--sessions-dir <path>` | `PIGEONHOLES_SESSIONS_DIR` | 下の候補。相対パスは今のフォルダから解決 |
| `--projects-dir <path>` | `PIGEONHOLES_PROJECTS_DIR` | `$CLAUDE_CONFIG_DIR/projects` (絶対パスのとき) → `~/.claude/projects`。無くても起動する (transcriptsDirMissing) |
| — | `PIGEONHOLES_ROOTS` | 既定 `[home]`。`path.delimiter` と `;` (どの OS でも) で分け、全部絶対パスでなければ exit 1 |
| `--help` / `--version` | — | 使い方 / `pigeonholes <version>` を出して exit 0 |

旧名の `SESSION_BOARD_*` は読まない。知らないフラグ・値の無いフラグは exit 1 (`term.badFlag` / `term.missingValue`)。

**セッションフォルダの候補** (上から、最初に存在したもの。フラグか環境変数があればそれだけを見る):
- win32: `%APPDATA%\Claude\claude-code-sessions` → `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code-sessions`
- darwin: `~/Library/Application Support/Claude/claude-code-sessions`
- linux: `$XDG_CONFIG_HOME/Claude/claude-code-sessions` (XDG_CONFIG_HOME があるとき) → `~/.config/Claude/claude-code-sessions`
- 見つからない (デモでないとき) → exit 1。`term.noSessionsDir` の後に、探したパスを 1 行に 1 つ、最後に `term.noSessionsDirHint`。

**端末の言語** (`pickTerminalLang(env, argvLang, intlLocale)`、純粋関数。PORT と ROOTS より先に決める): `--lang` → `PIGEONHOLES_LANG` → `LC_ALL` → `LC_MESSAGES` → `LANG` (`C` / `POSIX` で始まるものは「指定なし」として飛ばす) → `Intl.DateTimeFormat().resolvedOptions().locale` → `en`。`normalizeLang` は先頭の英字が `ja` なら ja、`en` なら en、それ以外は null (LC_* と LANG では en に落とす)。`--lang` / `PIGEONHOLES_LANG` が不正なら、それを除いた順で決めた言語でエラーを出す。

**起動の流れ**: 設定 → adapter を選ぶ (実データ / デモ) → 127.0.0.1 だけで待ち受け → 1 行 `term.started` (URL を含む。テストと smoke は `/http:\/\/127\.0\.0\.1:\d+/` で起動完了を判定する) → 初回の全件スキャンを先に済ませる。ログに title や本文は書かない。

**ポートが使用中** (EADDRINUSE): `probe.mjs` が `GET /api/hello` を見る。このボードは `{"app":"pigeonholes","demo":<bool>}` を返す (`parseHello` は純粋関数。形が違えば null)。応答は真似できるので、端末の案内は「このボードらしい」までしか言わない。
- 同じ種類 (実データで起動して実データ、`--demo` で起動してデモ) → `term.alreadyRunning` と `term.alreadyRunningCheck` (自分で起動していなければ別の番号で、`{cmd}`) を出して exit 0。
- 種類が違う → `term.runningDemo` (実データで起動したのにデモが動いている) または `term.runningLive` (`--demo` で起動したのに実データが動いている) を出して exit 1。デモのつもりで実データを開かせない (またはその逆)。
- それ以外 → `term.portBusy` を出して exit 1。
- `{cmd}` = `portHint(platform, port, launcher, argsWithoutPort(argv)).cmd` (純粋関数): 起動のしかた + 付けていたフラグ (`--port` を除く。`--demo`・`--lang`・`--sessions-dir` などは残す) + `--port <port+1>`。空白や記号のある値は `shellQuote` で引用する (win32 は `"…"`、それ以外は `'…'`)。環境変数での書き方はシェルごとに違う (PowerShell・cmd・bash) ので出さない。起動のしかたは npm で入れたなら `npx pigeonholes`、clone なら `node <server.mjs の絶対パス>` (同じく引用する)。
- `term.badFlag` / `term.missingValue` / `term.help` の `{cmd}` も同じ起動のしかた (clone では `pigeonholes` というコマンドは無いため)。

**端末の言葉** (`src/entry/messages.mjs`、`msg(lang, key, params)`):

| key | en | ja |
|---|---|---|
| `term.started` | Pigeonholes: http://127.0.0.1:{port} ({mode}) | Pigeonholes: http://127.0.0.1:{port} ({mode}) |
| `term.modeReadOnly` | read-only | 読み取り専用 |
| `term.modeDemo` | demo data, read-only | デモデータ・読み取り専用 |
| `term.alreadyRunning` | Already running: open http://127.0.0.1:{port} | もう起動しています: http://127.0.0.1:{port} を開いてください |
| `term.alreadyRunningCheck` | (If you didn't start a board on that port, something else is answering like one. Start on another port: {cmd}) | (そのポートで自分でボードを起動していないなら、別のものがボードのように応答しています。別の番号で起動してください: {cmd}) |
| `term.runningDemo` | Port {port} has the demo board, not your sessions. Stop it with Ctrl+C in its terminal, or start on another port: {cmd} | ポート {port} で動いているのはデモのボードで、あなたのセッションではありません。そのターミナルで Ctrl+C で止めるか、別の番号で起動してください: {cmd} |
| `term.runningLive` | Port {port} has a board with your real sessions, not the demo. Start the demo on another port: {cmd} | ポート {port} で動いているのはあなたのセッションのボードで、デモではありません。デモは別の番号で起動してください: {cmd} |
| `term.portBusy` | Port {port} is used by another app. Start on another port: {cmd} | ポート {port} は別のアプリが使っています。別の番号で起動してください: {cmd} |
| `term.cantStart` | Can't start the server: {code} | サーバーを起動できません: {code} |
| `term.badPort` | The port must be a number from 1024 to 65535 (got: {raw}). Use --port <n> or PIGEONHOLES_PORT. | ポートは 1024〜65535 の数字にしてください (今: {raw})。--port <n> か PIGEONHOLES_PORT で指定します |
| `term.badRoots` | PIGEONHOLES_ROOTS must be absolute paths separated by "{sep}" (invalid: {bad}) | PIGEONHOLES_ROOTS は絶対パスを「{sep}」区切りで書いてください (不正: {bad}) |
| `term.empty` | (empty) | (空) |
| `term.badLang` | --lang and PIGEONHOLES_LANG must be en or ja (got: {raw}) | --lang と PIGEONHOLES_LANG は en か ja にしてください (今: {raw}) |
| `term.badFlag` | Unknown option: {flag}. See: {cmd} --help | 知らないオプションです: {flag}。{cmd} --help を見てください |
| `term.missingValue` | {flag} needs a value. See: {cmd} --help | {flag} には値が必要です。{cmd} --help を見てください |
| `term.noSessionsDir` | Can't find the Claude desktop app's session folder. Looked in: | Claude デスクトップアプリのセッションフォルダが見つかりません。探した場所: |
| `term.noSessionsDirHint` | Start a session once in the Code tab of the Claude desktop app, or pass --sessions-dir <path> (or set PIGEONHOLES_SESSIONS_DIR). | Claude デスクトップアプリの Code タブで一度セッションを始めるか、--sessions-dir <path> (または PIGEONHOLES_SESSIONS_DIR) で場所を指定してください |
| `term.boardFailed` | Failed to build the board: {name} | 盤面の計算に失敗しました: {name} |
| `term.version` | pigeonholes {version} | pigeonholes {version} |
| `term.help` | 下の使い方 (en) | 下の使い方 (ja) |

`term.help` (en。ja は同じ形の日本語。`{sep}` は path.delimiter):
```
Pigeonholes {version}: one read-only page for all your Claude desktop app sessions (the Code tab).

Usage: {cmd} [options]
  --port <n>             port on 127.0.0.1 (default 8797; env PIGEONHOLES_PORT)
  --lang en|ja           language of these messages and the demo (env PIGEONHOLES_LANG)
  --demo                 show synthetic demo data instead of your sessions (env PIGEONHOLES_DEMO=1)
  --sessions-dir <path>  the app's claude-code-sessions folder (env PIGEONHOLES_SESSIONS_DIR)
  --projects-dir <path>  Claude Code's projects folder with transcripts (env PIGEONHOLES_PROJECTS_DIR)
  --help, --version
PIGEONHOLES_ROOTS: folders, separated by "{sep}", whose direct subfolders are projects (default: your home).
It only reads files. Nothing leaves this computer.
```

## 12. サーバーとセキュリティ (entry)

- `127.0.0.1` だけに bind する。`Host` が `127.0.0.1:<port>` か `localhost:<port>` 以外なら 403 (DNS rebinding 対策)。GET 以外は 405 (HEAD も)。CORS ヘッダーは付けない。
- `GET /api/hello` は `{"app":"pigeonholes","demo":<bool>}` だけを返す (ポートが使用中のときの確かめ用、§11)。セッションの中身は入れない。
- **静的ファイルの表は起動時に作る**: `public/` を 1 回 readdir し、拡張子 `.html .css .mjs .svg .png .ico` のファイルだけを、ファイル名そのままの `/<name>` で配信する (サブフォルダ・dotfile は入れない)。`/` は `public/index.html`。加えて `/src/shared/constants.mjs` と `/src/shared/i18n.mjs`。表にないパスはすべて 404。リクエストのパスとファイルパスを結合しない。Content-Type は拡張子の表から。
- ヘッダー (全レスポンスに一括):
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  - `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`
- インラインスクリプト・style 属性は使わない。外への通信は一切しない (gh も fetch も使わない)。

## 13. 構成と検査

ファイルの一覧と役割は `spec/architecture.md` §1、画面のファイルは `spec/ui.md` §1。

`npm run arch` (それぞれ対象ファイル数 > 0 を確かめ、件数を出す。抑制は `// arch-allow: <理由>` だけ):
1. core と shared に次が無い: `from 'node:`、`import('node:`、`require(`、`process.`、`Date.now`、`new Date(`、`fetch(`。
2. shared は import しない。core は `../shared/` と `./` だけ。adapter は `node:` / `../shared/` / `../core/` / `./` だけ。
3. `src/adapters/*-fs.mjs` ごとに `fake-*.mjs` がある (app-sessions / transcripts / folder-hints)。
4. `public/` で `fetch(` は `api.mjs` だけ。`innerHTML`・`outerHTML`・`insertAdjacentHTML`・`document.write` はどこにも無い。
5. adapter と entry で書き込み系 API を使わない。
6. (新規) 画面と端末の言葉は辞書だけ: core・shared・entry (`messages.mjs` を除く)・public (`dict-*.mjs` と `i18n.mjs` を除く) の文字列リテラルに仮名・漢字が無い (コメントは可)。`index.html` は `data-i18n*` 属性の外に仮名・漢字が無い。

テスト (fixture はすべて合成データ。実際の title や報告は使わない):
- **turn**: 9 パターン (end_turn + stop_hook_summary / end_turn 後の task-notification / interrupt / tool_use が最後 / user の prompt が最後 / ターン終了後の local-command / 先頭の欠けた行 / 200KB 超の 1 行 / 該当行 0 件) + askKind (question / plan、質問文なしで `question === ''`) + startedAt (読み飛ばしをまたいで指示の行を見つける / 区切りに先に当たれば無し / timestamp なしで無し)。
- **classify**: R0〜R9 の各規則と優先順、trouble の reasonParams (`via`、`reset`、80 字の `error`)。
- **project**: repo hint / container hint で次のパスへ / hint なしで roots / worktree の切り落とし / PR の同数 / 親の循環 / `(other)` で label null。
- **board**: v === 2、needs_you・trouble・unread の古い順と working の新しい順、定期実行のまとめと reasonParams、理由グループと 20 件の境目、おすすめ除外 5 種 (NoteCode)、formatSuspect の 2 種と recommended の全 false、trouble と質問文なし asking の body が `''`、startedAt、文字数の上限、出力に FORBIDDEN_OUTPUT_KEYS (folders を含む) が無いこと。
- **adapter**: 壊れた JSON に耐える、Fake との一致、folder hints (os.tmpdir の一時フォルダに .git を作って repo / container / 消えたパス / home で止まる)。
- **entry**: フラグが環境変数に勝つ、`--help` / `--version`、不正なポート・言語・ROOTS・フラグで exit 1 (1 回だけの説明)、セッションフォルダの候補と「探した場所」の一覧、`portHint` (付けていたフラグを残す・`shellQuote` の win32 / それ以外)、端末の言語の決め方 (テストの子プロセスには走らせる人の `LC_*` / `LANG` を渡さない)、使用中のポートで同じ種類なら exit 0・種類が違えば exit 1・別のアプリなら exit 1、demo を空きポートで起動して `/`・`/api/board`・`/api/hello` が 200・別の Host で 403・`/../x` と `/.hidden` で 404・POST で 405・2 回目が 304・`public/` の新しいファイルが配信される。

## 14. 作らないもの

- ボードからの書き込み操作すべて (アーカイブ・元に戻す・既読にする・送信・停止・名前変更・ピン・グループ)。片付けは Claude への指示文のコピーで渡す。
- アーカイブ済みの一覧と元に戻す UI (件数だけ出す)。
- 無限キャンバス・ズーム率・ドラッグでの配置・ノードグラフの線・地図レーン・ghost 行。全体 (Overview) は計算で並べた印の一覧で、保存する配置は無い。
- title や transcript の中身からのプロジェクト推測、別名の表。gitAnchors / writtenBranches。
- `scheduled-tasks.json` の読み込みと次回実行時刻の計算。GitHub の今の PR 状態の取得。
- transcript 全文の表示と全文検索。
- トークン・費用・使用上限の集計やグラフ。model / effort / 権限モードの表示と絞り込み。
- 音、完了の通知 (アプリが出す)、通知の既定 ON。SSE / WebSocket / fs.watch / Service Worker。
- 設定画面 (しきい値は shared の定数・フラグ・環境変数だけ)、並べ替えの切り替え、テーマの切り替えボタン、複数 PC や複数アカウントの UI。
- 「最近」や「作業中」の行から直接片付けに加えるチェック。
- backgroundTaskSuggestions / sideSessionNotes / reportFindingsCard。
- 外部フォントの読み込み、毎秒動く表示、繰り返すアニメーション。

**作るようになったもの** (以前はここにあった): キー操作 (1 文字キーを止める切替つき)、自分で ON にする通知 (返事待ちと止まったかもだけ)、状態を示す favicon、全体 (Overview、既定は閉じる)、詳細の中の親子の木。詳しくは spec/ui.md。

## 15. 既知の限界 (画面の文言で吸収する)

- **許可の確認待ち**: 15 分で「止まったかも」に出る。理由の文に「許可の確認待ちかもしれません」と入れてある。
- **長い 1 回のモデル呼び出し**: 15 分を超える呼び出しは一時的に「止まったかも」に見える。QUIET_MS で調整できる。
- **PR の状態**: メタデータに残った値なので遅れることがある。
- **未読**: アプリが `lastFocusedAt` を更新するまで消えない。ボードから既読にはできない。
- **deep link**: `claude://` は Claude アプリの内蔵ブラウザで止められることがある。そのときは「ID をコピー」「リンクをコピー」を使うか、普段のブラウザで `http://127.0.0.1:8797` を開く。
- **承認の手間**: default の権限モードでは archive 1 件ごとに承認を求められる。50 件ずつにしてあるのはこのため。
- **自分自身**: このボードを開いているセッション自身も「作業中」や「未読」に出る。仕様どおりなので特別扱いしない。
- **formatSuspect は目安**: 日時が欠けたレコードの割合とファイル数だけで判断する。アプリの形式が別の形で変わったときは拾えない。
- **folder hints**: 消えたフォルダ・ネットワークドライブで読めないフォルダは hint なしになり、今までの roots の規則に戻る。ネットワークのパス (`\\server\share`・`//server/share`) はそもそも見ない (SMB の接続を作らない)。割り当てたネットワークドライブ (例 `Z:`) は普通のパスに見えるので見るが、1 パス `FOLDER_HINT_TIMEOUT_MS` (0.5 秒) で打ち切るので、届かない共有でも盤面は止まらない。アーカイブ済みのセッションのフォルダは見ない (盤面に出ないため)。

読むファイル (すべて読み取りのみ): §11 のセッションフォルダの `<accountUuid>/<orgUuid>/`、`~/.claude/projects/` (または CLAUDE_CONFIG_DIR)、セッションの cwd とその親フォルダ (`.git` の有無と直下のフォルダ名だけ)。

---

## 16. 実装時に決めたこと

**構成・名前**
- adapter は `*-fs.mjs` ↔ `fake-*.mjs` の組 (app-sessions / transcripts / folder-hints)。補助は `session-record.mjs` (許可項目への射影と attachFolders)、`map-limit.mjs` (同時に開くファイル数の上限)、`demo-data.mjs` (合成データ)。core の `session.mjs` は activityOf / parentOf / prListOf / rootOf。
- entry は `server.mjs` (起動・CLI) / `config.mjs` (フラグと環境変数の検証) / `messages.mjs` (端末の言葉) / `service.mjs` (wiring・キャッシュ・ETag) / `http.mjs` (ヘッダー一括・配信表) / `probe.mjs`。
- 共有の `constants.mjs` と `i18n.mjs` は `/src/shared/...` で画面にも配信する。画面は `../src/shared/...` を import し、ブラウザでも Node でも同じファイルに解決される。
- Windows の npm scripts では `PIGEONHOLES_DEMO=1 node ...` と書けないので、`npm run demo` は `--demo` を使う。

**判定**
- retried は title が空でないときだけ (無題同士がすべて一致するため)。最新回の判定で createdAt が同じときは sessionId で決める。
- cliSessionId は UUID の形だけ受け付ける (subagents のパスを組み立てるため)。会話ログの表で同じ ID が 2 か所にあれば mtime の新しい方。
- 定期実行の行にまとめるのは非アーカイブの回が 2 回以上ある定期実行だけ。1 回しかないものは普通の行。
- 「過去 N 回」の N は最新回を除いた回数。状態の分かる回が 1 つも無ければ出さない (7 日より前の回は会話ログを読まないため)。
- lastTurnReport の要約: 前後の `"` と `\"` を外す → '⏎' で分けて前半 → `[t](u)` を t にする → `**` を外す → 空白を詰める。
- Card の detail に `error` (エラー全文、600 字まで) と `prsMore`、cleanupGroups の各グループとサブグループに `count` / `recommendedCount`、stats に `transcriptsDirMissing` を足した。

**サーバー**
- ETag の計算から `generatedAt`・`serverNow`・`stats.scanMs` を除く (scanMs は毎回変わり 304 が返らなくなるため)。
- 起動直後に 1 回盤面を計算しておく。画面の初回取得だけタイムアウトを 20 秒にする。
- GET だけを受け付ける (HEAD も 405)。使用中ポートの案内は「今の番号 + 1」。
