# アーキテクチャ (ALBERA)

形: 4 つの読み取り専用アプリ層 (entry → adapter → core → shared) と、そこから分離した Runtime Gateway 境界。検査は `npm run arch`。読み取り専用サーバーから Gateway を import できないこと、Gateway のプロセス起動が独立した層に閉じることを検査する。既存アプリの外界 (fs) は adapter に閉じ込め、判定は時計も言葉も持たない純粋関数にし、全規則を合成データのテストで固定する。言葉は画面と端末の辞書だけが持つ。

## 1. 役割対応表 (scripts/arch-check.mjs と 1:1)

| 役割 | パス | 中身 |
|---|---|---|
| shared | src/shared/ | constants.mjs (しきい値・ID 形式・PRODUCT。言葉なし) / types.mjs (JSDoc) / i18n.mjs (fill・fillParts・pickForm・normalizeLang)。何も import しない。constants と i18n は画面にも配信 |
| core | src/core/ | turn / classify (tailFacts) / project / board / session / text (cleanText) / activity (していること・commandHead) / context (窓・段階・contextMemo)。fs・clock・env・言葉なし (now と前回の段階は引数、出力はコードと params) |
| adapter | src/adapters/ | app-sessions-fs + fake-app-sessions / transcripts-fs + fake-transcripts (末尾・subMtime・subLive) / folder-hints-fs + fake-folder-hints / session-record (許可項目への射影・attachFolders。model は窓のためだけ) / demo-data (合成、en・ja) / map-limit |
| entry | src/entry/ | server (起動・CLI・shebang) / config (フラグと env の fail-fast、セッションフォルダの候補、起動例の組み立て) / messages (端末の言葉 en・ja) / service (wiring 1 点・2 秒キャッシュ・ETag・tail 解析の memo と前回の段階をメモリに持つ) / demo (`--demo` の Fake の組。1 分ごとに今の時刻から作り直す) / http (ヘッダー一括・起動時に作る配信表・`/api/hello`) / probe (使用中のポートで応答しているのがこのボードらしいか、デモか実データか) |
  | runtime | src/runtime/ | `gateway.mjs`: 固定 provider allowlist の実行ファイル検証、ホスト提供の承認 callback、プロセス起動/停止、固定形式のライフサイクルイベントと上限付き購読通知。許可ルートは working directory の検査に限り、OS sandbox ではない。`agent-harness-adapter.mjs`: provider別の固定CLI launch profile。現在はClaude read-onlyのみ許可し、Codex/OpenCodeは利用不可。`approval-broker.mjs`: ホスト内の承認待ちキュー。要求の許可項目だけを射影し、期限・容量を設け、期限切れや閉鎖時は拒否する。`api.mjs`: token 認証付き IPv4 loopback API。Gateway通知でイベント捕捉を起動し、周期ポーリングを安全網として維持する。`approval-host.mjs` + `approval-ui/`: Observerから独立したloopback画面。端末に表示する一回限りbootstrapコードからHttpOnly/SameSite cookieを発行し、CSRF/Originを検査する。承認文面はDOMの`textContent`で描画し、API bearer tokenはブラウザーに渡さない。`host.mjs` + `entry.mjs`: Runtimeだけの起動経路。既存のread-only serverへの実行機能の統合は行わない。`supervisor.mjs` + `guardian.mjs`: 親Gatewayのstdin pipe切断を監視し、異常終了時に実行プロセス木を停止する。Guardian自身の異常終了時の漏えい防止は保証しない。`audit-journal.mjs`: ホストが明示した保存先に対する単一書き込み・追記専用の秘密情報を除く監査記録とライフサイクル履歴。Windows DACLとPOSIX owner/modeを無変更で検証し、複数linkのjournal/lock fileを拒否する。API再起動時に同一 session の履歴を再生し、未完了runを`interrupted`として返す。`journal-backup.mjs`: 利用者が明示した停止中のjournalをscrypt + AES-256-GCMで暗号化し、既存データを上書きせず新規ファイル/復元先を作る。`environment-provider.mjs` / `environment-operations.mjs` / `mock-environment-provider.mjs`: Provider契約、揮発性coordinator、障害注入可能なMock。`environment-host-broker.mjs`: Durable coordinatorからProvider操作を分離するLocal contract adapter。SQLite journalから一度だけdispatch claimを解決し、Provider method参照を構築時に固定する。これは同一プロセス内の境界であり、認証IPC・サービスID・権限分離は提供しない。`computer-scheduler.mjs`: host登録済みcapacityから決定的に候補を選び、プロジェクトのhard quotaと同一SQLite transaction内でLease reservationを確定する。Provider起動やVM作成は行わない。`sqlite-operation-store.mjs`: Node `node:sqlite`によるprivate SQLite WAL上のOperation/Computer/Lease状態と冪等journal。Provider操作はintentを先に保存し、UNKNOWNは再実行せずinspectで照合する。schema v1-v3からv4は既存データを保持して列、Guest event receipt table、one-time operation authorization ledgerを追加する。Guest eventは認証済みtransportの後段でのみ記録し、active Lease/generation照合とsequenceの永続dedupeを行い、Guest claimをuntrusted provenanceで追記する。`boundary-protocols.mjs`: Broker要求とGuest command/eventのtransport-independent schema。Guest報告は`untrusted_guest` provenanceで正規化し、Computer/Run/Lease generationとevent sequenceはHost側の信頼済み記録と照合する。プロトコル検証は認証・IPC・Provider実行を実装しない。experimental SQLite APIに依存するためNode 22.13以上を要求する。 |
| 画面 | public/ | index.html / tokens.css style.css rows.css tidy.css canvas.css / app actions poll state ui-state render front rows labels cleanup handoff keys notify favicon copy view format times (.mjs) / canvas canvas-slip canvas-sheet canvas-fit canvas-bar canvas-ctl canvas-view canvas-act canvas-layout canvas-desk canvas-fold canvas-camera canvas-input (.mjs、layout・desk・fold・camera は純粋。fit は見えない箱で付箋の中身の高さを測り、layout に入力として渡す) / doing.mjs (していることの言葉、純粋) / i18n.mjs dict-en.mjs dict-ja.mjs dict-en-canvas.mjs dict-ja-canvas.mjs dict-en-handoff.mjs dict-ja-handoff.mjs (言葉はここだけ。dict-<lang>-<part>.mjs は 400 行のための分割) / api.mjs (唯一の fetch)。画面のファイルは 400 行まで (arch 7)。spec/ui.md §1 |

## 2. 外部境界表

| adapter | 相手 | Fake | fixture | credential | 書込 identity |
|---|---|---|---|---|---|
| app-sessions-fs | セッションフォルダ (board.md §11 の候補) の `*/*/local_*.json` と `archived-sessions.idx` | fake-app-sessions | 合成のみ (test/helpers, demo-data) | なし | 書き込まない |
| transcripts-fs | `<projectsDir>/*/<cliSessionId>.jsonl` と `<cliSessionId>/subagents/**` | fake-transcripts | 合成のみ | なし | 書き込まない (stat と末尾読みだけ。subagents は stat で数えるだけで開かない。全体は読まない) |
| folder-hints-fs | アーカイブしていないセッションの cwd とその親 (`.git` の有無、直下のフォルダ名)。ネットワークのパス (`\\server\share`・`//server/share`) は見ない。1 パス 0.5 秒まで | fake-folder-hints | 合成のみ (os.tmpdir の一時フォルダ) | なし | 書き込まない (stat と readdir だけ) |
| (なし) | ネットワーク | — | — | なし | 外への通信は 0 件 (割り当てたネットワークドライブ上のフォルダだけは、OS がその共有を見に行くことがある)。配置も言葉も AI を使わない |
| (画面) | ブラウザの localStorage | — | — | なし | 画面の好み (`albera:v1:ui`: 言語・view・引き継ぎのコピー記録) とキャンバスの席 (`albera:v1:canvas` と狭い画面の `:narrow`)。新キーが無いか壊れている場合は旧 `pigeonholes:v1:*` を読み込み、旧データは削除しない。その PC のブラウザだけ |

## 3. Origin・監視トポロジ

| 項目 | 内容 |
|---|---|
| 待ち受け | 既存ダッシュボードは127.0.0.1のみ。Host が `127.0.0.1:<port>` / `localhost:<port>` 以外は 403 (DNS rebinding 対策)。Runtime API prototype もIPv4 loopbackのみで、別 credential が必要 |
| origin | 同一 origin のみ。CORS ヘッダーなし、CSP `default-src 'self'` (img は `data:` も可: favicon) |
| 監視 | ローカル道具なので常時監視なし。`npm run smoke` が実データで形と件数を確かめる (読み取りのみ) |

## 4. 決定ログ

### Runtime environment operation boundary (opt-in prototype)

`src/runtime/environment-control-plane.mjs` binds the separately authenticated Runtime API session to the operation `subjectId`, obtains `policyVersion` from a trusted host resolver, rejects caller-supplied trust/approval fields, checks operation ownership before reconciliation, and returns an explicit safe projection. `api.mjs` exposes these routes only when this service is explicitly composed and only through separately minted `environments:execute` / `environments:reconcile` credentials. `createRuntimeHost()` and the read-only Observer do not compose it. The resolver and coordinator authorization callback are trusted host seams, not a human approval verifier; this remains a local prototype and does not satisfy ADR-002's authenticated Control Plane-to-Broker IPC, service identity or privilege separation. No public UI mints these capabilities.

| 日付+topic | 決定 | 理由と却下案 | lint 昇格 |
|---|---|---|---|
| 2026-10-17 read-only | アプリのファイルは読むだけ。片付けは指示文のコピーで Claude に渡す | 書き込みは競合と破損の危険。却下: idx を直接書く | 有 (arch 5) |
| 2026-10-17 pure-core | core は fs / clock / env を持たず now を引数で受ける | 規則を合成データで固定できる。却下: core で現在時刻を取る | 有 (arch 1) |
| 2026-10-17 projection | parse 直後に許可項目だけへ射影し、fs 版と Fake が同じ関数を通す | 巨大項目と秘密を出さない・Fake と実物の出力一致 | テスト (FORBIDDEN_OUTPUT_KEYS) |
| 2026-10-17 shared-to-browser | shared の constants (と i18n) を `/src/shared/...` で画面にも配信 | 二重管理を避ける。却下: public に複製 | 無 |
| 2026-10-17 dom-only | 画面は textContent と DOM API だけで描く。style 属性も使わない (CSSOM は可) | title・報告は任意の文字列 (XSS)、CSP style-src 'self' | 有 (arch 4b) |
| 2026-10-17 single-fetch | fetch は public/api.mjs だけ | 通信を 1 か所に集める | 有 (arch 4a) |
| 2026-10-18 name | 名前は Pigeonholes、npm と bin は `pigeonholes`、env は `PIGEONHOLES_*`。名前・ロゴ・題名に "Claude" を入れない | 公開用で非公式。却下: Session Board (一般名詞)、Kawaraban (英語話者に伝わらない) | 無 |
| 2026-10-27 rebrand | 製品名・npm/bin・画面と新しい設定名を ALBERA / `albera` / `ALBERA_*` に変更。旧 env 名とブラウザ保存キーは読み込み互換を維持し、保存キー移行で削除しない | アンニ・アルバースの織物芸術に着想した開発プラットフォーム。現行機能の read-only 制約と範囲は維持 | テスト・arch |
| 2026-10-18 codes-on-wire | /api/board v2 はコードと params だけ (reasonText・label の言葉・gloss を削除、500 は `board_failed`)。言葉は public/dict-*.mjs と entry/messages.mjs | 2 言語で JSON と ETag を共有。却下: Accept-Language で JSON を変える | 有 (arch 6: 仮名・漢字の文字列は辞書だけ) |
| 2026-10-18 ui-language | 画面は en 既定、navigator.languages が ja なら ja、`?lang=` が優先、切替は localStorage `albera:v1:ui`。端末は --lang > ALBERA_LANG > LC_* / LANG > Intl | OSS で英語話者も使う。日本語の環境なら設定なしで日本語 | テスト (辞書のキーと placeholder の一致) |
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
| 2026-10-19 tail-facts | tail は 1 回だけ parse (tailFacts)。結果の memo と前回の段階は service がメモリに持ち、core は引数で受ける。ファイル全体は読まない | 盤面ごとの parse を変わった tail だけにする。却下: core に状態、全文読み (5〜7 秒) | テスト (service) |
| 2026-10-19 measured-rows | キャンバスの行の高さは付箋の中身に合わせる。画面が見えない箱で測り (近く 100% と中くらい 60% の文字の大きさの大きいほう)、配置には数として渡す。足と操作は 1 行、止まったかもの長い行は 2 行分を取る (時刻で行数が変わって行が跳ねない)。席の記録は v 3 | 1 つの大きさの付箋は中身の短いものの下 1/3 が空いた (490px)。却下: 文字数からの見積もり (言語と字幅で外れると最後の行が切れる)、配置の中で DOM を測る (純粋でなくなる) | テスト (行の高さ・刻み・上限) |
| 2026-10-19 ui-file-size | 画面のファイル (public/) は 400 行まで。辞書は dict-<lang>-<part>.mjs に分け、dict-<lang>.mjs が取り込む (キーの重なりはテストで検出) | AI と人が 1 ファイルを読み切れる大きさ。却下: 辞書だけ例外にする (規則が形だけになる) | 有 (arch 7・arch 6 の辞書の型) |
