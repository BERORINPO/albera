# Agent Canvas MVP: 現状と最初の縦断機能

## 調査結果 (2026-10-26)

対象: `BERORINPO/pigeonholes` の `main` (`933cf35`, `0.2.0`)。作業ブランチ `feat/codex-cli-sessions` で調査。

### すでにあるもの

- `public/` にプロジェクト単位のキャンバス、用紙配置、ズーム、詳細表示がある。配置状態はブラウザ内に保存される。
- `src/adapters/` が Claude Code のセッション一覧・JSONL transcript・プロジェクト情報を読み取り専用で取得し、`src/core/` が状態やアクティビティを判定する。
- 表示は 5 秒ごとに更新され、最後の安全なアクティビティ要約 (ツール種別、ファイル名、コマンド名など) をカードと詳細に出す。生のツール出力や入力は表示しない。
- 引き継ぎは指示文をコピーする方式。ユーザーが元アプリで内容を確認し、セッションの開始を承認する。
- HTTP は `127.0.0.1` のみ、依存は Node.js 22 標準機能のみ。`npm test`、`npm run arch`、`npm run smoke` が開発時の検査経路。
- Git は `main` のみで、作業開始時点に既存の変更はなかった。既存の変更を引き継いだり `main` を変更したりしていない。

### 壁打ち構想とのギャップ

- 壁打ちで確認できた意図は「Claude Code/Codex CLI などの実セッション・イベント・ハーネス・委譲をキャンバス上で把握する」「REAを活用する」「理解負債を見つけて解消する」。
- 「理解度」は進捗確認を受ける側の理解を指す。この対象の意味は維持する。
- 現行MVPはClaude/Codexの読み取り専用セッション表示、許可イベントの時系列、状態分類まで。実セッションとの適合性はこの環境で未確認。
- ハーネスの具体的な定義・表示、委譲関係のモデルと操作、REAの意味・データ・運用、理解負債の判定・解消手順はリポジトリ仕様にない。理解度の採点・推定、自動検出、これらのデータ構造や操作は推測で追加せず、今後の設計確認事項として残す。
- Obsidian、追加CLI/WSL、音声 Main AI、企業権限制御も現行範囲外。

## MVP で最初に通す縦断機能

**Codex CLI のローカルセッションを読み取り、イベント要約を既存キャンバスに表示する。**

### 完了条件

1. Codex CLI が作るセッションファイルを read-only で検出し、Claude 用 adapter と分離して解析する。
2. 既存のカード形式に source を追加し、Claude と Codex のセッションを同じプロジェクトキャンバスに表示できる。
3. 詳細に時刻順のイベント要約を表示する。ツール入力・出力、プロンプト本文、環境変数、トークンや認証情報は wire format に含めない。
4. 合成 fixture で検出・未完了イベント・終了イベント・壊れた行・不明イベントを検証し、両 CLI のイベントを混在させても既存 Claude 表示が変わらないことを確認する。
5. `npm test` と `npm run arch` を通し、起動・更新が read-only であることを確認する。
6. 診断欄でCodexの候補・認識件数と、0件になる理由を安全な集計値で説明する。

### 設計上の制約

- 現行の「読み取り専用」保証、127.0.0.1 bind、依存ゼロ、pure core / filesystem adapter 分離を保つ。
- CLI ごとの保存形式を共通 model に直接漏らさず、adapter で allowlist した event code と安全な表示パラメーターに射影する。
- 未知のイベントや形式変化時にはセッションを誤分類せず、イベント表示を抑止する。
- 自動委譲や worktree の作成はこの縦断機能の完了条件に混ぜず、後続段階で別途レビュー可能にする。

## 段階案

1. Codex CLI adapter と fixture、source-aware 共通モデル。
2. 既存キャンバスのカード/詳細へイベント要約を表示。
3. Claude/Codex を横断する read-only session relation と手動委譲案内。
4. Git worktree の作成・回収を明示操作に限定して追加し、PM ポリシーを設定可能にする。
5. 知識層、理解負債グラフ、追加 CLI/WSL、音声、組織権限は実利用と脅威モデルを確認してから設計する。

この段階案は調査時の実装提案であり、将来機能の仕様を確定するものではない。

## 実装状況 (2026-10-26)

- `codex-sessions-fs` は `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` を読み取り専用で走査し、`session_meta.source=cli` かつ Codex originator のファイルに限定する。Claude の session root が無くても Codex root があれば起動できる。
- Codex adapter は `task_started` / `turn_started` と `task_complete` / `turn_complete` の時刻だけを共通 event code にする。最後の開始が完了より新しければ作業中、完了なら最近、それ以外は不明状態として最近に置く。15 分以上更新が無い進行中セッションは止まったかもへ移る。Codex は Claude のアーカイブ・引き継ぎ操作に渡さない。
- `/api/board` の Codex card は `source` と最大 30 件の `{type, at}` のみをイベント情報として返す。メタデータの cwd はプロジェクト判定に限り、詳細や wire に出さない。プロンプト、メッセージ、command/tool payload、環境値、モデル名、トークン量は読み取った後も保持しない。
- Codex診断は候補ファイル数、認識セッション数、状態ごとの件数、除外・不良件数のみを返す。候補0、認識0、作業中0の理由を診断欄に表示する。作業中0は、認識できるセッションがない、完了/中断済み、または未完了ターンの更新が15分以上前で「止まったかも」に分類された場合に起こる。
- この環境の安全なローカル集計では候補 rollout 35件・CLI適合0件だった。実セッションがキャンバスへ表示されることは未確認であり、合成 fixture の結果を実データ検証として扱わない。
- 形式根拠: OpenAI Codex の公式 rollout test helper は `CODEX_HOME/sessions/YYYY/MM/DD/rollout-...jsonl`、`session_meta`、`event_msg`、`SessionSource::Cli` を使う。ローカルの実データでは同じ JSONL envelope / event tags を確認したが、利用可能な実ファイルは Desktop / VS Code / exec 起点で、CLI 起点の実データ例は確認できなかった。そのため `source=cli` / `originator=codex` の判定は公式 helper に基づく。ここで未確認なのは、このユーザー環境の CLI 記録がこの厳密な marker 組を持つかであり、一致しない記録は安全側に倒して除外する。

## 後続の Agent Canvas 段階 (2026-10-26)

- ユーザーが依頼した次の縦断機能として、ユーザー作成のタスク・成果物・判断・理解負債カードと関係線を canvas に追加する。ブラウザー内だけに保存し、セッション・プロンプト・ツール内容を複製しない。詳細は `spec/ui.md` §10.11。
- 「理解」は進捗を確認される側の理解を指す。根拠のないスコアは作らず、理解を確認される人、不足根拠、必要な説明をカードに記録する。
- `delegates` は手動記録を基本とし、完了済みローカルCodex CLIへの確認付きread-only resumeまで実装済み。PM policy、実行条件の検出、Obsidian、WSL、音声 Main AI、企業権限制御の完成条件は後続の製品像依頼で拡張された。ユーザーは未記載PM規則を「この依頼の安全条件だけ」と指定。worktreeの一覧・作成・確認付き削除とpath-freeなキャンバス記録は実装済みだが、実ユーザーrepo上でのGit操作は未検証。
- REA はユーザー指定の `morluto/rea` (REA: Reverse Engineer Anything) と特定された。公式READMEは、ローカル実行のCLI/MCPからバイナリ・アプリ・実行時挙動を解析し、根拠と制約を含む結果を返すOSSと説明する。ユーザーはキャンバス連携として「ユーザーが確認した短い要約を手動で記録」と指定した。REA所見は成果物カードに入力し、関連タスク・判断・セッションへユーザーが関係付ける。完全なEvidenceは取り込まず、REA自体も起動しない。
- WSLについて、ユーザーは製品像の対象に含めたが、接続方式の細部は指定していない。安全側の暫定実装として、Windowsで `CODEX_HOME` が `\\wsl.localhost\<distro>` / `\\wsl$\<distro>` の明示共有を指す場合だけ、CodexのPOSIX cwdを内部共有パスへ対応付ける。自動distro列挙、`wsl.exe` 実行、任意UNC探索はしない。共有パスはAPIへ出さず、WSLのGit worktree操作は未対応として画面とサーバーで抑止する。実WSL共有は未検証であり、この方式が製品として意図された接続方式かは確認事項として残す。
- デモにはWSL場所ラベルを持つ固定の合成Codexセッションを含め、UIの詳細とworktree操作の説明を実データなしで確認できるようにする。合成レコードを実セッション検出の証拠とは扱わない。
- PM policy は「この依頼の安全条件だけ適用」と確認した。個別の自動化・承認規則は追加しない。
- 実装のフォローアップはMVPのPR #3を変更せず、後続PRで扱う。
- 2026-10-26: worktreeの読み取り専用状態調査を開始。最大20件の最近の未アーカイブセッションを対象にし、porcelain出力から安全な要約だけをセッション詳細へ渡す。個別PMポリシーは未定義のまま (依頼にある安全条件のみ)。
- 2026-10-26: セッション詳細から明示確認後にローカルworktreeを作るAPIと、同じrepository内の最大20件のpath-free一覧を段階追加。作成結果はブラウザー内のスナップショットカードとして元セッションと関連付ける。カードはlive registryではなく、編集・削除はGit状態を変えない。
- 2026-10-26: 読み取り専用一覧のworktreeを、明示操作で元セッションに結び付けてキャンバスへ記録できる。同じbranchの再記録はカード内容だけを更新し、配置を保つ。これはlocalStorageへの記録で、Git状態は変更しない。
- 2026-10-26: worktree削除は、一覧でclean・非current・非locked・非prunableと確認できるbranch worktreeだけを対象に、ブランチ名の入力と影響確認を要求する画面を追加。削除は作業フォルダに限りbranchは残す。ignored filesが消える可能性を明記し、デモでは無効。追加の実Git統合テストでは、OS一時領域内に作った合成repoに対して作成・状態一覧・確認済み削除を通し、branchが残ることを確認。ユーザーのrepo/worktreeは操作せず、remoteも設定していない。UI上の確認dialogを通す手動操作はこの統合テストでは対象外。
- 2026-10-26: 次の独立段階として GitHub Copilot のローカル `session-state/<UUID>/events.jsonl` を追加。read-only adapter が固定されたイベント種別と時刻だけを許可し、Codexと同じ一覧・キャンバス・詳細・source filterに統合する。フォーム/イベントの不一致と不明イベントを安全側で除外し、診断には候補・認識・状態・除外件数のみを返す。合成デモにCopilotカードを1件追加。
- CopilotのCLIとCopilotアプリは同じ `COPILOT_HOME/session-state` を使う。記録のproducer名だけでCLI由来と断定せず、画面上のsource名は「GitHub Copilot」とする。公式の保存先資料とSDKイベント型を実装根拠とした。ローカルの確認では対象ディレクトリは存在したものの `events.jsonl` は0件だったため、実セッション適合性・実データ表示は未検証のまま。fixtureとデモの結果を実データ確認と扱わない。
- 形式根拠: [Copilot CLI config directory reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference) と [Copilot session data](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/session-data) は `session-state/<id>/events.jsonl` の保存先とCLI/app共有を説明する。イベント名は [Copilot SDK generated session event types](https://github.com/github/copilot-sdk/blob/c57638f4a7ce2255a34192d5035932d0e109bbdd/nodejs/src/generated/session-events.ts) に基づく。CLI固有markerではないため、Copilot CLIだけの記録と区別できることは保証しない。
- 2026-10-26: OpenCode縦断段階を追加。`OPENCODE_DB` (既定 `~/.local/share/opencode/opencode.db`) をNode `node:sqlite` のread-onlyで開き、公式V2 `session_v2` / `session_message` の allowlist列だけ読む。wireにはOpenCode source・opaque session ID・時刻・許可イベントコードだけを出し、親IDはopaque化する。idle outcomeは成功・中断・失敗だけを分類し、不明 outcome/JSONはunknownに倒す。旧 `session` スキーマではテーブル構造で識別した上で、安全な一覧用カラム (ID、プロジェクト判定用ディレクトリ、親ID、作成/更新時刻) だけを読み、transcriptテーブルには触れない。旧形式の状態とイベントはunknownで表示し、読み込み状態に明記する。未知形式は除外する。SQLite APIはNode上でexperimentalであり、Node 22.18+ (22系) または24.4+のみ使用する。
- OpenCode形式の根拠: [OpenCode storage docs](https://github.com/anomalyco/opencode/blob/dev/services/www/src/docs/content/cli/providers.mdx) は既定の `opencode.db`、`XDG_DATA_HOME`、リリースチャンネルと `OPENCODE_DB` による場所変更を説明する。[OpenCode session schema](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/sql.ts) と [session message types](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/session-message.ts) のV2定義を根拠にする。read-only optionのruntime gateは [Node.js SQLite docs](https://nodejs.org/api/sqlite.html) の追加バージョン履歴に基づく。
- 2026-10-26: 安全なローカル確認で設定先DBのテーブル構造が現行V2ではなくlegacy `session` 系と確認できた。adapterは安全な一覧列だけを読むlegacy分岐を追加し、状態/イベントは推定せずunknownとする。実DBから複数のセッション要約が読み込まれ、APIとOpenCode絞り込み後の一覧で表示されることを確認した。確認時のチャット/ログには集計値のみを出し、本文・識別子・パスは確認も出力もしていない。CLIか別OpenCodeクライアント由来かは識別できない。
- REAはユーザー指定の `morluto/rea`、正式名は **REA: Reverse Engineer Anything**。利用者が確認した短い所見を成果物カードへ手動記録し、グラフ関係でセッション・タスク・判断と結ぶ方式で合意。REAセットアップ、解析コマンド、自動取込は行わない。
- 実行条件はユーザーが固定選択肢で手動記録するexecution profileとして追加。場所、作業領域の分離、ネットワーク、承認方式の初期値はすべて「不明」。セッション・環境・アプリ設定からの自動検出ではなく、値が正しいことも検証しない。
- 製品像の未完了: WSLは明示WSL共有経由のopt-in adapterと合成UI例を追加したが、実WSLファイル共有・実セッションとの適合性は未確認。Copilot保存形式はCLI/app共通のためCLIだけとは識別せず、OpenCode legacy形式も状態/イベントはunknownのまま扱う。実行条件の自動検出、worktreeの実Git確認、Obsidian vault indexing/knowledge extraction、REAの自動解析/完全Evidence取込は未完了。ユーザーは音声Main AIと企業権限制御を完成条件として確認したが、音声の開始/停止主体・処理/保存先と、利用者ロール・許可/禁止操作の仕様は提示待ちであり、ここでは推測して実装しない。Obsidianは手動vault-relative note参照のみ追加し、vault走査や内容取得はしない。委譲は完了済みローカルCodexセッションへの確認付きread-only resumeまで実装したが、実CLI実行は未確認で、一般的なprovider間委譲は未実装。理解負債はユーザー記述の対象者・不足根拠・必要説明をカードに記録するだけで、自動推定やスコアはない。
- REA OSSはユーザー指定の https://github.com/morluto/rea.git と確認済み。キャンバスにはユーザーが確認した短い要約を成果物カードへ手動入力し、関連するグラフ対象へ結ぶ。成果物の説明欄は既存モデルで最大1,000文字、参照URLは安全なHTTPSに限定。完全Evidenceの取込・REA実行はしない。
- REA連携の安全境界: 公式の [CLI and Evidence guide](https://github.com/morluto/rea/blob/main/docs/cli.md) は `--json` が完全なEvidenceを返し、実アプリでは数百MBになる場合があると説明する。公式 [MCP contracts](https://github.com/morluto/rea/blob/main/docs/mcp-contracts.md) も完全なcanonical Evidenceをツール結果に保持するとしている。REAのランタイム解析は対象の起動・操作を伴うため、Pigeonholesは結果を自動取込せず、REA実行もしない。利用者が内容を確認して要約を入力する運用は合意済み。要約本文に機密情報を含めないのは入力者の責任で、Pigeonholesはその意味内容を判定しない。
- 2026-10-26: ユーザーが明示した実行条件表示の段階として、値を推測しない手動execution profileカードを実装。4項目の選択肢をallowlist化し、空の値は不明に正規化。詳細・一覧カード・検索・localStorageに限って扱い、セッションAPI/wireには追加しない。
- 2026-10-26: セッション詳細にも関連付け済みexecution profileの4項目を手動情報として表示し、projectionは許可済みのenum項目だけに限定。body/URL/未知フィールドは詳細projectionに含めない。実行環境の事実確認とは扱わない。
- 2026-10-26: セッション詳細で理解負債カードの `evidence` / `explains` 接続先も、カード題名または実行元+短いopaque IDで確認できる。パス・本文・URLは含めず、理解度は推定しない。
- 2026-10-26: セッション詳細の理解負債から根拠/説明の接続先をボタンで開ける。グラフカードはカード編集、セッションは実行元と末尾12文字のopaque IDで一意に解決し、衝突時は何も開かない。画面に完全なセッションIDは出さない。
- 2026-10-26: Obsidian Knowledge Layerの限定的な手動参照段階を追加。ユーザーがvault名と相対note pathをカードへ入力し、関連するタスク/判断/成果物/セッションへ接続できる。URI仕様は公式 [Obsidian URI guide](https://help.obsidian.md/Extending%2BObsidian/Obsidian%2BURI) の `open?vault=…&file=…` に従い、クリック時だけObsidianを開く。ファイル走査・読取・書込は行わない。vault indexingや知識抽出は未実装。
- 2026-10-26: 関連するObsidianノートをセッション詳細からも明示リンクで開ける。ノートURIはブラウザー内グラフから組み立て、session projection/APIにはvault/pathを渡さない。合成画面で関連付けとリンク表示を確認し、プロトコルは起動していない。

## 製品像への追跡表 (2026-10-26)

| 領域 | 現在の実装 | 未完了・証拠の限界 |
|---|---|---|
| 操作可能なCanvas | 一覧/Canvas切替、検索とsource/state/project絞り込み、session slipsとtask/artifact/decision/worktree/理解負債/execution profile/Obsidian参照カード、ドラッグ・キーボード移動、パン・ズーム、関係線、localStorage復元 | 2026-10-26の合成ブラウザー確認で複数providerの複合絞り込み、カード位置/関係/表示切替の再読み込み保持、詳細からのタスク作成と理解負債リンク、worktreeの確認付き作成/削除、空状態/WSL診断、320/400/768/1280pxの表示と一部キーボードフォーカスを確認。全ダイアログ/全ショートカット/スクリーンリーダー受入、ブラウザーでの最新委譲線表示、実セッション表示は未確認 |
| セッション・イベント | Claude Code、Codex CLI、Copilot、OpenCodeにread-only adapterがあり、同じboardでallowlistイベント・状態・詳細を表示。関係pickerも表示中の全providerを対象とする | Codex CLI起点の実セッションは未確認。Copilot保存先はCLI/app共通、OpenCode DBもproducer clientをadapterが識別しない。OpenCode旧schemaは一覧以外の状態/イベントをunknown扱い |
| ハーネス・実行条件 | 詳細に観測可能なprovider/sourceを表示。Codex CLIはCLI markerを満たす記録に限定。場所・分離・network・approvalは不明初期値の手動profileとして関連付け可能 | Copilot/OpenCodeではCLIかアプリかを断定できない。セッションや環境から実行条件を自動検出しない。profile値は利用者申告で、実際の設定・モデル・実行条件の証明ではない |
| 委譲 | 委譲元/先、目的、状態を関係線と詳細に記録し、完了済みローカルCodexへのread-only実行を最終確認後に開始 | purpose-only stdin、read-only sandbox、出力破棄、固定状態APIをmockで確認。operation IDはcanvasのlocalStorageに保存し、再読込後に明示的な状態確認が可能。サーバー再起動で状態が失われた場合は再試行せずblockedへ閉じる。実CLIは未起動、実セッション互換性と一般provider間委譲は未確認/未実装 |
| Git worktree / PM policy | local Git worktreeの読取一覧、明示確認後の作成、clean/non-current等を再確認した確認付き削除、canvas上のpath-free記録。作成/一覧/削除adapterは一時Git repoで統合確認済み | 一時Git repoと合成Codex fixtureを使い、作成dialogの対象/影響説明とack必須、削除dialogの正確なブランチ名+ack必須、削除後のcanvas記録更新までブラウザーで確認。実ユーザーrepoへの操作は未確認。合成WSL詳細では未対応理由を表示し、作成操作を出さないことも確認。WSL worktree操作は無効。PM policyは「この依頼の安全条件だけ」で、追加の自動規則なし |
| Comprehension Graph / 理解負債 | 理解を確認される人、未提示の根拠、必要な説明を記録。`evidence`/`explains`未接続を検出し、関係種別を初期選択した接続フォームへ進める | 人の理解度を推定・採点しない。カードの記録と根拠先の妥当性判断は利用者に残る。自動で実セッション内容から理解負債を発見する機能ではない |
| REA / Knowledge Layer | ユーザー確認済みの短いREA要約をartifactへ手動記録。Obsidian vault-relative note URIを手動登録して明示リンクで開く | REAは起動せず完全Evidenceを取込まない。Obsidian vault走査、内容読取/書込、indexing/知識抽出は未実装 |
| OpenCode / Copilot / WSL | OpenCode DBとCopilotイベントのread-only adapter。明示設定されたWSL共有を使うopt-in Codex reader | 実WSL共有は未確認。CLI/app producer識別、OpenCode legacy状態、未知形式の挙動には上記の制限がある |
| 音声 Main AI | なし | ユーザーは完成条件と指定。開始/停止主体、音声・文字起こしの処理先/保存先、同意と削除の仕様は貼付待ち。推測実装しない |
| 企業向け権限制御 | なし | ユーザーは完成条件と指定。利用者role、操作ごとの許可/禁止、監査・組織設定の仕様は貼付待ち。推測実装しない |

この表は実装済みと未確認を区別する追跡情報であり、未完了項目の代替完成条件ではない。音声Main AI・企業権限・一般provider間委譲の仕様/運用が決まり、それぞれ実装・検証され、実セッション対応などの未確認点も解消するまではAgent Canvas製品像全体を完了扱いにしない。

### 空状態のブラウザー確認 (2026-10-26)

- すべてのprovider保存先を空にした隔離環境で起動し、合成・実セッションを一件も読み込まない状態を確認した。画面は「セッションはまだありません」と表示し、理由と確認先を「読み込みの状態」へ案内する。
- provider別診断はCodex CLIがrolloutファイルなし、GitHub Copilotがevents.jsonlなし、OpenCodeがDBなしを理由として示した。件数はすべて0で、秘密値や保存先パスは画面に出なかった。
- これは空状態UIの確認であり、Codex CLI実セッションの検出、Claudeの実データ表示、狭幅・キーボードの全受入確認を証明しない。

### 理解負債の接続レビュー導線 (2026-10-26)

- open状態の理解負債カードで未接続の `evidence` / `explains` 関係ごとに専用ボタンを表示し、選んだ種別を初期選択した接続フォームへ進む。接続先はユーザーが選び、追加された関係はユーザー記録としてグラフに保存する。
- 合成デモでカード追加、対象者/不足根拠/必要説明の記入、2種類の関係の接続、未接続バッジの消失、新規タブでの関係と状態の復元をブラウザー操作で確認した。理解度の採点や推定は行わない。
- 実際の関係先が根拠として妥当かどうかの判断は利用者に残る。合成データでの画面確認であり、実セッションや実データの理解状態を検証したものではない。

### 400px画面とキーボードの部分受入 (2026-10-26)

- 400px幅の合成デモで一覧からCanvasへ切り替え、プロジェクトシートが幅376pxで表示されること、document/canvasの横scrollWidthが400px以内であることを確認した。
- 同じ幅でカード追加・編集ダイアログを開き、幅362px・タイトル入力への初期フォーカスと可視outlineを確認した。Escapeで閉じた後に元のカードへフォーカスが戻ること、カードにフォーカスしてArrowRightで移動しEnterで編集を開けることも確認した。
- この確認は合成デモの400px幅と上記キー操作のみ。全ショートカット、各モーダル・フィルター、別の狭幅や実データの受入は未確認。

### セッション詳細とタスク接続のGUI確認 (2026-10-26)

- 隔離した`--demo`ボードで合成Codex WSLセッションの詳細を開き、ライフサイクル状態、Codex CLIハーネスとWSLの場所、安全なイベント要約、ブランチ、追跡対象の変更件数、worktree状態、作成時刻を確認した。WSLではworktree操作が未対応である説明も表示された。
- 詳細パネルの「関連タスクを作成」を使い、タスク種別と安全な既定タイトルが入った編集画面から保存した。ローカルのタスクカードと`related`関係が作られ、詳細に関係先・方向・目的が表示された。再読み込み後にセッション詳細を開き直してカードと関係の復元を確認した。Escapeで詳細が閉じ、元のセッションカードへフォーカスが戻った。
- この確認に使ったセッションとグラフデータはすべて合成/ブラウザー保存データ。CLI、provider、実セッション保存先、WSL共有、Gitリポジトリ、外部サービスにはアクセスしていない。この1つの詳細からタスクへの経路の確認であり、全詳細項目や実Codex形式の適合性を確認したものではない。
- 確認後、`127.0.0.1:19089`のデモサーバーを停止した。音声Main AI、企業権限規則、実セッションとの適合性は上記の未完了項目として残る。

### 既存Codex保存先のプライバシー優先プリフライト (2026-10-26)

- 実データを読む前にCodex adapterを確認した。ファイルは読み取り専用で開き、先頭の上限付きヘッダーからセッション識別に必要なメタデータだけを判定する。CLI markerに合う場合に限り、末尾の上限付き範囲から許可したイベント種別と時刻を抽出し、API/board projectionから作業パスを除外する。プロンプト、ツール入出力、環境値、認証情報、フルパスを出力しない。
- 現在設定されているローカル保存先をadapterで一度走査した時点では候補35件、認識0件、表示0件だった。追加のヘッダー限定分類でもJSONLの`session_meta`は確認できたが、`source: cli`およびadapterのCLI originator allowlistを満たすものは0件だった。走査間で候補数が変わったため、件数は時点依存として扱う。
- どのファイル名、ID、ヘッダー値、本文・イベント行も画面・ログ・PRへ出していない。CLI以外または未知のproducerをCodex CLIとして誤表示しないため、末尾のイベント行は読まず、実セッションの開始/完了/中断やキャンバス表示は未確認のままとする。新しいセッションは作成せず、CLIも起動していない。
- 形式の一次資料: [Codex rollout recorder](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs) は`SessionMeta`へsourceとoriginatorを記録し、[公式CLI originator定義](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/default_client.rs) はCLI既定originatorを定義している。このプリフライト結果は、現行adapterが識別できる実Codex CLIセッションがローカル保存先になかったことを示す。将来の保存形式全般との互換性を証明するものではない。
- Codexの認識件数が0の診断には、候補行を除外する理由に加え、Pigeonholesが選んだ保存先がCLI用か確認し、形式変更があればadapter更新後に再読み込みする次の手順を追加した。メッセージの単体テストで保存先や秘密値が表示されないことを維持する。

### 委譲記録の目的を必須化 (2026-10-26)

- 新しい `delegates` 関係は、元・先・目的・記録状態を必須要素として保存する。目的は空白だけの値を認めず、CLI/agent/worktreeの起動は引き続き行わない。
- 過去のブラウザー保存データにある目的空欄の委譲関係は読み込み時に削除せず、詳細へ欠落の案内を出す。目的を補うまでは記録状態の変更もモデル層で拒否し、目的を入力して補修できる。
- 合成単体テストで新規空目的の拒否、既存データの保持、目的の補修を確認した。
- 隔離`--demo`画面でCodex→Copilotの委譲を作成し、空目的の送信拒否、目的/進行中状態の詳細表示、再読み込み後の復元を確認した。
- セッション詳細に「委譲記録を編集」を追加し、記録フォームから状態を「完了」へ変更、詳細で反映を確認した。合成ブラウザー内の保存状態でも再読み込み後に記録が残ることを確認した。
- 同じ編集画面から確認ダイアログを経て合成関係を解除し、詳細から委譲行が消えることを確認した。検証後に専用デモサーバーとタブを閉じ、合成レコードを掃除した。

### Windows WSL Codexの未接続診断 (2026-10-26)

- Windowsで明示的なWSL distro shareが`CODEX_HOME`に設定されていない場合、Codex診断はWSL保存先が未接続であることと、共有先を設定して再起動する次の手順を表示する。
- APIには保存先や環境値を出さず、`configured` / `not_configured` の固定区分だけを渡す。WSLコマンドやdistro列挙は行わない。
- 合成テストで未設定ガイダンス、設定済み時の非表示、不正区分/パスの除外を検証する。実WSL共有は未設定のため、実データ読取と実WSL動作は未確認。
- Windows上の隔離した空provider保存先でloopbackサーバーを起動し、「読み込みの状態」にWSL未接続の理由と設定手順が表示されることを確認した。Codex候補/認識は0件で、保存先や環境値は画面/APIに出なかった。サーバー、タブ、一時ディレクトリは確認後に閉鎖・削除した。
- GUI確認は合成/空データのみ。実WSL共有・実セッションへの接続、CLI起動、新規セッション作成、外部要求は行っていないため、それらは未確認。

### Codex実保存先の再プリフライト (2026-10-26)

- adapterの読み取り境界を確認してから、既定のローカルCodex保存先を再走査した。候補rolloutは36件、CLI条件を満たして認識したセッションは0件。
- 先頭の上限付きメタデータ行だけでproducerを判定し、CLI markerに合わない候補のイベント末尾は読まない。出力は候補数と認識数だけとし、ファイル名、ID、本文、イベント、パス、環境値を出していない。
- 実Codex CLIセッションの開始・完了・中断イベントや画面表示は引き続き未確認。CLI起動、新規セッション作成、保存データへの書込みはしていない。

### Codexへの確認付き委譲実行 (2026-10-26)

- 完了済み・ローカルのCodex CLIセッションを宛先とする送信方向の委譲関係に「委譲を実行」を表示する。実行前に目的文、プロジェクト表示名、保存済みCodex設定/認証と外部利用量の可能性を確認ダイアログに出し、最終確認後だけ開始する。WSL、active/unknown、demoは拒否する。
- 公式CLI仕様の`codex exec resume <SESSION_ID> -`を使い、目的文はargvでなくstdinへ渡す。sandboxは`read-only`に固定し、shellを介さず起動する。stdout/stderrは破棄し、APIはoperation IDと固定状態のみを返す。request bodyは同一Origin、JSON、上限付きで、目的文をログ・応答へ出さない。
- CLI実行ファイルはPATHにある絶対ディレクトリから名前解決し、その絶対パスをchild processへ渡す。作業対象repoのcwdや相対PATH項目から `codex` 実行ファイルを拾わない。見つからない場合は明示エラーにし、起動を試みない。
- ブラウザーは明示実行前にopaque operation IDとactive状態をlocalStorage上の委譲関係へ保存する。ページ再読込後は明示的な状態確認ができる。operationの実行状態自体はサーバーメモリー内のみであり、サーバー再起動などでIDが見つからない場合は、CLIを再実行せず委譲関係をblockedへ閉じる。完了/失敗の状態反映もユーザーが状態確認を選んだ場合だけ行う。
- operation IDを持つ委譲関係は操作記録として編集不可にし、処理中または状態未確認の間は線の端点カードと関係を削除できない。実行中に手動取消表示へ変えてもCodexプロセスは止められないため、状態変更はID照合済みのoperation結果だけに限定する。完了後の記録解除は確認付きで許可する。
- 状態がblockedの操作は、ユーザーがCodex CLIを直接確認し「もう実行中でない」と明示確認した場合に限り、ローカルoperation lockを解除できる。解除時はCLIに接続せず、完了/失敗を推測せず、関係の記録状態はblockedのまま残す。ユーザーは確認後に記録を編集・解除できる。
- blocked解除ダイアログは、対象記録がdelegation/blockedでoperation IDを持つ場合だけ確認を求め、確認キャンセルまたはlocalStorage保存失敗では閉じない。保存成功後にだけ閉じる判定をpure helperへ分離し、対象不一致・確認キャンセル・保存失敗・保存成功を単体テストした。今回の追加でダイアログ自体をブラウザー操作したとは主張しない。
- キャンバスの委譲線は許可済み状態を `data-status` に渡し、予定/進行中/阻害中/完了/取消済みを線種または色で区別する。hover tooltipには委譲記録と状態のローカライズ表示を付ける。表示名や目的文は線へ追加せず、詳細では正確な状態と目的を確認する。
- ヘッダーの信頼表示はセッションデータの読み取り専用性と確認付きworktree作成を説明する文言に統一し、「何も外へ出ない」とは約束しない。確認済みCodex委譲は保存済み設定を利用し、CLIが外部へ接続する可能性を実行前dialogで説明する。
- 実際のCodex CLIは起動していない。runnerのargv/stdin/出力破棄、APIのOrigin/確認/応答境界をsynthetic mockで確認したのみで、実セッション再開、認証・MCP設定、CLI応答の表示、実データの永続状態更新は未確認。現行ローカル実データのCodex CLI認識0件という制約も継続。
- 今回の対応はCodex CLIへの片方向のread-only resumeに限定する。ClaudeからCodexへの受け渡しを含む一般的なprovider間委譲、Codexによるファイル書込み、承認・MCP/network設定の選択、企業ロール制御は未実装または仕様待ち。音声Main AIと企業権限制御の壁打ち仕様はユーザー貼付待ち。
- 合成runner/API/graph検証では、CLI解決時の絶対PATH指定、相対PATHの無視、Codex未検出時のspawn回避も確認した。これは安全な実行ファイル選択と未導入時の停止を検証するもので、実CLIや実セッションの互換性を確認したものではない。
- 一次資料: [Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands) は`PROMPT: string | - (read stdin)`と`codex exec resume`のfollow-up promptを定義し、[Codex CLI source](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs) はresume promptで`-`を使うとstdinから読むことを明記する。

### Codex CLI保存先のread-only再確認 (2026-10-26)

- Codex adapterを通じてローカル保存先を読み取り専用で再走査した。候補rollout 38件、CLIとして認識されたセッション0件。出力したのはこの集計だけで、ファイル名・ID・パス・prompt・ツール入出力・イベント本文・環境値は出力していない。
- 認識セッションが0件のため、実セッションの開始/完了/中断状態とキャンバス表示は今回も未確認。新しいセッションやCLIプロセスは作成/起動していない。
- この結果は実データとの適合性を証明しない。現行の保存先にある候補がadapterの認識条件に一致しないことだけを示す。形式一致を確認できる安全な実セッションが無いため、次は合成fixtureでadapterの各状態を検証する。
