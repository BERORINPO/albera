# アーキテクチャ (Pigeonholes)

形: 4 役割・一方向依存 (entry → adapter → core → shared)。検査は `npm run arch`。セッションファイルは読み取り専用。外界 (fs/Git) は adapter に閉じ込め、判定は時計も言葉も持たない純粋関数にする。ユーザーが画面で明示確認したworktree作成だけは専用Git adapterが行い、合成データでは書き込まない。言葉は画面と端末の辞書だけが持つ。

## 1. 役割対応表 (scripts/arch-check.mjs と 1:1)

| 役割 | パス | 中身 |
|---|---|---|
| shared | src/shared/ | constants.mjs (しきい値・ID 形式・PRODUCT。言葉なし) / types.mjs (JSDoc) / i18n.mjs (fill・fillParts・pickForm・normalizeLang)。何も import しない。constants と i18n は画面にも配信 |
| core | src/core/ | turn / classify (tailFacts) / project / board / session / text (cleanText) / activity (していること・commandHead) / context (窓・段階・contextMemo)。fs・clock・env・言葉なし (now と前回の段階は引数、出力はコードと params) |
| adapter | src/adapters/ | app-sessions-fs + fake-app-sessions / codex-sessions-fs + fake-codex-sessions (rollout の許可イベントだけ) / copilot-sessions-fs + fake-copilot-sessions (session-state の許可イベントだけ。保存先はCLIとCopilot appで共有) / transcripts-fs + fake-transcripts (末尾・subMtime・subLive) / folder-hints-fs + fake-folder-hints / worktrees-git + fake-worktrees (ローカルGitの状態と明示要求時のpath-free一覧) / worktree-create-git + fake-worktree-create (画面確認後のローカル作成のみ) / worktree-remove-git + fake-worktree-remove (明示確認後の clean・非current・非locked worktree の削除のみ) / session-record (許可項目への射影・attachFolders。model は窓のためだけ) / demo-data (合成、en・ja) / map-limit |
| entry | src/entry/ | server (起動・CLI・shebang) / config (フラグと env の fail-fast、セッションフォルダの候補、起動例の組み立て) / messages (端末の言葉 en・ja) / service (wiring 1 点・2 秒キャッシュ・ETag・tail 解析の memo と前回の段階をメモリに持つ) / demo (`--demo` の Fake の組。1 分ごとに今の時刻から作り直す) / http (ヘッダー一括・起動時に作る配信表・`/api/hello`) / probe (使用中のポートで応答しているのがこのボードらしいか、デモか実データか) |
| 画面 | public/ | index.html / tokens.css style.css source-filter.css rows.css tidy.css canvas.css graph.css / app actions poll state ui-state render front rows labels cleanup handoff keys notify favicon copy view format times (.mjs) / canvas canvas-slip canvas-sheet canvas-fit canvas-bar canvas-ctl canvas-view canvas-act canvas-layout canvas-desk canvas-fold canvas-camera canvas-input (.mjs、layout・desk・fold・camera は純粋。fit は見えない箱で付箋の中身の高さを測り、layout に入力として渡す) / graph-model.mjs (純粋なユーザー作成グラフ正規化・編集) graph-store.mjs (localStorage adapter) graph-render.mjs graph-dialog.mjs (安全な canvas DOM) / worktree-dialog.mjs (作成前の確認・結果) worktree-list-dialog.mjs (path-free一覧) worktree-remove-dialog.mjs (ブランチ名入力と削除影響の確認) / doing.mjs (していることの言葉、純粋) / events.mjs (許可済み CLI イベントの時系列) / codex-status.mjs (安全な集計値を診断文へ変換、純粋) / worktree-detail.mjs (Git状態要約の表示文、純粋) / i18n.mjs dict-en.mjs dict-ja.mjs dict-en-canvas.mjs dict-ja-canvas.mjs dict-en-handoff.mjs dict-ja-handoff.mjs (言葉はここだけ。dict-<lang>-<part>.mjs は 400 行のための分割) / api.mjs (唯一の fetch)。画面のファイルは 400 行まで (arch 7)。spec/ui.md §1 |

## 2. 外部境界表

| adapter | 相手 | Fake | fixture | credential | 書込 identity |
|---|---|---|---|---|---|
| app-sessions-fs | セッションフォルダ (board.md §11 の候補) の `*/*/local_*.json` と `archived-sessions.idx` | fake-app-sessions | 合成のみ (test/helpers, demo-data) | なし | 書き込まない |
| codex-sessions-fs | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (既定: `~/.codex`)、`session_meta.source=cli` のみ | fake-codex-sessions | 合成 JSONL (`test/codex-sessions.test.mjs`) | なし | 書き込まない。最大 128 KiB の末尾から turn start/complete の code と timestamp のみ採用 |
| copilot-sessions-fs | `$COPILOT_HOME/session-state/<UUID>/events.jsonl` (既定: `~/.copilot`)、`session.start` のproducer/session IDが一致するもの | fake-copilot-sessions | 合成 JSONL (`test/copilot-sessions.test.mjs`) | なし | 書き込まない。先頭と最大128 KiBの末尾からイベントcodeとtimestampだけ採用。保存先はCLIとCopilot appで共有されるため、UIではGitHub Copilotと表示しCLI/appを断定しない |
| transcripts-fs | `<projectsDir>/*/<cliSessionId>.jsonl` と `<cliSessionId>/subagents/**` | fake-transcripts | 合成のみ | なし | 書き込まない (stat と末尾読みだけ。subagents は stat で数えるだけで開かない。全体は読まない) |
| folder-hints-fs | アーカイブしていないセッションの cwd とその親 (`.git` の有無、直下のフォルダ名)。ネットワークのパス (`\\server\share`・`//server/share`) は見ない。1 パス 0.5 秒まで | fake-folder-hints | 合成のみ (os.tmpdir の一時フォルダ) | なし | 書き込まない (stat と readdir だけ) |
| worktrees-git | 直近20件までの非アーカイブセッションの cwd から `git rev-parse --show-toplevel`、`git worktree list --porcelain -z`、`git status --porcelain=v1 -z --untracked-files=normal` を shell なし・timeout 付きで読む | fake-worktrees | 合成porcelain/status (`test/worktrees.test.mjs`) | なし | 読み取りコマンドのみ。APIには branch・状態・件数・locked/prunable だけ返し、パス・ファイル名・ロック理由を破棄 |
| worktrees-git (一覧) | 明示要求された1セッションのcwdから、同じrepoのローカルworktree最大20件を読み取る | fake-worktrees | 合成porcelain/status (`test/worktrees.test.mjs`) | なし | GET時だけ各worktreeのbranch・状態・件数・flags・currentを返す。path・ファイル名・lock reasonは破棄 |
| worktree-remove-git | 明示確認後、選択セッションのcwdから同一repo内のbranch指定worktreeを再検査する | fake-worktree-remove | `test/worktree-remove.test.mjs` のGit mock | なし | current・dirty・locked・prunable・unknown target は拒否。`git worktree remove` のみで `--force` は使わない。ignored filesの削除可能性をUIで説明し、pathと診断は返さない |
| worktree-create-git | 画面で確認したセッションIDからサーバーが解決したcwd。新規branch名だけブラウザーから受ける | fake-worktree-create | `test/worktree-create.test.mjs` のGit/FS mock | なし | 確認後のみ、選択リポジトリの隣にbranch worktreeを作る。session/transcriptファイルは変更しない。hookを一時的に無効化し、checkout filter実行の可能性を確認画面で明示。絶対パス・Git診断は返さない |
| (なし) | ネットワーク | — | — | なし | Pigeonholesは外部サービスへ送信しない。Git checkout filterは確認後のworktree作成時に実行され得るため、確認画面で通知する。配置も言葉も AI を使わない |
| (画面) | ブラウザの localStorage | — | — | なし | 画面の好み (`pigeonholes:v1:ui`: 言語・view・引き継ぎのコピー記録) とキャンバスの席 (`pigeonholes:v1:canvas` と狭い画面の `:narrow`)。その PC のブラウザだけ |

## 3. Origin・監視トポロジ

| 項目 | 内容 |
|---|---|
| 待ち受け | 127.0.0.1 のみ。Host が `127.0.0.1:<port>` / `localhost:<port>` 以外は 403 (DNS rebinding 対策) |
| origin | 同一 origin のみ。CORS ヘッダーなし、CSP `default-src 'self'` (img は `data:` も可: favicon) |
| 監視 | ローカル道具なので常時監視なし。`npm run smoke` が実データで形と件数を確かめる (読み取りのみ) |

## 4. 決定ログ

| 日付+topic | 決定 | 理由と却下案 | lint 昇格 |
|---|---|---|---|
| 2026-10-17 read-only | アプリのファイルは読むだけ。片付けは指示文のコピーで Claude に渡す | 書き込みは競合と破損の危険。却下: idx を直接書く | 有 (arch 5) |
| 2026-10-17 pure-core | core は fs / clock / env を持たず now を引数で受ける | 規則を合成データで固定できる。却下: core で現在時刻を取る | 有 (arch 1) |
| 2026-10-17 projection | parse 直後に許可項目だけへ射影し、fs 版と Fake が同じ関数を通す | 巨大項目と秘密を出さない・Fake と実物の出力一致 | テスト (FORBIDDEN_OUTPUT_KEYS) |
| 2026-10-17 shared-to-browser | shared の constants (と i18n) を `/src/shared/...` で画面にも配信 | 二重管理を避ける。却下: public に複製 | 無 |
| 2026-10-17 dom-only | 画面は textContent と DOM API だけで描く。style 属性も使わない (CSSOM は可) | title・報告は任意の文字列 (XSS)、CSP style-src 'self' | 有 (arch 4b) |
| 2026-10-17 single-fetch | fetch は public/api.mjs だけ | 通信を 1 か所に集める | 有 (arch 4a) |
| 2026-10-18 name | 名前は Pigeonholes、npm と bin は `pigeonholes`、env は `PIGEONHOLES_*`。名前・ロゴ・題名に "Claude" を入れない | 公開用で非公式。却下: Session Board (一般名詞)、Kawaraban (英語話者に伝わらない) | 無 |
| 2026-10-18 codes-on-wire | /api/board v2 はコードと params だけ (reasonText・label の言葉・gloss を削除、500 は `board_failed`)。言葉は public/dict-*.mjs と entry/messages.mjs | 2 言語で JSON と ETag を共有。却下: Accept-Language で JSON を変える | 有 (arch 6: 仮名・漢字の文字列は辞書だけ) |
| 2026-10-18 ui-language | 画面は en 既定、navigator.languages が ja なら ja、`?lang=` が優先、切替は localStorage `pigeonholes:v1:ui`。端末は --lang > PIGEONHOLES_LANG > LC_* / LANG > Intl | OSS で英語話者も使う。日本語の環境なら設定なしで日本語 | テスト (辞書のキーと placeholder の一致) |
| 2026-10-18 oldest-first | 返事待ち・止まったかも・未読は古い順、返事待ちと止まったかもは打ち切らない。作業中は新しい順 | 一番長く待っているものを見落とさない (「他 N 件」に隠れて終わった気になる) | テスト (board) |
| 2026-10-18 started-at | 作業中の経過は transcript の指示行の timestamp (Card.startedAt)。無ければ「更新」の時刻 | 推測しない。却下: lastActivityAt から推定 | テスト (turn) |
| 2026-10-18 format-suspect | 日時の無いレコードが 20% 超 (5 件以上)、またはフォルダはあるのにファイル 0 のとき stats.formatSuspect を立て、おすすめを全部切る | 形式が変わると全部が「30 日以上」に見え、一括で片付けてしまう | テスト (board) |
| 2026-10-18 folder-hints | プロジェクト名は adapter が実際のフォルダの `.git` を見て決めた hint (repo / container) を core が使う。既定の roots は home だけ | 特定の PC のフォルダ配置 (ドライブ) を前提にしない。却下: 既定 roots を増やす | テスト (adapter・project) |
| 2026-10-18 static-allowlist | 配信表は起動時に public/ を読んで作る (決まった拡張子・サブフォルダなし・dotfile なし) + shared の 2 ファイル | 画面のファイル追加で表を直さなくてよい。パスの結合はしない | テスト (server) |
| 2026-10-18 cli | フラグは env に勝つ (--port --demo --lang --sessions-dir --projects-dir --help --version)。セッションフォルダは OS ごとの候補を順に探し、無ければ全部の候補を出して exit 1 | Windows 以外と MSIX 版でも動かす | テスト (entry) |
| 2026-10-18 demo-live | デモの合成データは 1 分ごとに今の時刻から作り直す (entry/demo.mjs) | 起動時に 1 回だけ作ると作業中が止まったかもへ流れ、デモの見た目が時間で崩れる。却下: 時計を止める (古い内容の表示が出る) | テスト (demo-live) |
| 2026-10-18 design-system | 見た目は spec/design.md (Columnar pad) に固定。tokens は light と dark (2 つのセレクタ) をそのまま、CSS は Hallmark の印から始める | 判断の揺れを無くす。却下: light-dark() だけの tokens、状態ごとの色 | 無 |
| 2026-10-18 screen-features | キー操作 (1 文字キーの切替つき)・自分で ON にする通知 (返事待ちと止まったかもだけ)・状態の favicon・全体 (Overview、既定は閉じる)・詳細の親子の木を作る | 以前の「作らないもの」から外した。仕様は spec/ui.md | 無 |
| 2026-10-18 probe-mode | ポートが使用中なら `GET /api/hello` (`{app, demo}`) でこのボードらしいか・デモか実データかを見る。同じ種類なら「もう起動しています」+ 自分で起動していなければ別の番号で、違えば exit 1 で別の番号の起動例 (付けていたフラグつき) | `--demo` のつもりで実データ、またはその逆を開かせない。応答は真似できるので言い切らない。却下: HTML の印 (デモか分からない)、秘密のファイル (書き込みが要る) | テスト (server) |
| 2026-10-18 render-vs-fetch | 取得の失敗 (繋がらない・サーバー・版) と描画の失敗を分ける。描画に失敗したら状態を戻し、etag を進めず、帯で「描けなかった」と言い、理由はコンソールへ | 描画のバグを「繋がらない」と言うと原因の切り分けを誤らせる | 無 |
| 2026-10-18 poll-304 | 304 では日付だけ書き直す。全体 (Overview) は形の署名が変わったときだけ作り直し、時刻・カーソルはその場で合わせる | 5 秒ごとにフォーカスのある印を作り直して読み上げ直させない・画面を引き戻さない | 無 |
| 2026-10-19 canvas | キャンバス表示を作る。配置は純粋関数 (canvas-layout)、席は画面の localStorage だけ。席は勝手に横や上へは動かない | 依頼。同じ入力なら同じ配置。却下: AI による配置 (外部送信・毎回変わる)、力学配置 (毎回動く) | テスト (canvas-layout の決定性・重なりなし) |
| 2026-10-19 overview-retired | v0.1 の全体 (Overview・z) をやめ、キャンバスの縮小表示に任せる。一覧の z はキャンバスを全体表示で開く | 同じものを見る道を 2 つ持たない (株主の承認)。却下: 両方残す | 無 |
| 2026-10-19 activity-label | 「していること」は tail の最後の tool_use からコード + 安全な対象 (basename・commandHead・host)。Claude の短い説明と計画の手順は cleanText を通して出す | 中身ではなく種類を見せる。却下: command 全文、tool_result の表示 | テスト (FORBIDDEN_WIRE_KEYS・commandHead・cleanText) |
| 2026-10-19 context-gauge | セッションごとの量 = 最後の実 usage の input + cache_creation + cache_read。窓は推定 (推定なら「約」)、段階は自動要約点に対する割合 (0.60 / 0.83 / 0.93、帯 0.05)。文字だけで出す | 引き継ぎの判断材料。却下: 窓の % だけで判定 (200K は手前で要約)、合計・費用・グラフ、棒や色 | テスト (context) |
| 2026-10-19 handoff-copy | 引き継ぎは指示文のコピーとセッションを開くことだけ。承認はそのセッションの Claude がアプリの確認で取る。作業中・返事待ちにはボタンを出さない | read-only を守る。却下: ボードからの送信、会話のフォーク | テスト (指示文・ボタンの出る条件) |
| 2026-10-26 confirmed-worktree | セッション詳細から対象repo・基点branch・未コミット変更を示し、新branch名とcheckout filterの確認を受けてworktreeを作る。session filesは常に読み取り専用。デモでは操作を無効にする | 選択先の明示と副作用を確認して、局所的な作業場所を用意する。却下: background作成・CLI起動・パス受信・診断出力 | mock adapter/HTTP test + synthetic UI |
| 2026-10-19 tail-facts | tail は 1 回だけ parse (tailFacts)。結果の memo と前回の段階は service がメモリに持ち、core は引数で受ける。ファイル全体は読まない | 盤面ごとの parse を変わった tail だけにする。却下: core に状態、全文読み (5〜7 秒) | テスト (service) |
| 2026-10-19 measured-rows | キャンバスの行の高さは付箋の中身に合わせる。画面が見えない箱で測り (近く 100% と中くらい 60% の文字の大きさの大きいほう)、配置には数として渡す。足と操作は 1 行、止まったかもの長い行は 2 行分を取る (時刻で行数が変わって行が跳ねない)。席の記録は v 3 | 1 つの大きさの付箋は中身の短いものの下 1/3 が空いた (490px)。却下: 文字数からの見積もり (言語と字幅で外れると最後の行が切れる)、配置の中で DOM を測る (純粋でなくなる) | テスト (行の高さ・刻み・上限) |
| 2026-10-19 ui-file-size | 画面のファイル (public/) は 400 行まで。辞書は dict-<lang>-<part>.mjs に分け、dict-<lang>.mjs が取り込む (キーの重なりはテストで検出) | AI と人が 1 ファイルを読み切れる大きさ。却下: 辞書だけ例外にする (規則が形だけになる) | 有 (arch 7・arch 6 の辞書の型) |
