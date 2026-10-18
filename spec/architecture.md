# アーキテクチャ (Pigeonholes)

形: 4 役割・一方向依存 (entry → adapter → core → shared)。検査は `npm run arch`。Why: アプリが書き換え続けるファイルを読むだけの道具なので、外界 (fs) を adapter に閉じ込め、判定は時計も言葉も持たない純粋関数にして、全規則を合成データのテストで固定する。言葉は画面と端末の辞書だけが持つ。

## 1. 役割対応表 (scripts/arch-check.mjs と 1:1)

| 役割 | パス | 中身 |
|---|---|---|
| shared | src/shared/ | constants.mjs (しきい値・ID 形式・PRODUCT。言葉なし) / types.mjs (JSDoc) / i18n.mjs (fill・fillParts・pickForm・normalizeLang)。何も import しない。constants と i18n は画面にも配信 |
| core | src/core/ | turn / classify / project / board / session / text。fs・clock・env・言葉なし (now は引数、出力はコードと params) |
| adapter | src/adapters/ | app-sessions-fs + fake-app-sessions / transcripts-fs + fake-transcripts / folder-hints-fs + fake-folder-hints / session-record (許可項目への射影・attachFolders) / demo-data (合成、en・ja) / map-limit |
| entry | src/entry/ | server (起動・CLI・shebang) / config (フラグと env の fail-fast、セッションフォルダの候補、起動例の組み立て) / messages (端末の言葉 en・ja) / service (wiring 1 点・2 秒キャッシュ・ETag) / demo (`--demo` の Fake の組。1 分ごとに今の時刻から作り直す) / http (ヘッダー一括・起動時に作る配信表・`/api/hello`) / probe (使用中のポートで応答しているのがこのボードらしいか、デモか実データか) |
| 画面 | public/ | index.html / tokens.css style.css rows.css tidy.css overview.css / app poll state ui-state render front rows cleanup overview keys notify favicon copy view format (.mjs) / i18n.mjs dict-en.mjs dict-ja.mjs (言葉はここだけ) / api.mjs (唯一の fetch)。spec/ui.md §1 |

## 2. 外部境界表

| adapter | 相手 | Fake | fixture | credential | 書込 identity |
|---|---|---|---|---|---|
| app-sessions-fs | セッションフォルダ (board.md §11 の候補) の `*/*/local_*.json` と `archived-sessions.idx` | fake-app-sessions | 合成のみ (test/helpers, demo-data) | なし | 書き込まない |
| transcripts-fs | `<projectsDir>/*/<cliSessionId>.jsonl` と `<cliSessionId>/subagents/**` | fake-transcripts | 合成のみ | なし | 書き込まない (stat と末尾読みだけ) |
| folder-hints-fs | アーカイブしていないセッションの cwd とその親 (`.git` の有無、直下のフォルダ名)。ネットワークのパス (`\\server\share`・`//server/share`) は見ない。1 パス 0.5 秒まで | fake-folder-hints | 合成のみ (os.tmpdir の一時フォルダ) | なし | 書き込まない (stat と readdir だけ) |
| (なし) | ネットワーク | — | — | なし | 外への通信は 0 件 (割り当てたネットワークドライブ上のフォルダだけは、OS がその共有を見に行くことがある) |

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
