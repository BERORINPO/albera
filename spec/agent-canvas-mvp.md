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
- WSLについて、ユーザーは製品像の対象に含めたが、接続方式の細部は指定していない。安全側の実装として、Windowsで `CODEX_HOME` が `\\wsl.localhost\<distro>` / `\\wsl$\<distro>` の明示共有を指す場合だけ、CodexのPOSIX cwdを内部共有パスへ対応付ける。自動distro列挙と任意UNC探索はしない。一覧・作成・削除は、画面で明示操作したときに限り対象の設定済みdistroで `wsl.exe --distribution <distro> --exec git ...` を実行する。作成は枝worktreeだけを作り、削除は同アダプターが作成した決定的なパスのclean・非current・非locked・非prunable項目に限定し、branchを残す。共有パス・Git出力はAPIへ出さない。実WSL共有は未検証であり、この接続方式と副作用説明が製品として意図されたものかは確認事項として残す。
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
- 検索では、セッションに `related` で結ばれた実行条件プロフィールの4つの固定選択値を、現在の言語の表示語で照合する。プロフィール名・自由記述・根拠文はセッション検索へ流さない。これは利用者が入力した記録を探す機能で、実行条件の検証や検出ではない。
- 製品像の未完了: WSLは明示WSL共有経由のopt-in session adapterとworktree一覧/確認付き作成・限定削除adapterを追加したが、実WSLファイル共有・実セッション・実Git互換性は未確認。Copilot保存形式はCLI/app共通のためCLIだけとは識別せず、OpenCode legacy形式も状態/イベントはunknownのまま扱う。実行条件の自動検出、Obsidian vault indexing/knowledge extraction、REAの自動解析/完全Evidence取込は未完了。ユーザーは音声Main AIと企業権限制御を完成条件として確認したが、音声の開始/停止主体・処理/保存先と、利用者ロール・許可/禁止操作の仕様は提示待ちであり、ここでは推測して実装しない。Obsidianは手動vault-relative note参照のみ追加し、vault走査や内容取得はしない。委譲は完了済みローカルCodexセッションへの確認付きread-only resumeまで実装したが、実CLI実行は未確認で、一般的なprovider間委譲は未実装。理解負債はユーザー記述の対象者・不足根拠・必要説明をカードに記録するだけで、自動推定やスコアはない。
- REA OSSはユーザー指定の https://github.com/morluto/rea.git と確認済み。キャンバスにはユーザーが確認した短い要約を成果物カードへ手動入力し、関連するグラフ対象へ結ぶ。成果物の説明欄は既存モデルで最大1,000文字、参照URLは安全なHTTPSに限定。完全Evidenceの取込・REA実行はしない。
- REA連携の安全境界: 公式の [CLI and Evidence guide](https://github.com/morluto/rea/blob/main/docs/cli.md) は `--json` が完全なEvidenceを返し、実アプリでは数百MBになる場合があると説明する。公式 [MCP contracts](https://github.com/morluto/rea/blob/main/docs/mcp-contracts.md) も完全なcanonical Evidenceをツール結果に保持するとしている。REAのランタイム解析は対象の起動・操作を伴うため、Pigeonholesは結果を自動取込せず、REA実行もしない。利用者が内容を確認して要約を入力する運用は合意済み。要約本文に機密情報を含めないのは入力者の責任で、Pigeonholesはその意味内容を判定しない。
- 2026-10-26: ユーザーが明示した実行条件表示の段階として、値を推測しない手動execution profileカードを実装。4項目の選択肢をallowlist化し、空の値は不明に正規化。詳細・一覧カード・検索・localStorageに限って扱い、セッションAPI/wireには追加しない。
- 2026-10-26: セッション詳細にも関連付け済みexecution profileの4項目を手動情報として表示し、projectionは許可済みのenum項目だけに限定。body/URL/未知フィールドは詳細projectionに含めない。実行環境の事実確認とは扱わない。
- 2026-10-26: セッション詳細で理解負債カードの `evidence` / `explains` 接続先も、カード題名または実行元+短いopaque IDで確認できる。パス・本文・URLは含めず、理解度は推定しない。
- 2026-10-26: セッション詳細の理解負債から根拠/説明の接続先をボタンで開ける。グラフカードはカード編集、セッションは実行元と末尾12文字のopaque IDで一意に解決し、衝突時は何も開かない。画面に完全なセッションIDは出さない。
- 2026-10-26: 現在の読み取り専用セッション一覧にないセッションを指す古い `evidence` / `explains` 関係は、理解負債レビューで有効な根拠として数えない。関係編集には固定の「セッションなし」表示と削除導線を出し、IDやパスを表示しない。
- 2026-10-26: 隔離デモで保存した合成関係を、同一loopback origin上の全provider空ストアから再読込し、理解負債カードの不足表示、関係dialogの「セッションなし」ラベル、明示解除確認を実ブラウザーで確認。削除したのは一時ブラウザー内の合成relationのみ。実セッションデータは読み取っていない。
- 2026-10-26: Obsidian Knowledge Layerの限定的な手動参照段階を追加。ユーザーがvault名と相対note pathをカードへ入力し、関連するタスク/判断/成果物/セッションへ接続できる。URI仕様は公式 [Obsidian URI guide](https://help.obsidian.md/Extending%2BObsidian/Obsidian%2BURI) の `open?vault=…&file=…` に従い、クリック時だけObsidianを開く。ファイル走査・読取・書込は行わない。vault indexingや知識抽出は未実装。
- 2026-10-26: 関連するObsidianノートをセッション詳細からも明示リンクで開ける。ノートURIはブラウザー内グラフから組み立て、session projection/APIにはvault/pathを渡さない。合成画面で関連付けとリンク表示を確認し、プロトコルは起動していない。

## 製品像への追跡表 (2026-10-26)

| 領域 | 現在の実装 | 未完了・証拠の限界 |
|---|---|---|
| 操作可能なCanvas | 一覧/Canvas切替、検索とsource/state/project絞り込み、session slipsとtask/artifact/decision/worktree/理解負債/execution profile/Obsidian参照カード、ドラッグ・キーボード移動、パン・ズーム、関係線、localStorage復元 | 2026-10-26の合成ブラウザー確認で複数providerの複合絞り込み、カード位置/関係/表示切替の再読み込み保持、詳細からのタスク作成と理解負債リンク、worktreeの確認付き作成/削除、空状態/WSL診断、320/400/768/1280pxの表示と一部キーボードフォーカスを確認。委譲線GUI確認では5つの許可状態の線表示と方向マーカー、詳細状態を確認し、取消済み状態の再読み込み復元も確認。合成ブラウザーで委譲線のtitle属性とhover hit-testも確認した。全ダイアログ/全ショートカット/スクリーンリーダー受入、ネイティブtooltip popupの視認、未知状態のブラウザー表示、実セッション表示は未確認 |
| セッション・イベント | Claude Code、Codex CLI、Copilot、OpenCodeにread-only adapterがあり、同じboardでallowlistイベント・状態・詳細を表示。関係pickerも表示中の全providerを対象とする | Codex CLI起点の実セッションは未確認。Copilot保存先はCLI/app共通、OpenCode DBもproducer clientをadapterが識別しない。OpenCode旧schemaは一覧以外の状態/イベントをunknown扱い |
| ハーネス・実行条件 | 詳細に観測可能なprovider/sourceを表示。Codex CLIはCLI markerを満たす記録に限定。場所・分離・network・approvalは不明初期値の手動profileとして関連付け可能 | Copilot/OpenCodeではCLIかアプリかを断定できない。セッションや環境から実行条件を自動検出しない。profile値は利用者申告で、実際の設定・モデル・実行条件の証明ではない |
| 委譲 | 委譲元/先、目的、状態を関係線と詳細に記録し、完了済みローカルCodexへのread-only実行を最終確認後に開始 | purpose-only stdin、read-only sandbox、出力破棄、固定状態APIをmockで確認。operation IDはcanvasのlocalStorageに保存し、再読込後に明示的な状態確認が可能。サーバー再起動で状態が失われた場合は再試行せずblockedへ閉じる。実CLIは未起動、実セッション互換性と一般provider間委譲は未確認/未実装 |
| Git worktree / PM policy | local Git worktreeの読取一覧、明示確認後の作成、clean/non-current等を再確認した確認付き削除、canvas上のpath-free記録。Windowsでは明示設定されたWSL distroに対する一覧/作成/限定削除adapterも追加 | 一時Git repoと合成Codex fixtureを使い、作成dialogの対象/影響説明とack必須、削除dialogの正確なブランチ名+ack必須、削除後のcanvas記録更新までブラウザーで確認。実ユーザーrepoへの操作は未確認。WSLはmock runGitで境界・要約を確認したが、実WSL共有と実CLI挙動は未検証。WSL削除対象はこのアダプター作成のclean/non-current worktreeに限定。PM policyは「この依頼の安全条件だけ」で、追加の自動規則なし |
| Comprehension Graph / 理解負債 | 理解を確認される人、未提示の根拠、必要な説明を記録。`evidence`/`explains`未接続を検出し、関係種別を初期選択した接続フォームへ進める | 人の理解度を推定・採点しない。カードの記録と根拠先の妥当性判断は利用者に残る。自動で実セッション内容から理解負債を発見する機能ではない |
| REA / Knowledge Layer | ユーザー確認済みの短いREA要約をartifactへ手動記録。Obsidian vault-relative note URIを手動登録して明示リンクで開く | REAは起動せず完全Evidenceを取込まない。Obsidian vault走査、内容読取/書込、indexing/知識抽出は未実装 |
| OpenCode / Copilot / WSL | OpenCode DBとCopilotイベントのread-only adapter。明示設定されたWSL共有を使うopt-in Codex reader | 実WSL共有は未確認。CLI/app producer識別、OpenCode legacy状態、未知形式の挙動には上記の制限がある |
| 音声 Main AI | なし | ユーザーは完成条件と指定。ユーザー回答では仕様は未定義。開始/停止主体、音声・文字起こしの処理先/保存先、同意と削除の要件を定義後に実装する。推測実装しない |
| 企業向け権限制御 | なし | ユーザーは完成条件と指定。ユーザー回答では仕様は未定義。利用者role、操作ごとの許可/禁止、監査・組織設定の要件を定義後に実装する。推測実装しない |

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

### 320px画面のキャンバスと詳細パネル確認 (2026-10-26)

- 隔離した`--demo`を320×900で開き、キャンバス表示、固定操作バー、カード追加フォームとカード編集フォームを確認した。キャンバス画面と編集dialogの表示時にdocument/bodyの横scrollWidthは320pxで、編集dialogは幅282pxに収まった。
- 合成Codex CLI (WSL demo) の詳細を開き、状態、ハーネス/場所、Git状態、worktree状態、イベント一覧、利用不可の説明が縦スクロールできるパネル内に表示されることを確認した。詳細表示中もdocument/bodyの横scrollWidthは320pxだった。
- 追加した合成タスクは隔離デモoriginのブラウザー保存領域だけに書かれた。実セッション、CLI、WSL、Git操作、外部サービスは使っていない。320pxの作成/編集/詳細表示の限定確認であり、ドラッグ、関係作成、全dialog/全画面reader利用の狭幅受入は未確認。
- 追試で320px幅の合成タスクから合成Codex CLIカードへ`related`関係を追加し、目的文が編集画面に表示され、再読み込み後も関係と目的が復元されることを確認。Escapeで編集を閉じると起点カードへフォーカスが戻り、document/body横scrollWidthは320pxのまま。実セッションやCLIの操作はしていない。
- 320×480で関係追加dialogは幅282px・縦430pxのスクロール領域として表示され、本文全体を縦スクロールできた。Tabで「関係を追加」へ到達し、Escapeでキャンバス上の起点カードへフォーカスが戻った。document/bodyの横scrollWidthは320px。これは合成データの画面/キーボード確認で、スクリーンリーダーや実データは未確認。

### セッション詳細とタスク接続のGUI確認 (2026-10-26)

- 隔離した`--demo`ボードで合成Codex WSLセッションの詳細を開き、ライフサイクル状態、Codex CLIハーネスとWSLの場所、安全なイベント要約、ブランチ、追跡対象の変更件数、worktree状態、作成時刻を確認した。WSLのworktree作成・削除は未対応で、通常モードでは設定済みdistroへの読取専用一覧操作を提供する。
- 詳細パネルの「関連タスクを作成」を使い、タスク種別と安全な既定タイトルが入った編集画面から保存した。ローカルのタスクカードと`related`関係が作られ、詳細に関係先・方向・目的が表示された。再読み込み後にセッション詳細を開き直してカードと関係の復元を確認した。Escapeで詳細が閉じ、元のセッションカードへフォーカスが戻った。
- この確認に使ったセッションとグラフデータはすべて合成/ブラウザー保存データ。CLI、provider、実セッション保存先、WSL共有、Gitリポジトリ、外部サービスにはアクセスしていない。この1つの詳細からタスクへの経路の確認であり、全詳細項目や実Codex形式の適合性を確認したものではない。
- 確認後、`127.0.0.1:19089`のデモサーバーを停止した。音声Main AI、企業権限規則、実セッションとの適合性は上記の未完了項目として残る。

### provider実行状態欄のGUI確認 (2026-10-26)

- 別ポートの隔離`--demo`で、合成Codexセッション詳細の実GUI表示を確認した。4状態すべてがpile状態と分けて表示され、完了には「ターン開始/ターン完了」、中断には「ターン開始/ターン中断」、未知形式には「安全に表示できるイベント要約はありません」と表示された。未知のlifecycle値自体は表示されない。進行中はCodex CLI/WSL harness・安全なイベント・Git/worktree要約と共に表示されることを確認した。
- デモには4状態を持つCodexの合成レコードを明示的に追加した。すべてデモと識別でき、実providerデータではない。実セッションは未確認。デモタブとサーバーを閉じた。
- 検証: `npm test` — 504 passed、`npm run arch` — 96 paths/0 violations、`npm run smoke` — passed、`git diff --check` — passed。

### provider保存先の追加読み取り専用適合確認 (2026-10-26)

- 読み取り前にCopilot adapterがread-onlyで開き、最初の行のproducer markerと検証済みsession ID/時刻で認識し、cwdはプロジェクト手掛かりとして内部利用し、末尾から許可イベント種別・時刻だけを抽出することを確認した。OpenCodeはSQLite `readOnly: true` で開き、legacyでは一覧用列だけを問い合わせ、transcript/message/partを読まないことを確認した。Codex adapterは `source=cli` と許可originatorの一致後だけ末尾の許可イベントを調べる。
- 現在設定された実保存先をadapterから直接read-only走査し、出力は集計値だけに制限した。Codex: 候補38/認識0、Copilot: event file 0、OpenCode: DB 1/legacy形式20件。全OpenCode行は状態unknownで、transcript eventを推定しない。
- 実OpenCodeの20件を一時メモリ上でpathを外してcore boardへ渡し、OpenCodeカード20件・状態unknown 20件として投影されること、board cardにcwd/pathが無いことを集計だけで確認した。Claudeのタイトル等やprovider ID・イベント内容・完全パスは出力/PRへ含めていない。
- この確認は保存形式とadapter→pure-core投影の適合確認。CopilotとCLI起点Codexの実データは見つからず、実Codex CLIイベント・4状態の実GUI表示は引き続き未確認。新規セッション作成、CLI起動、保存先への書込み、外部provider要求はしていない。

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
- Codex/Copilot/OpenCodeの共通lifecycleは `turn_aborted` を `interrupted` として完了状態から区別する。分類上はいずれもterminalとしてRecentへ送るが、Codexの確認付きresumeは `complete` のみ許可し、中断済み・active・unknownは拒否する。合成adapter/boardテストと純粋なeligibilityテストで確認する。
- provider lifecycleの安全なenum (`active` / `complete` / `interrupted` / `unknown`) をoptionalな `Card.sourceState` としてboard v2に追加し、詳細パネルでpile状態と分けて表示する。未知値は `unknown` に丸め、Claudeカードには付けない。プロンプト等の新しい自由文字列は追加しない。
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
- その後、ユーザーは明示確認後にユーザー入力の目的文だけをlocalhost経由でCodex CLIのstdinへ渡すことを許可した。許可は目的文だけで、セッション本文・ツール入出力は対象外。現在の保存先には実行可能なCodex CLIセッションがないため、委譲は実行しておらず、CLIも起動していない。この許可を実セッション適合性の検証結果とは扱わない。

### 実行条件検索のGUI確認 (2026-10-26)

- 隔離した合成デモ `127.0.0.1:18812` で実行条件カードを作り、実行場所をWSLにして合成Codex WSLセッションへ関連付けた。「WSL」で検索すると、一致1件となり、そのセッションだけが一致対象として残った。
- ページ再読込後もプロフィールと関係がブラウザー内に復元され、Codex詳細に関連プロフィールが表示された。同じ検索を再実行して一致1件になることを確認した。
- このGUI確認は合成データのみ。実セッション/CLIは使用しておらず、確認後デモタブとサーバーを閉じた。

### READMEの委譲通信境界を明記 (2026-10-26)

- READMEの「AIへ何も送らない」と読める包括表現を修正した。通常の分類・表示・キャンバス配置は固定規則だが、ユーザーが画面で明示確認したCodex委譲では、入力した目的文がstdin経由でローカルCodex CLIへ渡る。保存済みアカウント/設定によりCodexが外部通信や利用量を発生させる可能性を併記した。

### GUI確認: 委譲関係線と進行中状態 (2026-10-26)

- 隔離したloopback `--demo` と合成ブラウザー保存データだけで、Codex合成セッションからClaude合成セッションへの委譲記録を作成し、状態を「進行中」に変更した。
- キャンバス上で関係線と方向マーカーを視認し、詳細欄で進行中状態と合成目的文を確認した。目的文は合成値であり、実セッションやCLIは使っていない。
- 線のtooltip、予定/阻害中/完了/取消済み各状態のブラウザー表示差分、リロード後の状態反映はこの確認では未確認。状態の描画規則は既存テスト対象。実セッション表示も引き続き未確認。

### 委譲状態不明の固定tooltipを保持 (2026-10-26)

- 委譲状態が未知値の場合、描画属性に状態不明の固定tooltipを含めるよう修正。未許可値は `data-status` に出さず、中立CSSのまま扱う。目的文などの自由入力はtitleに含めない。
- 合成単体テストで未知値の属性、固定tooltip、目的文非混入、非委譲edgeのtooltip不付与を検証。ブラウザーで未知状態を描画する操作は行っておらず、未知状態の見た目は未確認。
- `npm test`: 506 passed; `npm run arch`: 96 paths, 0 violations; `npm run smoke`: passed; `git diff --check`: passed。

### GUI確認: 委譲5状態の線表示と復元 (2026-10-26)

- 隔離loopback `--demo` の合成Codex→Claude関係で、予定/進行中/阻害中/完了/取消済みをUIから順に保存し、各詳細に対応する状態とキャンバス線・方向マーカーを確認した。5状態は線種または色で表示が変わる。
- 取消済みへ変更後にページを再読み込みし、同じ合成関係を開いて取消済み状態が復元されることを確認した。
- 未知状態はUIで作成できず、描画titleの固定文言と未知値/目的文の非混入は単体テストで確認した。未知状態のブラウザー描画/tooltip実視認は未確認。実セッション・CLIは未使用。

### 委譲線tooltipのhover hit-testを有効化 (2026-10-26)

- CSSで線レイヤーの`pointer-events: none`を継承していたため、委譲線に設定済みの固定titleをhoverできない問題を修正。線自体は見た目を保ち、上下7pxの透明hit領域を追加した。
- 隔離loopback合成デモでDOM上のhover hit-testがtrueになり、委譲線に「委譲の記録: 予定」の固定title属性と`pointer-events: auto`が付くことを確認。目的文はtitleに含まれない。
- 次段階でネイティブtooltipの視認性を補うアプリ描画tooltipを追加。ホバー時に固定の種別/状態ラベルを表示し、表示文字を12px未満に縮めない。隔離loopback合成デモを34%キャンバス倍率で目視し、「委譲の記録: 予定」が読めることを確認。目的文・端点名などの自由入力は表示しない。
- 未知状態はUIで作成できないため、未知状態のブラウザー表示は未確認。`npm test`: 506 passed; `npm run arch`: 96 paths, 0 violations; `npm run smoke`: passed; `git diff --check`: passed。
- Pigeonholes自身が外部サービスへ直接リクエストしない説明は維持し、CLI自体の通信可能性と区別した。実CLIは起動していない。

### 委譲状態tooltipをキーボードから確認可能にする (2026-10-26)

- 委譲線を固定のローカライズ状態ラベルで名前付けし、キーボードフォーカス可能にした。線レイヤーを一律`aria-hidden`にせず、非委譲線は個別に装飾要素として隠す。
- tooltipはマウスhoverと`:focus-visible`の両方で表示し、フォーカス輪郭も出す。隔離loopback合成デモでTabキーのみを使って委譲線へ移動し、34%表示でtooltip・輪郭を確認。ブラウザーのアクセシビリティツリーでも「委譲の記録: 予定」のボタン名を確認した。実スクリーンリーダー読み上げは未確認。
- 関係線に追加するアクセシブル名は既存の固定種別/状態文言のみ。目的文・端点名やセッション由来の値は使わない。
- GUI確認中、後段の線描画処理がARIAラベルから状態を落としていた不具合を発見。再描画後も固定の種別+状態ラベルを維持するよう修正し、画面とアクセシビリティツリーで確認した。データは明示的に作成した合成Codex→Claude関係のみ。実セッション・CLIは未使用。
- 委譲線自体をネイティブボタン化し、Enter/Spaceで既存の関係編集dialogを開けるようにした。隔離ブラウザーで両キーから編集フォームと保存済み合成状態を確認。フォームの表示だけで、保存・削除・CLI実行はしていない。
- 関係線の透明hit領域を上下12 world pxへ広げ、既存の逆ズーム係数`--k`を使う。隔離合成ブラウザーを30%倍率にし、線の中心から横へ10px離れた位置をポインタークリックして関係編集を開けることを確認。セッション内容は変更せず、保存・削除・CLI実行なし。

### 空キャンバスからカードを追加する導線 (2026-10-26)

- セッションもグラフカードもない状態に、状態の説明と直接操作できる「カードを追加」ボタンを追加。既存の`graph-new`アクションへ接続し、タスク・成果物・判断・理解負債など共通の編集dialogを使う。
- 空状態を名前付きregionとして構造化し、ボタンのfocus-visible輪郭とポインター操作を有効にした。英語/日本語の説明と操作名を追加し、言語切替後も表示を更新する。
- 単体テストはaction接続、名前付きregion、pointer-events、focus表示、両言語の辞書キーを確認。空fixtureを通常モードで起動したブラウザーのアクセシビリティツリーで、説明regionと「カードを追加」buttonの表示も確認した。クリック後に編集dialogが開く操作は未実施。
- `npm test`: 507 passed; `npm run arch`: 96 paths, 0 violations; `npm run smoke`: passed; `git diff --check`: passed。`npm run smoke`は集計値のみを出力し、秘密値やパスは出ていない。
- 追試として隔離した空fixtureを通常モードで起動し、Windows computer-use経由でCTAを押してdialogまで確認しようとしたが、Chromeの状態取得が `GetCursorPos failed: アクセスが拒否されました (0x80070005)` で失敗した。対象ウィンドウを再選択して一度再試行しても同じ結果だったため、GUIスキルの復旧規則に従い操作を停止した。fixtureが存在しないこととサーバー停止を確認した。CTAクリック後のdialog表示は引き続き未確認であり、ソース接続と自動テスト以上の実画面動作を検証済みとは扱わない。

### WSLのworktree確認付きライフサイクル (2026-10-26)

- 明示設定済みの `CODEX_HOME` WSL共有を通じて、セッション詳細のworktree一覧を提供する。逆マッピングは同じ共有のdistro/pathだけに限定し、無関係なUNC共有・別distro・traversalは拒否する。distroの自動列挙はしない。
- 一覧・作成・削除は各画面操作の後にだけ、対象distroへ `wsl.exe --distribution <distro> --exec git ...` で固定引数を渡す。shellは介さず、子プロセスへ渡すWindows環境はPATH/SystemRootに限定する。パス、ロック理由、ファイル名、Git診断は返さず、branch・状態・件数・固定flagだけを返す。
- 作成は同じ既存確認dialogを使い、UIとAPIの両方で`confirmed: true`を必須にし、`core.hooksPath=/dev/null`を指定したbranch worktree作成だけを行う。Git filterはcheckout時に実行され得る。削除は決定的に生成したアプリ管理パスだけを許可し、clean/non-current/non-locked/non-prunableを再確認してforceなしで作業フォルダだけを削除する。ブランチは残す。UIではignored filesが失われる可能性を説明し、ブランチ名入力と確認を求める。
- 合成runGitテストでdistro制限、パス写像、確認必須、作成先衝突、hook抑止、managed path限定、状態再確認、forceなし、パス/ファイル名の非返却を確認した。実distroへは接続せず、実WSLの表示・操作は未確認。
- `npm test`: 514 passed; `npm run arch`: 96 paths, 0 violations; `npm run smoke`: passed; `git diff --check`: passed。起動smokeは既存経路を使用し、WSLコマンドは実行していない。

### Codex候補の0件理由を実ストアで識別 (2026-10-26)

- 実データを読む前にCodex readerを確認: 読取専用`fs.open(..., 'r')`、先頭32 KiBの`session_meta`と末尾128 KiBの許可イベントだけを解析し、CLI source/originator、opaque UUID、時刻、作業dir条件を満たす記録だけ返す。プロンプト、tool入出力、env、cwdは表示用wire/APIへ渡さない。追加調査では先頭メタ行だけをメモリ上で分類し、生値・パス・IDは出力しない。
- 現在の実ストアにfilename条件を満たす候補rolloutが38件あったが、すべての`session_meta.source`が`cli`ではなく、CLIセッションとしての検出は0件。イベント末尾は読まず、ファイル名・source値・本文は出力/ログ/PRに記録していない。実際のCodex CLIセッションとの適合性は依然未確認。
- adapterは「CLI識別マーカーなし」を他の形式不一致から分離した安全な件数だけ返す。Reading statusは候補すべてにCLIマーカーがない場合、`CODEX_HOME`がCodex CLIの保存先か確認するよう説明する。値そのものや保存パスは公開しない。
- 合成テストで未CLIマーカーの件数、キャッシュ後も保持される安全な診断、英語/日本語UIの案内を検証する。実セッションは読取のみで変更なし。実CLI/外部リクエスト/新規セッション作成は行っていない。
- 通常モードを`127.0.0.1`へ一時起動し、API応答からCodex用の数値フィールドだけを抽出して既存のReading status関数に渡した。実データの内訳`files=38 / detected=0 / rejected=38 / notCli=38`と、固定の「CODEX_HOME確認」案内が一致した。ボード本文、タイトル、session ID、ファイル名、パスは標準出力へ出していない。サーバーは停止済み。
- 検証: `npm test` 507 passed、`npm run arch` 96 paths / 0 violations、`npm run smoke` passed、`git diff --check` passed。

### 空キャンバスCTAの縮小表示を読みやすくする (2026-10-26)

- 空状態説明と追加ボタンはキャンバスworld内で描画されるため、固定サイズのままでは縮小時に文字・押下領域・focus輪郭まで小さくなる。既存の逆ズーム係数`--k`で幅・余白・文字サイズ・最小押下高さ・輪郭を補正し、表示倍率を下げても画面上の大きさを保つ。
- 単体テストで`--k`を使ったすべての補正と、名前付きregion・既存カード追加actionを検証。空fixtureをブラウザーのキャンバス表示で開き、名前付きregion、説明、ボタンがアクセシビリティツリーに出ることを確認した。CTAクリック、縮小後の画面上の文字寸法、dialog表示は未確認。
- 使用した一時fixtureとloopbackサーバーは削除・停止済み。実セッションストア、CLI、外部サービスには接続していない。

### 理解負債の根拠・説明リンクを直接補う (2026-10-26)

- 明示入力された不足根拠/必要な説明に対してだけ、理解負債カード編集画面へ不足中の `evidence` / `explains` アクションを表示する既存の発見フローを、テスト可能なUI actionへ整理した。
- 選んだリンク種別を関係編集画面へそのまま渡し、利用者が対象カード/セッションを選んで記録する。unknown kindや空node IDはclose/connectせずに拒否する。リンク後も「解消」の最終判断は利用者が行い、状態を手動で変更する。理解度は推定/採点しない。
- 合成テストで根拠/説明それぞれの固定kind、dialogを閉じてからrelation editorを開く順序、不正kindの不作用、現在不足しているリンクだけをUIへ出す配線を確認。モデルテストでも未接続関係の発見から接続後のレビューqueue消失、手動resolveまで確認する。
- `npm test`: 517 passed; `npm run arch`: 96 paths, 0 violations; `npm run smoke`: passed; `git diff --check`: passed。実セッションやユーザーの理解を読まず、外部操作も行っていない。

### 理解負債のGUI解消フローと再読込を確認 (2026-10-26)

- `127.0.0.1:18950` のデモモードを起動し、実データを読まずにキャンバスから合成理解負債カードを追加。編集dialogに不足根拠/説明が表示され、各アクションが選択済みの関係種別で関係dialogを開くことを確認した。
- 各関係を合成Claudeデモセッションへ接続後、レビュー案内が消え、編集画面に根拠/説明の2リンクが表示された。人の理解を自動判定せず、利用者が状態を「解消済み」に変更した。
- ページ再読み込み後、カード・状態・2つの関係が復元されたことをアクセシビリティツリーと画面で確認。CLI、worktree操作、外部サービス、実セッションには触れていない。合成データの確認であり、実セッションの挙動の根拠にはしない。
- 画面操作だけで成立することが確認できたため、今回の段階に追加コード変更は不要。使用したデモサーバーは検証後に停止する。

## 製品像に対する完成状況の監査 (2026-10-26)

この表は製品像をMVPへ縮小せず、実装の有無と検証強度を分けて管理する。合成データの成功は実データ適合性を証明しない。

| 製品要件 | 現在の実装 | 残る作業・強い証拠 |
|---|---|---|
| Miro型キャンバス、カード移動・関係・検索/絞り込み・一覧切替・詳細 | プロジェクト用紙、パン/ズーム、Graphカードの移動/接続、localStorage保存、一覧/キャンバス切替、source/state/project検索を実装。Graphはカード/関係/理解負債を保持。 | 合成UI経路は `spec/ui.md` §10.11 と本書のGUI追記で確認済み。すべての狭幅・キーボード・再読込の組み合わせを製品受入テストとして通す作業は残る。 |
| Claude/Codex/Copilot/OpenCodeの同一盤面と安全なイベント | 各source adapterと共通表示を実装。Claude既存欄は維持。Copilot/OpenCodeのproducer種別は保存形式から区別できないケースがある。 | 合成fixtureとローカル形式の限定確認まで。実Codex CLIセッション、Copilot CLI固有性、OpenCode CLI固有性、実WSL保存先は未確認。実セッション作成は禁止されたため確認可能な実データ待ち。 |
| ハーネス・実行条件 | 実行場所、隔離、ネットワーク、承認方式をユーザーが記録するprofileを実装。 | runtimeや環境からの検証はせず、profileは宣言値に留める。ハーネスの共通語彙がユーザーの意図に合うか、必要な追加条件があるかは未確認。 |
| セッション間委譲 | 委譲元/先/目的/状態の関係記録を実装。完了済みローカルCodex CLIへの明示確認付きread-only resumeを実装。 | 他providerを実際に起動する委譲は未対応。現在の実CLI実行は明示された検証制約により行わず、CLI環境の互換性・保存operation後の実行結果は未確認。 |
| Git worktreeとPMポリシー | local/明示WSL共有の一覧・確認付き作成・アプリ管理領域だけの限定削除を実装。削除はclean/non-current等を再検査する。 | 合成テストのみで実local/WSL Git操作は未確認。個別PM規則は追加せず、ユーザー指定の安全条件だけ適用。 |
| Comprehension Graphと理解負債 | 確認対象者、明示された不足根拠/必要説明、evidence/explains関係と手動解消状態を記録。スコアや理解の推定なし。 | モデル/UIテストと合成ブラウザーで作成・接続・再読込を確認。実チームの理解確認運用への適合性は未評価。 |
| REA Knowledge | `morluto/rea` の利用者確認済み短い要約を成果物カードへ手動入力し、関係付けできる。 | REA実行、完全Evidenceの自動取込はしない (完全Evidenceが大きくなり得るという合意)。要約の機密性は入力者が確認する。 |
| Obsidian | vault名と相対note参照を手動登録し、明示クリックでURIを開く。 | vaultの走査/読取/書込、知識抽出は未実装。 |
| OpenCode/Copilot/WSL | OpenCodeとCopilot adapter、Windowsの明示WSL共有設定に限定したread-only検出とworktree経路を実装。 | real WSL環境は未検証。OpenCode旧形式のstatus/eventsはunknown。Copilot CLI/appの区別はしない。 |
| 音声 Main AI | 未実装。 | 壁打ち仕様は未提示で、ユーザー回答でも要件は未定義。開始/停止主体、音声取得、処理先、保存/保持、外部通信、権限境界を決めてから実装する。推測で音声取得や送信を追加しない。 |
| 企業向け権限統制 | 未実装。 | 壁打ち仕様は未提示で、ユーザー回答でも要件は未定義。利用者ロール、操作ごとのallow/deny、認証/認可主体、監査範囲、共有/tenant境界を決めてから実装する。単一ユーザーloopback前提を組織認証へ拡張しない。 |

今回のGUI再確認では、in-app-browserではボタン操作後も画面が変わらなかったが、同じ一時デモをChromeで開くと、拡大操作で62%から80%へ変わり、一覧/キャンバス切替が双方で動作した。キャンバス空白部のドラッグでもworld transformの平行移動値が変わった。従ってズーム・切替・パンはChromeの合成デモで操作確認済み、in-app-browserの入力経路は未確認。実セッションや保存先は使っていない。画面サイズ・入力法全体の製品受入は引き続き未完了。

別のChrome隔離デモで絞り込みメニューを開き、実行元=Codex CLI、状態=作業中、プロジェクト=demo-appを順に指定した。三条件の併用後に一致数が1となり、キャンバス上に該当Codexデモカードだけが通常表示された。これは合成データのGUI確認で、実セッションは使用していない。

2026-10-26の読み取り専用ローカル起動では、Codex候補ファイル38件に対して認識0件、全38件がCLI形式の識別条件で除外された。adapterはこの判定後に末尾を読まないため、対象候補のイベント/プロンプト/ツール内容は今回読み取られていない。続くheader-only集計では、38件中17件がCLI以外の`source` marker、21件がmarkerなしで、38件すべての`originator`が許可済みCLI集合の外だった。markerの実値・ID・パスは出力していない。読み込み状態APIは「候補あり・CLI印なし」と保存先確認を示す安全な件数だけを返した。現在の保存先では実Codex CLIの検出・表示は確認できず、実CLIセッション形式に適合したとの証拠にはしない。実セッションの新規作成は禁止されたままなので、CLI保存先の変更や将来の実セッションは別途確認が必要。

2026-10-26 の隔離デモUIでは、合成タスクカードを矢印キーで移動してページを再読込し、同じカードと配置が復元されることを確認した。また合成Codexセッションへカードを接続して関係線が表示され、再読込後も関係が残り、セッション詳細に関連カード・イベント要約・ハーネスが表示されることを確認した。実画面確認でイベント時刻の引数誤りを見つけ、イベント時系列とカード要約の両方にローカル時刻を表示するよう修正した。確認用カードはUIの確認付き削除で片付けた。実セッション/保存先は使っていない。全幅・狭幅、全カード種別、各操作を組み合わせた製品受入は引き続き未完了。

同日の別の隔離デモ確認では、一覧をCodex CLIに絞り、合成の完了済み・中断済みセッションをそれぞれ開いた。詳細にCodex CLIハーネス、対応する完了/中断状態、開始・終了イベントとローカル時刻が表示された。これは画面レンダリング経路のみの確認であり、実CLIや実セッション保存先との適合性は未確認。

その後、1280/768/400/320pxの隔離デモでキャンバスの横はみ出しがないことを確認。320pxのCodex WSL詳細で共有詳細rendererとキャンバス帯の両方がworktree案内・更新操作を追加し、同じ項目が二重表示される問題を発見した。WSL項目のキャンバス側重複を除き、非WSL向けキャンバス作成操作は維持。修正後は案内・更新操作が各1つで、残りの詳細操作はパネル内スクロールで到達可能なことを画面で確認した。合成デモのみで、実WSLや実セッションは未使用。

別の隔離loopbackデモでは、Miro型キャンバスのポインター操作を追加確認した。空の専用browser originでタスクカードを作り、62%ズームで画面上160×110pxドラッグ後にキャンバス座標が逆ズーム分だけ移動し、再読込後も同じ配置と題名を復元した。UIの削除確認操作はブラウザー入力timeoutで完了できず、合成カードがその一時originのlocalStorageに残存。デモサーバーは停止済み。セッション保存先は参照していない。

音声 Main AI と企業向け権限制御はユーザーが完成条件と指定した。2026-10-26の確認で、両者の具体仕様は未定義と回答された。完成条件のまま残し、開始/停止主体、音声データの処理/保存先、権限ロールと操作規則を定義するまで機能を推測実装しない。製品像全体も完了扱いにしない。

### 空キャンバスCTAからの追加・キャンセル (2026-10-26)

- 隔離した通常起動 (一時の空ディレクトリをClaude/Codex/Copilot/OpenCodeそれぞれへ設定) でセッション0件・Graphカード0件を確認。`v`でキャンバスへ移動し、「カードを追加」で編集dialogが開くことを実画面で確認した。
- GUI確認で、新規カード編集時にnodeが未生成なため、キャンセル処理が `!node` guardに遮られて閉じない不具合を発見。cancel actionをnode依存処理より前に評価するよう修正し、action helperとdialog配線を合成テストで確認した。ブラウザーでもdialogの「閉じる」で空キャンバスへ戻り、カードが保存されていないことを確認した。
- 空fixture・サーバー・ブラウザータブは検証後に停止/削除。セッション保存先の内容、実CLI、worktree、外部サービスにはアクセスしていない。
- この修正後の検証: `npm test` 518 passed、`npm run arch` 96 paths/0 violations、`npm run smoke` passed、`git diff --check` passed。

### 合成デモでのキャンバス操作受入 (2026-10-26)

- 現在の作業treeから専用loopback port 8810で`--demo`を起動し、`/api/hello`が`demo: true`を返すことを確認。ブラウザーでカード追加dialogを開き、タスクカードを作成した。
- タスクとCodex CLI合成セッションの`related`関係を画面から追加。再読込後にカードと関係が残り、カード詳細で接続先がCodex CLIのopaque short IDだけで表示され、キャンバス上に関係線が描画された。
- focused cardへ矢印キーを送り、カード位置を動かした。再読込後も移動した位置が復元された。
- source=Codex CLI、state=Working、project=demo-appを順に指定し、組み合わせ一致が1件になることを確認。canvas上では一致カードだけが強調され、view toggleで一覧に移ると同じ1件のみ表示された。
- すべて合成データであり、実セッション・プロバイダー保存先・CLI・worktree操作は使っていない。実画面の表示幅は1280px。400px/320pxなどの狭幅、ブラウザー全体の製品受入は別途未完了。

### REA短文ノートを手動記録してタスクの根拠に接続 (2026-10-26)

- 1280pxの隔離デモで成果物カードを作成。画面に表示された「REAの所見は確認済みの短い要約だけ」を守り、明示的に合成データと分かる短文を手入力して保存した。REAは実行せず、Evidenceや外部ページを取り込んでいない。
- 成果物からタスクへの`根拠`関係を追加し、説明欄に合成受入の由来を入力。再読込後、成果物とタスクがキャンバスに残り、成果物詳細に関係先と説明が表示された。
- この確認は手動入力・ブラウザー内保存・関連付けのUI経路だけを対象とし、実REAの出力、Obsidian、実セッションとの接続は検証していない。確認用カードは専用デモportのbrowser storageに残るが、実データには影響しない。

### デモ時のworktree操作不可を詳細に表示 (2026-10-26)

- 合成デモのCodex CLI WSLセッション詳細では作成ボタンが無い一方、デモで操作が無効である理由は具体的に表示されていないことを確認。Canvas詳細で非WSLのデモセッションには作成ボタンを出し、後段のAPI拒否まで進ませるコード経路も確認した。
- worktree操作の可否を共通の純粋な判定へ集約。合成デモは実行元にかかわらず作成不可の理由を詳細に表示し、作成ボタンを出さない。非デモではWSL共有の注意と確認付き作成、ローカルでは確認付き作成を一覧/キャンバスで共通の詳細UIから提供する。Canvas側の重複作成ボタンは除いた。
- 合成デモの画面でWSL Codex詳細に制約文が表示され、作成ボタンが無いことを確認。テストはdemo/local、demo/WSL、real/local、real/WSLの判定表を確認する。実worktree操作・実WSL共有・実データは使用しない。

### キャンバスworktreeカードに対象プロジェクトを記録 (2026-10-26)

- worktreeカードにブランチ・基点・状態数は保存されていたが、複数リポジトリの盤面で対象をカード単体から識別しにくかった。
- 一覧/キャンバスで使う既存の安全なproject labelをカード本文に加える。元セッションとの関係を維持し、repository pathはカード/APIへ追加しない。project labelが無い場合は既存の「フォルダなし」を使う。
- pure helper testでプロジェクト名・基点・状態数と、パスが含まれないことを確認。実Git/worktreeは操作しない。

### セッション0件でもキャンバスを開ける (2026-10-26)

- 一覧のキャンバス切替がactive session件数に連動して隠れていたため、セッションが0件の利用者はタスク/成果物/理解負債カードを作るキャンバスへ移動できなかった。読み込み中や初回エラーでboard未取得の場合も同様に保存済みGraphを開けなかった。
- 切替ボタンを一覧/キャンバス両方で常時表示し、空のキャンバスの案内と「カードを追加」操作へ到達できるようにした。session一覧の0件表示や読み込み/エラー文言は変更しない。
- Claude、Codex、Copilot、OpenCodeの保存先すべてを一時fixture内の空フォルダ/未作成DBへ向けた隔離起動で、全pileが0件の一覧に切替ボタンが表示されることを確認。切替後は「空のキャンバス」と説明文、「カードを追加」が画面とアクセシビリティツリーに現れた。空fixtureはアプリ外に作成後、確認後に削除。実セッション保存先・CLI・worktree操作・外部サービスは使っていない。
- UI policy testでlist/canvasの有効viewは切替を表示し、未知viewは隠すことを固定。board/session countの有無で切替可否を変えない。

### 合成worktree inventoryからカードを記録して復元 (2026-10-26)

- 隔離デモのCodex CLI合成セッションから「worktree状態を更新」を開き、synthetic inventoryの別branchをGit変更なしでキャンバスに記録した。
- カード上で安全なプロジェクト名、branch/base、変更・未追跡・競合数が見え、詳細には元セッションへの関係と状態要約が表示された。再読込後もカードがキャンバスに残ることを確認した。
- 合成デモだけを使用。実セッション・実Git worktreeの読取や変更はなく、Git操作の適合性、狭幅画面、providerの実データ連携は未確認。作成したカードは隔離デモoriginのlocalStorageに限られる。

### 理解負債リンクのキーボード操作後にフォーカスを戻す (2026-10-26)

- 合成デモのキーボード操作で理解負債カードを編集し、「根拠を結ぶ」/「説明先を結ぶ」から関係dialogを開いた。保存後、元のグラフカードが再描画されてもフォーカスがページへ落ちていた。
- 関係保存後に接続元がグラフカードなら、そのカードへ次フレームでフォーカスを復帰するよう修正。固定関係の起動、localStorage保存、カードへのフォーカス復帰まで画面で確認し、カードと二つの関係が再読み込み後も残ることを確認した。実セッション内容・CLI・外部サービスは使用していない。
- 再検査時のCodex adapter読取集計は候補38・CLI適合0。セッション本文やイベント、ID、パスは出力していない。実Codex CLIセッションの表示は未確認のまま。
- 修正後検証: `npm test` — 526 passed; `npm run arch` — 96 paths, 0 violations; `npm run smoke` — passed; `git diff --check` — passed.

### 関係dialogのキャンセルでも接続元へフォーカス復帰 (2026-10-26)

- 既存の合成理解負債カードから関係編集を開いてキャンセルすると、フォーカス復帰が保存時だけに実装されており、documentへ落ちることを確認。
- グラフカード起点の関係dialogはclose時に一律で接続元カードへフォーカスを戻すように変更。合成デモで編集dialogを開いて「閉じる」を選択し、カードにフォーカスが戻ることを確認した。セッション・CLI・外部サービスは使用していない。
- この確認は関係編集のcancel経路に限定される。全ダイアログとスクリーンリーダーの製品受入は未完了。

### 関係dialogの起点コントロールへフォーカスを復帰 (2026-10-26)

- セッション詳細から関係dialogを開いた場合は、保存後に詳細パネルが再描画されて起点ボタンが外れる可能性があり、ブラウザー標準の復帰ではフォーカス先が不定だった。
- 開いた時の起点要素を記録し、dialogを閉じた後もDOMに存在すればそこへ戻す。起点が外れているときは接続元のグラフカードまたはセッションカード、次にキャンバスviewportへ復帰する。
- 隔離Chromeの合成デモで、キャンセル後は「関係を記録」ボタンへ、保存後の詳細再描画時は接続元のCodexセッションカードへフォーカスが戻ることを確認。2件の関係が詳細に表示され、ページ再読込後も残る。実セッションは使っていない。スクリーンリーダー全体の製品受入は未完了。
- 復帰先の選択 (起点コントロール → 接続元グラフカード → viewport → なし) をpure helperとして抽出し、各DOM接続状態をfixtureで検証。UIコードを文字列で模擬するだけのテストから選択ロジックの直接テストへ置き換えた。
- 再検証: `npm test` — 527 passed; `npm run arch` — 96 paths, 0 violations; `npm run smoke` — passed; `git diff --check` — passed。

### Codex fixtureのCI portability修正 (2026-10-26)

- PR CIでCodex adapterのfixtureテストがLinux/macOSで失敗。`cwd` fixtureをWindows絶対パスに固定していたため、adapterの各OS絶対パス検査で除外されていた。Windowsローカルでは通過していた。
- テスト専用のcwdを実行OSのrootから組み立てるように変更。製品コード、保存データ、実セッションの読取範囲は変更なし。
- 修正後のPR CI run `40314754367` はWindows/macOS/Linux × Node 22/24の6ジョブ全てでTestsとArchitecture checkが成功。ローカル `npm test` 527 passed、`npm run arch` 96 paths/0 violations、`npm run smoke` passed、`git diff --check` passed。

### 合成デモでカード追加の保存・復元を確認 (2026-10-26)

- 隔離した `--demo` のキャンバスでツールバーの「カードを追加」を開き、合成タスクと説明を保存。キャンバス上に題名・状態・説明が出ることを確認した。
- ページを再読み込みし、同じタスクカードと説明がlocalStorageから復元されたことを画面で確認した。セッション保存先、実セッション、CLI、worktree操作、外部サービスは使っていない。
- この確認はセッションがあるデモ上のツールバー導線を対象とする。全provider空状態での空キャンバスCTAを押す操作、全カード種別の作成/編集、スクリーンリーダー受入は別途未完了。

### 全provider空状態から最初のカードを作成・復元 (2026-10-26)

- Claude、Codex CLI、Copilot、OpenCodeをそれぞれ空の一時保存先へ向けて通常モードを起動。全pileが0件の一覧からキャンバスへ移動し、「カードを追加」CTAで編集dialogが開くことを確認した。
- 合成タスクと説明を保存し、キャンバスに現れること、再読み込み後も題名・状態・説明が復元されることを確認した。読み込み状態を展開すると、Codex/Copilot/OpenCodeそれぞれの0件理由と確認先が表示された。表示に保存先パスやセッション内容は含まれなかった。
- この確認は一時保存先とbrowser-local storageだけを使用。実セッション・CLI・worktree操作・外部サービスは使用していない。全カード種別、全ダイアログ、スクリーンリーダーと実セッションの受入は未完了。
- 同段階の `npm run smoke` は既存スクリプトの仕様上、PIGEONHOLES_* 環境変数を除いて通常のローカル保存先をread-onlyで集計する。この実行でも既定Claude保存先が使われたが、出力はpile等の集計・時間と安全性検査結果のみで、タイトル、本文、ID、完全パスはPRへ転記しない。空状態GUI確認の入力には使用していない。

### 空状態からREA所見をタスクの根拠へ手動接続 (2026-10-26)

- Claude/Codex/Copilot/OpenCodeを空の一時保存先へ向けた通常起動で、空キャンバスにタスクカードと成果物カードを画面から作成した。成果物フォームの「確認済みの短い要約のみ」という説明に従い、合成値であることを明示した短文を手入力した。REAは起動していない。
- 成果物カードから関係編集を開き、接続先タスク・関係種別 `根拠`・合成の説明を保存。成果物詳細に関係方向、接続先、説明が出ることと、キャンバス上の2カード間に関係線が描画されることを確認した。
- ページを再読み込みし、タスク/成果物/関係/説明がbrowser-local storageから復元されることを画面で確認した。実セッション・CLI・REA・外部サービス・worktree操作は使用していない。完全なREA Evidence取込やvault indexingを実装/検証したものではない。

### 委譲の最終確認に対象セッションを明示 (2026-10-26)

- コード経路を点検し、実行前の確認にはproject labelと目的、localhost経由でCodex stdinに渡す内容、保存済みaccount/configurationによるネットワーク/API利用可能性、usage、破棄する出力、セッション記録の変更可能性が含まれる一方、複数候補から選んだ対象を確認する識別表示が不足していた。
- 確認文にprovider名とsession ID末尾12文字を追加し、フルIDは表示しない。英語/日本語の合成テストで対象末尾・目的・外部利用/usage注意・破棄説明と差込漏れがないことを確認。
- 隔離デモをport 19711で起動し`/api/hello`の`demo: true`を確認、合成キャンバスを画面表示した。デモでタスクとplanned委譲関係を作成したが、最終確認dialogの実画面表示は未確認。委譲を実行せず、Codex CLI、保存済み実セッション、外部サービスは使用していない。
- 検証: `npm test` — 529 passed、`npm run arch` — 96 paths/0 violations、`git diff --check` — passed。デモサーバーを停止した。

### 委譲最終確認の隔離画面受入と実行試行の不確実性 (2026-10-26)

- 実保存先の代わりに一時CODEX_HOMEへ合成rollout 2件だけを置き、Claude/Copilot/OpenCodeとプロジェクトの入力先も一時の空フォルダに設定した通常モードを起動。ボードは合成の進行中/完了Codex CLIを表示し、session間の委譲関係を記録した。
- 実行前確認には合成project label、Codex CLI、ID末尾12文字、目的、purpose-only stdin、account/configurationのnetwork/API利用可能性、usage、破棄出力、session記録変更可能性が画面表示された。
- ブラウザー自動操作がJavaScript確認dialogで中断したが、結果画面で委譲状態が進行中に変化し、その後「委譲に失敗」と表示された。このため実行確認が意図せず成立し、合成セッションIDに対するCodex CLI実行を試みた可能性がある。対象IDを含む稼働プロセスは確認時に存在せず、CLI実行や外部通信の有無は確定できない。実セッションとの適合性検証として扱わず、以降の実行操作は行っていない。
- Pigeonholesサーバーとブラウザータブは停止/閉鎖済み。合成fixtureは `work/delegation-confirmation-fixture` に残っている。削除コマンドは端末の安全ポリシーで拒否されたため削除できず、製品データや実セッション保存先には置いていない。

### 委譲確認を画面内ダイアログへ変更 (2026-10-26)

- JavaScript標準の `window.confirm` を削除し、対象provider/project/ID末尾、目的文、stdinへ送る情報、保存済みCodex account/configurationによるnetwork/API/usage、破棄するCLI出力、セッション記録変更の可能性を項目別に示す画面内dialogへ置き換えた。
- キャンセルとEscapeは閉じるだけで実行callbackを呼ばない。明示した実行ボタンのsubmitだけが委譲を始める。確認が開いている間に関係が削除・変更された場合に備え、実行直前にedge/endpoints/status/purposeを再読込して照合する。閉じた後は呼出元へfocusを戻す。
- `npm test` — 530 passed、`npm run arch` — 96 paths/0 violations、`git diff --check` — passed。追加した回帰テストは日英の確認項目、full session IDを表示しないこと、native confirmationを使わないこと、キャンセル経路と明示submitの分離を検査する。
- この修正ではブラウザー上の実行ボタンを押していないため、Codex CLIや外部通信は起動していない。画面内dialogの実ブラウザーvisual/keyboard受入は未確認。前項の自動操作時に実行確認が成立した可能性と、その不確実性は引き続き記録する。
- 合成fixture `work/delegation-confirmation-fixture` は端末安全ポリシーが削除操作を拒否したため作業ツリーに残存する。削除は実施していない。

### 委譲確認画面の合成GUI受入 (2026-10-26)

- 既存の合成Codex fixtureだけを入力にし、Claude/Copilot/Projectsはfixture内の空ソース、OpenCodeは存在しない合成DBへ向けて通常モードをloopback起動した。実セッション保存先は設定せず、実セッションは読み取っていない。
- 合成進行中Codexから完了済み合成Codexへの委譲関係を画面から「予定」として記録し、対象project/provider/ID末尾、目的、stdinへ渡す範囲、network/API/usage可能性、破棄出力、セッション記録変更の注意が実ブラウザーに表示されることを確認。
- 「閉じる」とEscapeの両方でdialogが閉じ、関係は「予定」のまま、focusが呼出元の「委譲を実行」ボタンへ戻った。実行ボタンは押していないため委譲API/CLIは呼び出していない。port 19827の確認用サーバーと一時ブラウザータブは停止/閉鎖済み。
- 合成関係と目的文はport 19827のブラウザーlocalStorageに残る場合がある。ユーザー既存originやセッション保存データには書き込んでいない。fixtureは以前の試行で作成され、未追跡で残っている。
- この確認は画面表示と2種類の取消経路を対象にする。実Codexセッションとの適合性、実行submit後のCLI/外部利用、スクリーンリーダー受入は未確認。前回試行の実行有無に関する不確実性も解消していない。

### 委譲確認の読み上げ説明と狭幅表示 (2026-10-26)

- dialogの `aria-describedby` を対象・目的・送信範囲・network/API/usage・破棄出力・セッション記録変更の全6項目へ関連付けた。対象やリスク説明をスクリーンリーダーが説明欄として参照できる。スクリーンリーダー実機受入は未実施。
- 合成Codex fixtureで通常モードを起動し、既存の予定委譲画面を復元。320×720ではdialog幅282px、本文を含めて画面内に収まり、body横幅のoverflowなし。320×480ではdialog領域265×430pxに縦スクロールが生じ、ボタンへTab移動でき、水平overflowなし。
- 320×480でEscapeするとdialogが閉じ、予定状態が保たれ、実行ボタンへfocusが戻った。委譲実行、CLI起動、外部通信は行っていない。viewportを戻し、確認用タブとサーバーを停止した。
- `npm test` — 530 passed、`npm run arch` — 96 paths/0 violations、`git diff --check` — passed。
- 同段階の `npm run smoke` もpassed。スクリプトは設定済みセッション保存先をread-onlyで走査し、出力は件数・時間・安全性チェックの集計に限定された。タイトル、本文、ID、パス、イベント内容は記録していない。smokeサーバーは終了済み。

### 委譲できない理由をセッション詳細へ表示 (2026-10-26)

- セッション詳細の予定委譲について、実行可能な操作だけでなく、デモ、非セッションの対象、未対応provider、operation記録なし、目的不足、WSL、未対応/不完全なCodex対象を安全側の理由表示に分類する純粋判定を追加。
- 実行ボタンは、既存の明示確認付きCodex経路が利用可能な場合だけ表示する。それ以外は理由をその場に表示する。判定出力にsession IDやpathを含めず、実行・CLI起動はしない。
- 合成ブラウザーでは関係編集の目的欄を空にした状態で保存を試み、必須入力のブラウザー検証で保存が拒否されることを確認した。編集は保存せず閉じた。従ってUI上で目的不足の既存関係を作って表示確認することはできず、理由判定はunit testで検証。実セッション、CLI、外部サービスは使用していない。
- `npm test` — 535 passed、`npm run arch` — 96 paths/0 violations、`git diff --check` — passed。
- 前回の合成委譲実行試行に関する不確実性は引き続き残り、実セッション/CLIとの適合性、実行経路は未確認。

### デモ委譲の利用不可理由をGUI確認 (2026-10-26)

- `npm run demo -- --port 19828` で隔離したloopbackデモを起動。合成Codex WSLカードから合成Claudeカードへの委譲記録を画面で作成し、詳細に「デモモードではCLIへの委譲を実行できません」と出て、実行ボタンが表示されないことを確認。
- この操作はbrowser localStorageの合成グラフ記録だけを変更した。委譲API/CLI、実セッション、外部サービスは使用せず、確認後にサーバーを停止した。隔離originの記録は残る可能性がある。
- これはdemo modeのGUI経路のみを確認したもの。未対応provider/WSL/operation不整合の各理由はunit testの対象であり、実providerセッションでの適合性は未確認。

### ローカル実データを使った読み取り専用起動smoke (2026-10-26)

- `npm run smoke` が127.0.0.1へ一時起動し、設定済みのClaudeセッション保存先をread-onlyで読み込んだ。出力はボードの欄別件数、形式/安全性チェック、時間の集計に限られ、タイトル、本文、ID、パス、イベント文字列は出力しなかった。smokeは成功し一時サーバーは終了した。
- このsmokeのprovider sourceはClaudeセッションであり、Codex CLI検出・Codexイベント適合性の検証ではない。実Codex CLI候補数はこの実行から結論しない。

### 理解負債の解消条件とGUI受入 (2026-10-26)

- 不足する根拠・必要な説明をカードに明記した理解負債は、それぞれ対応する `evidence` / `explains` 関係を現在のグラフ上に持つまで「完了」「解消済み」にできない。新規作成・編集のUIとpure modelの両方で制約し、既存解消済みカードも必要な関係や参照セッションが失われると再レビュー対象へ戻す。
- 合成デモUIで、リンク無しの解消操作がフォーム検証で拒否されること、根拠リンク後に不足表示が説明だけへ減ること、説明リンク後は解消状態へ保存できること、再読込で状態と関係が復元されることを確認。接続先は隔離demo内の合成セッションであり、実セッション・CLI・外部サービスは使用していない。
- `npm test` — 535 passed、`npm run arch` — 96 paths/0 violations、`git diff --check` — passed。実装は「何が未接続か」とその根拠/説明先を明示するもので、本人の理解を採点・推定しない。
- このUI受入は宣言した根拠/説明リンクの存在と保存だけを検証する。リンク先内容を人が読んで十分と判断したか、理解負債の発見精度やチームの実運用効果は自動検証せず、ユーザーの確認が必要。

### 関係消失時の解消状態表示 (2026-10-26)

- 必須の根拠/説明リンクが消えた理解負債は、保存済み状態を改変せずにレビュー対象へ戻す既存判定に加え、キャンバスの完了/解消済みラベルを「要確認」と表示する。実際の理解やリンク先の内容を推定せず、グラフ内の欠けた関係だけを根拠にする。リンクが復元されれば保存済み状態の表示に戻る。
- pure presentation helperのテストで、解消済み/完了の理解負債だけが欠落時に「要確認」となり、リンクが揃った後・他状態・他カード種別の表示は変わらないことを確認。`npm test` — 536 passed、`npm run arch` — 96 paths/0 violations、`git diff --check` — passed。
- 隔離デモで合成理解負債カード作成・根拠/説明リンク・解消保存までを確認。リンク解除ダイアログの表示後、ブラウザー操作がtimeoutしたため解除後の表示は画面で確認できていない。ブラウザーlocalStorageの最終状態は未確認で、実セッション/CLI/外部サービスは使用していない。

### キャンバス検索と表示中の理解負債状態 (2026-10-26)

- キャンバスカード検索は保存状態に加え、現在表示される状態名 (例: 要確認) と欠けている根拠/説明関係の日本語・英語ラベルも対象にする。既存の題名、説明、対象者、不足項目、実行条件の検索語も維持する。session/provider wireやイベント表示には影響しない。
- pure search projectionの回帰テストで、解消済みでも必須リンク欠落中のカードが「要確認」「根拠」およびユーザー記述の不足内容で検索可能なことを確認。`npm test` — 537 passed、`npm run arch` — 96 paths/0 violations、`git diff --check` — passed。
- 今回はブラウザーの再取得APIが連続timeoutしたため、検索語を入力するGUI受入は未実施。検索helperと状態ラベルの統合はテスト済みだが、実画面での絞り込み表示は次回確認する。
- 追試では隔離demoに合成理解負債カードを作成し、検索欄に「根拠」を入力するとカードが `is-dim` にならず一致表示されることを確認。カードを解消済みにし、根拠関係を外して「要確認」検索も確認する手順は、リンク解除操作と状態取得がtimeoutしたため未確認。解除後状態とこのdemo originのlocalStorageは確定できず、合成カードが残っている可能性がある。サーバーは停止済みで、実セッション/CLI/外部サービスは使用していない。
- 解除操作をもう一度GUIで試し、確認ダイアログで Escape を選ぶと、合成カードは根拠リンクがない状態となり「要確認」と表示され、詳細ラベルに「グラフ上で未接続: 根拠」が現れた。検索欄へ「要確認」を入れるとカードはcanvasに残って画面上で通常表示され、同時にセッション欄は0件となり「一致するセッションはありません」と案内した。隔離demoのlocalStorageには合成カードと根拠リンクなしの状態が保存されている。サーバー停止を確認し、実セッション/CLI/外部サービスは使っていない。
- この併存が分かるよう、検索欄のアクセシブル名にcanvas cardを含め、0件案内にも検索対象としてsessionとcanvas cardを明記した。追加のi18n回帰テスト後に `npm test` — 538 passed、`npm run arch` — 96 paths/0 violations、`git diff --check` — passed。port 19832の隔離デモで更新後の日本語ラベルと0 session案内を確認し、検索語「要確認」に一致する合成カードが通常表示で残ることを再確認した。サーバー停止済み。実セッションやCLIは使用していない。
- 検索を関係線にも拡張。関係種別・利用者記録の目的・許可状態のラベルを検索し、目的語が一致すれば接続先sessionがsession filterで0件でも線を強調する。単体テストでは目的/委譲状態の投影と未知状態値の除外を確認。`npm test` — 539 passed、`npm run arch` — 96 paths/0 violations、`git diff --check` — passed。隔離デモでは「UI relation search acceptance」という合成目的だけを検索し、0 session案内とともに関係線が明るく表示され、カード側は薄くなることを画面確認した。合成目的は同じ隔離originのlocalStorageに残る。サーバー停止済み。実セッション/CLI/外部サービスは使っていない。
- 検索アクセシブル名と0件補足を改め、関係種別・目的・委譲状態も対象だと明記。最新隔離デモで日本語ラベルと補足を読み上げ可能なDOMで確認し、合成目的検索で明るくなる関係線を再確認した。`npm test` — 539 passed、`npm run arch` — 96 paths/0 violations、`git diff --check` — passed。デモサーバー停止済み。

### キャンバスGraphカードのプロジェクト絞り込み (2026-10-26)

- Graphカードが直接つながるセッションの `project.key` によってプロジェクト絞り込みへ参加する。同一カードに異なるプロジェクトのセッションが複数つながる場合はいずれかの選択プロジェクトに一致すれば残す。直接つながるsessionがないカードは推測で分類せず盤面全体に残す。不一致カードは薄く表示し、読み上げラベルに「絞り込み外」を加える。
- pure helperのテストで関係方向の両方、複数project、不一致、未接続・未絞り込みの挙動を確認。`npm test` — 540 passed、`npm run arch` — 96 paths/0 violations、`git diff --check` — passed。
- port 19832の隔離demoで、合成理解負債カードを api-server filterで薄くし、accessible nameに「絞り込み外」が付くこと、接続先のdemo-app filterで通常表示に戻ることを画面確認した。カードは直接接続したCodex/Claude合成セッションのどれかが現在のproject選択に一致すると残る。デモサーバー停止済み。実セッションやCLIは使用していない。

### キャンバスGraphカードの実行元・状態絞り込み (2026-10-26)

- Graphカードは直接つながるsessionの実行元と現在のpile/stateも絞り込みに使う。複数sessionが直接つながる場合、実行元・状態・projectの選択条件すべてに一致する同一sessionが一つ以上あれば通常表示する。条件を別々のsessionで満たしても一致とはしない。直接接続sessionがないカードは分類を推測せず盤面全体に残す。不一致カードは薄く表示し、accessible nameに「絞り込み外」を含める。
- pure helperのテストでClaude/Codex、working/recent、projectの一致・不一致と、複合条件が同一sessionへ適用されることを確認。合成デモUIでは実行元=Codexで薄く、Claudeで通常表示へ戻ること、Claudeカードに対して状態=workingで薄く、needs_youで通常表示へ戻ることを確認した。合成テストカードの直接接続sessionはneeds_you状態。これらはデモ/fixtureによる確認で、実セッションとの適合性を証明しない。

### セッション検索から関連カードへ辿る (2026-10-26)

- キャンバスの文字検索に一致した直接接続sessionがある場合、接続されたGraphカードも一致として強調し、関係線も強調する。検索語に合わないカードへsessionの内容は複製しない。複数の選択フィルターは、同一の直接接続sessionがすべてを満たす条件を保つ。
- unit testで関係方向の両側、未一致・未接続ケースを確認。隔離demo (19833) で合成タスクを合成Codex CLIカードへ接続し、Codexの表示名で検索。一致セッション1件、Graphカードに `is-dim` なし、関係線に `is-dim` なしを確認した。これはGUIの合成確認で、実CLI/実セッション形式は未確認。
- `npm test` — 541 passed、`npm run arch` — 96 paths/0 violations、`git diff --check` — passed。デモサーバーは停止。確認データはこの隔離ブラウザーoriginのlocalStorageにだけ保存され、provider保存先・CLI・外部サービスは使用していない。

### 516px画面でカードと関係ダイアログをキーボード確認 (2026-10-26)

- 516×668pxの隔離demoで、文書の横幅が516pxのまま横スクロールを生じないことを確認。キャンバスの合成カードにキーボードフォーカスを置いてEnterを押すと、カード編集dialogが開き、題名入力欄へフォーカスした。
- 関係dialogを開くと「先」の選択欄へ初期フォーカスした。dialogはx=19、幅478px、右端497pxで画面内に収まり、内容は内部スクロール可能だった。Escapeで閉じた後、フォーカスは元のGraphカードbuttonへ戻った。
- 合成カードは専用demo originのブラウザー内保存領域に残る。実セッション、CLI、外部サービスは使わず、デモサーバー停止を確認。これは516pxでの限定的な受入であり、320pxなど他の幅・全操作の網羅や実スクリーンリーダー確認は未完了。

### Graphカードをドラッグして配置と関係を復元 (2026-10-26)

- 516px幅の隔離demoで合成タスクを作り、ポインターで60×40画面px移動。画面上のカードも同じ差分で移動し、カードの保存座標は`(154,85)`になった。
- UIから合成Codex CLIセッションへの`related`関係を記録し、再読み込み後にカード題名・座標`(154,85)`・関係線1本が復元されることを確認した。これはポインター操作とbrowser-local保存/復元のGUI確認で、実セッション形式やprovider保存先の適合性は証明しない。
- 実セッション・CLI・外部サービスは使わず、デモサーバー停止済み。合成カードと関係はport 19836の専用browser originに残る。横幅516pxのみを確認し、ドラッグ/復元の狭幅全体受入は未完了。

### 変更系APIのOrigin欠落と非JSON送信を拒否 (2026-10-26)

- 委譲実行、worktree作成、worktree削除の各APIについて、Origin欠落時は403、同一Originでも`application/x-www-form-urlencoded`は415となり、操作関数が呼ばれないことを合成HTTPテストで固定。
- `npm test` — 541 passed、`npm run arch` — 96 paths/0 violations、`git diff --check` — passed。実CLIやworktree操作、外部サービスは使用していない。
- port 19837の日本語隔離demoを起動し、一覧画面とキャンバス切替入口の配信を確認。ブラウザー操作APIを利用できず、クリックによるパン/ズーム受入は行っていない。サーバー停止後に待受けがないことを確認。合成GUI内容だけを使い、実セッション/CLIは使用していない。
- CI run `40331807923` は Windows/macOS/Linux × Node 22/24 の6ジョブすべて成功。

### キャンバスのカメラをGUIで操作 (2026-10-26)

- port 19838の隔離demoでキャンバス表示へ切り替え、拡大ボタンで62%から80%へ移動。キャンバスにフォーカスして右矢印を押すとworldの横平行移動が変わり、キーボードパンが動作した。
- 再読込後もCanvas表示モードは復元し、カメラは62%の初期フィットへ戻った。カード/関係のブラウザー保存とは別挙動。実セッション・CLI・外部サービスは使わず、デモサーバー停止済み。

### キャンバス視点の保存と復元 (2026-10-26)

- wide/narrowごとに数値の視点 `{x,y,z}` とFit状態だけをブラウザー内へ保存し、再読込後に復元するようにした。Fit状態は現在の盤面に合わせて再計算する。明示的な一覧からのFit起動は保存値より優先する。
- セッション、カード題名/本文、パス、provider値はカメラ保存形式に含めない。壊れた値、範囲外の値、保存領域の例外は無視する。
- 純粋な保存adapterのテストでwide/narrow分離、Fit値、許可フィールド、壊れた形式、保存例外を検証。最初のGUI受入では起動時のfocusinが保存値を上書きする問題を検出し、カメラ復元完了前の保存を抑止した。
- port 19845の新しい合成デモoriginで、キャンバスへ切り替え、拡大と右矢印パンを行った後に再読込。倍率80%とworld変換値が再読込前後で一致した。続けてFit allを選んで再読込し、34%のFit表示が再計算後も一致した。合成データのみで実セッション・CLI・外部サービスは使用せず、サーバー停止済み。
- port 19847の隔離合成デモで1280×800と516×900を切り替えて確認。狭幅の保存視点は再読込後も一致し、広幅へ戻すと元の広幅視点 `matrix(0.8, 0, 0, 0.8, -214.19, 39.53)` が復元された。幅クラス境界を越えるResizeObserver更新が、表示変換後の値で反対側の保存領域を上書きする問題を検出し、境界をまたぐリサイズ時の保存を抑止した。実データ・CLI・外部サービスは使っていない。
- 音声Main AIと企業向け権限制御の操作/保存/処理/role/allow-deny仕様はユーザー回答で未定義。推測で追加しない。
- 壁打ち未定義とユーザー回答された音声Main AIの開始/停止・処理保存先、企業権限の利用者ロール・許可/禁止操作は仕様化せず、未実装の確認事項として残す。

### 現在のCodex保存先で0件理由を再確認 (2026-10-26)

- Codex adapterを現在のCODEX_HOMEにread-onlyで実行し、rollout候補38件、CLI markerなし38件、形式不整合0件、認識0件を集計した。本文・イベント末尾・ID・ファイル名・パスは出力していない。
- Claude/Copilot/OpenCodeとprojectsは空の一時保存先へ向けた通常起動を行い、「読み込みの状態」に同じ38/0件とCLI marker不在、「CODEX_HOMEがCodex CLI保存先か確認」の案内が表示されることを確認した。実Codex CLIセッションが検出されなかったので、実セッション表示・イベント状態は未確認のまま。CLI起動、新規セッション作成、worktree操作、外部要求は行っていない。
- ローカルサーバーは停止し、隔離ブラウザータブを閉じた。一時保存先の削除は実行環境ポリシーに拒否されたため、一時ディレクトリだけ残存する。内容は空。

### 合成キャンバスカードのキーボード編集と復元 (2026-10-26)

- port 19848の隔離demoでタスクカードを画面から作成し、再読み込み後に同じカードが表示されることを確認した。カードをキーボードで編集し、Escapeで閉じるとフォーカスが対象カードへ戻った。
- 同じ合成画面でキャンバス表示へ切替し、追加カード操作と「並べ直す」を確認した。GUI受入で使ったのはdemo専用originのlocalStorageのみ。実セッションの内容、CLI、外部サービス、Git worktreeは使わず、サーバー停止済み。
- その後の通常起動smokeでは、アプリの読取専用adapterがローカル保存先を読み、起動・表示集計まで成功した。出力は件数等の集計だけで、セッション名/本文/識別子/パスは記録していない。`npm test`は544件成功、`npm run arch`は96パス・違反0件、`npm run smoke`は成功、`git diff --check`も成功。
- この確認はカード作成/復元と1つの編集dialogのキーボード経路に限る。全種類の編集dialog、関係dialog、狭幅での同操作、実スクリーンリーダーによる読み上げは未確認。

### Graphカードの矢印移動と保存復元をGUI確認 (2026-10-26)

- port 19849の隔離demoで合成タスクカードを追加。カード編集をEnterで開いてEscapeで戻り、カードへフォーカスが復帰した状態からArrowRightを押すと保存座標が`x=828`から`x=852`へ移動した。
- 再読込後も`x=852`が復元された。これはキーボードによるカード位置変更とbrowser-local保存のGUI確認。実セッション・CLI・worktree・外部サービスは使用せず、デモサーバー停止済み。
- この確認は追加した単一カードと右矢印に限られる。ほかの方向キー、複数カードの重なり、狭幅のキャンバス移動は未確認。

### キャンバスのキーボード案内を選択言語で読み上げ (2026-10-26)

- アクセシビリティツリーで日本語画面のキャンバス説明だけ英語だった不具合を修正。`cv-keys`を既存の`canvas.keys`翻訳キーへ結び、英語/日本語辞書の文言を使うようにした。
- port 19851の隔離demoで日本語UIのキャンバス説明が日本語になり、言語切替後は英語説明へ変わることをアクセシビリティツリーで確認した。実セッション・CLI・worktree・外部サービスは使わず、サーバー停止済み。
- `npm test`: 545件成功、`npm run arch`: 96 paths・違反0件、`npm run smoke`: 成功、`git diff --check`: 成功。

### Provider-native session IDをpublic boardから除去 (2026-10-26)

- Codex CLIとCopilotのカードIDは、adapter内でprovider名を含むSHA-256から安定したUUID形opaque IDを作るようにした。保存先のnative IDはCodexのprivate `cliSessionId`としてserver内にのみ残し、boardのJSONには出さない。sourceごとにhash domainを分ける。
- 既存ブラウザーのGraphはv1からv2へ一度だけ移行し、旧session endpointをブラウザー内WebCryptoで同じopaque IDへ置換する。関係の目的、委譲状態、operation IDを保つ。移行失敗時はv1を保持して次回取得で再試行する。session ID形自体は維持するためworktree/委譲APIの入力検証は変わらない。
- 合成fixtureでCodex/Copilotのpublic boardにnative IDが含まれないこと、Graph v1の移行で関係内容が保たれ、正規adapter IDと一致し、再実行しても変化しないことを検証した。実セッションや実ブラウザー保存領域への移行は未確認。

### キャンバス上でグラフカードを関係線で接続 (2026-10-26)

- 接続モードのpure helper testを追加。起点設定、自己接続の拒否、別カード選択、選択キャンセルを検証し、npm testは550件成功、npm run archは99 paths・違反0件。
- 当時はlocalhost demoの/と/graph-render.mjsがHTTP 200で配信されることだけを確認し、Computer UseがChromeのURLを判定できずGUI受入は未確認だった (2026-10-27の追記で確認範囲を更新)。
- グラフカードにキーボードでも起動できる接続ハンドルを追加。起点を選ぶと他カードを接続先として選べ、既存の関係ダイアログで関係種別/目的を確認して保存する。接続先はダイアログで事前選択され、Escapeで選択モードをキャンセル可能。保存は既存のGraph localStorage形式を使うため再読み込み後も関係線と目的が復元される。
- グラフカード同士の接続に加えて、セッション付箋とグラフカード双方に接続ハンドルを設け、session↔graphの端点ドラッグから同じ関係ダイアログを開く。
- 2026-10-27の隔離demo受入でsession→graphとgraph→sessionの両方向を実操作し、対象が事前選択されたダイアログを保存。再読み込み後にカード1件、session handle 17件、関係線2本を確認した。合成デモのみで、実セッション/CLIは使っていない。
- pure helperではgraph/sessionの端点組み合わせ、自己接続、空/未知endpointを検証する。session→session pointer dragは未操作。近くまでズームしてsession handleを表示する必要がある。狭幅・スクリーンリーダー全操作は別途未確認。

### 新規キャンバスカードの初期配置がセッション付箋と重ならないよう修正 (2026-10-27)

- session handle接続のGUI受入中、新規Graph cardの初期配置が表示中session slipと重なり、drag sourceの方を隠すケースを確認。
- `nextGraphNodePosition`に任意の障害矩形を加え、キャンバスの全Graph card作成経路からsession slip矩形を渡すようにした。既存graph cardとsession slipの双方を避ける。
- 合成fixtureのpure testと隔離demoのUIで確認。demo上で17 session slipsと追加カードの矩形を比べ、重なり0件。実セッション/CLIは未使用。

### 合成セッション間の委譲関係を画面から記録し復元 (2026-10-27)

- 隔離した合成デモでCodexセッション詳細の「関係を記録」を開き、Claudeセッションを委譲先、関係種別を「委譲の記録」、目的を合成テキストにして保存した。
- 保存後のセッション詳細には委譲先、目的、予定状態が表示され、再読み込み後にも同じ内容が残ることを確認した。デモ側はCLIへの委譲を無効と表示し、実行はしていない。
- 2026-10-27に別の隔離Chrome demoで、Codex付箋の接続ハンドルをClaude付箋へポインタドラッグし、先が事前選択されたダイアログで委譲目的/予定状態を保存した。Codex詳細欄で委譲先と目的を確認し、再読み込み後にも復元された。
- session→sessionのpointer drag、関係記録、詳細表示、ブラウザー内保存・復元を合成データで確認した。デモが委譲実行を無効と表示することも確認し、CLIや外部サービスは起動していない。実セッションは未使用。

### 確認後のworktree作成をGUIから記録・復元 (2026-10-27)

- 隔離した通常起動を一時Claudeメタデータと、外部remote/checkout hookのない一時Git repoへ向けた。実画面でcanvasのsession detailから作成dialogを開き、対象project `repo`、基点`main`、変更なし、未コミット変更は引き継がれないこと、checkout filter実行の可能性を確認した。
- ブランチ名と確認checkboxを画面で指定して合成repo内にworktreeを作成。成功文に続き、branch・基点・作成時の状態要約を含むworktreeカードと、sessionへの`Created by confirmed worktree action`関係が表示された。全体表示で両カードが画面内に収まること、再読み込み後もカードと関係が復元されることを確認した。
- 操作対象は一時fixtureだけ。実ユーザーrepo/worktree、実セッション、CLI、外部サービスは使っていない。隔離サーバーは停止した。実行環境の削除制限により、一時fixture/worktreeは削除できず、OS一時フォルダーに残る。WSL経由の実操作、取消やエラー時のGUI、狭幅のworktree dialog、実セッションとの適合性は未確認。
- 音声Main AIと企業向け権限制御の起動/停止、処理・保存先、role、allow/deny仕様はユーザー回答で未定義。引き続き推測で仕様化しない。

### smoke検証を実データから隔離 (2026-10-27)

- `npm run smoke` が環境の既定ホーム/CODEX_HOME/COPILOT_HOME/OpenCode DBを参照し得る構成だったため、OS一時領域に作る合成Claude sessionだけを明示指定し、Codex/Copilot/OpenCode保存先も同じ一時領域内の未作成先へ固定した。projects dirとrootもfixtureに限定する。
- smokeはClaudeファイル1件・parsed 1件・active 1件、他3 providerの検出0件を検証し、分離が崩れたら失敗する。出力は合成セッションの件数だけ。
- server終了後、許可した一時rootであることを検査してfixtureを削除する。実セッション、CLI、外部通信は使わない。

### 理解負債の証拠・説明・解消をGUIで通し確認 (2026-10-27)

- 隔離demoのキャンバスで合成理解負債を作成し、「進捗を確認される側」の確認対象者、不足根拠、必要な説明を入力した。理解度スコア欄はなく、自動判定はしない。
- 合成成果物カードを`evidence`、判断カードを`explains`で理解負債へ接続。詳細に両端・関係種別・目的が表示され、2種類が揃った後にだけ「解消済み」を保存できた。
- 再読み込み後も対象者・不足根拠・必要説明・解消状態・両関係を詳細から確認できた。実セッションやCLI、外部サービスは不使用。データは隔離demo originのlocalStorageのみ。
- 関係解除は確認dialogを表示したが、確認後のブラウザー制御がtimeoutし、解除後の状態は確定できなかった。GUI解除フローは未確認のままとする。隔離demoサーバーとタブは閉じた。

### 関係解除の状態・保存ゲートをpure coreで検証 (2026-10-27)

- 関係解除のUI経路をpure helperへ集約し、IDが無い関係、確認キャンセル、保存失敗、未完了operation記録ではdialogを閉じたり解除完了扱いにしない。完了済みoperation記録だけは通常関係と同様に明示確認後の解除を許す。
- synthetic unit testで上記の拒否条件と成功経路を確認。`npm test` — 554 passed、`npm run arch` — 99 paths・違反0、`git diff --check` — passed、隔離fixtureを使う`npm run smoke` — passed。
- これは解除policyのpure検証であり、ネイティブ確認後のGUI保存/復元を画面で受け入れたことは意味しない。GUI解除後の状態は引き続き未確認。

### 関係解除確認をアプリ内アクセシブルdialogへ移行 (2026-10-27)

- `window.confirm`を関係編集dialog内の「対象関係の端点・種別」を明示するdialogへ置き換えた。完了済みoperation記録には、Codexセッション自体を変更しない説明も表示する。
- キャンセルまたはEscapeで編集dialogへ戻る。解除確認後は既存pure gateを通し、local graph保存が成功したときだけ両dialogを閉じる。失敗時は既存の保存エラー案内で確認を継続できる。
- static UI testでaccessible name/description、対象説明、日英辞書、confirm/cancel actionを確認。`npm test` — 555 passed、`npm run arch` — 99 paths・違反0、`git diff --check` — passed、隔離fixtureの`npm run smoke` — passed。
- この変更を加えた後の画面表示、Escape/Tab、保存・再読み込みはブラウザーで未確認。2026-10-27の旧native confirmを使ったGUI試行のtimeout記録は過去の結果として残す。

### 委譲の終端状態はlocalStorage保存後にだけ通知 (2026-10-27)

- 委譲の`completed`/`blocked`結果をgraph modelへ適用し、保存adapterが成功を返した場合だけ完了/失敗/状態不明の通知を出すようにした。ブラウザー保存に失敗した場合は既存の保存失敗通知に任せ、古い`active`記録を終端状態と誤案内しない。
- 合成テストで正常保存、保存失敗、operation ID不一致を確認。`npm test` — 556 passed、`npm run arch` — 99 paths・違反0、`git diff --check` — passed、隔離fixtureの`npm run smoke` — passed。
- 実CLIや実委譲は起動していない。UIの保存失敗表示は構造的に既存通知を使用するが、ブラウザーでの障害注入受入は未実施。

### グラフ破壊操作の確認dialogを共通化 (2026-10-27)

- カード削除、関係解除、ブロック済みCodex委譲の追跡ロック解除を、対象と影響を説明するアクセシブルなアプリ内dialogに統一した。カード削除は関連関係も削除することを示し、worktreeカードはキャンバス記録だけが消えてGit worktreeは残ると説明する。追跡ロック解除はPigeonholesの記録だけを解除し、Codexへ接続・停止しないことを示す。
- キャンセル/Escapeでは元の編集画面へ戻り、確認後は既存のpure helperと保存成功ゲートを通る。カードを削除したときは消えたカードへフォーカスを戻さずキャンバスへ復帰する。
- `npm test` — 556 passed、`npm run arch` — 99 paths・違反0、`npm run smoke` — 合成fixtureでpass、`git diff --check` — pass。
- アクセシブル名・説明・日英文言と操作の配線はテスト済み。今回の変更後にブラウザーでTab/Escape/保存/再読み込みを受け入れるGUI確認は未実施。
- 2026-10-27の再試行では合成demoをlocalhostで起動したが、Windows Computer UseがChromeの現在URLを安全に特定できず、画面確認前に停止した。UI操作は一度も行っていない。停止確認時に19864番portのlistenerは無く、実セッションや実worktreeは使っていない。

### 確認dialogのモーダル意味を支援技術へ明示 (2026-10-27)

- 共通の破壊操作確認dialogに`role="alertdialog"`と`aria-modal="true"`を追加し、確認用モーダルとしての意味を明示した。既存の`aria-labelledby`と`aria-describedby`は維持する。
- static UI assertionを更新し、`npm test` — 556 passed、`npm run arch` — 99 paths・違反0、隔離fixtureの`npm run smoke` — passed、`git diff --check` — passed。
- スクリーンリーダーでの実際の読み上げとブラウザー上のキーボード受入は未確認。

### 理解負債の詳細で空欄を未記録として表示 (2026-10-27)

- 関連セッションの詳細では、確認対象者・不足根拠・必要な説明の空欄をそれぞれ「未記録」と表示する。空欄を「該当なし」や「負債なし」とは扱わず、記録の有無だけを明示する。
- 満たされた欄は手入力値を表示し、理解度スコアや自動判定は追加しない。pure summary testで全未記録・一部記録を確認。`npm test` — 557 passed、`npm run arch` — 99 paths・違反0、隔離fixtureの`npm run smoke` — passed、`git diff --check` — passed。
- 今回の詳細表示をブラウザー上で確認するGUI受入は未実施。

### Copilot / OpenCode の起動元をカード詳細で区別 (2026-10-27)

- Copilot詳細には保存形式だけではCLIとアプリを判別できないことを表示する。OpenCode詳細には、記録はOpenCode由来だがadapterが起動元CLI/アプリを特定しないことを表示する。
- CLI固有形式ではないproviderデータをCLIセッションと断定しない。説明は表示用辞書だけに置き、wire/APIへ来歴推定値を追加しない。
- 合成カードでのブラウザー受入とCI結果は未確認。既存のCodex/Claude表示への影響は回帰検証で確認する。

### provider来歴注記の回帰テスト (2026-10-27)

- DOM fixtureでCopilot/OpenCode詳細にだけ来歴注記が付き、Claude/Codexの名称とCodexのWSL場所が保持されることを確認。
- `npm test` — 558 passed、`npm run arch` — 99 paths・違反0、隔離fixtureの`npm run smoke` — passed、`git diff --check` — passed。実ブラウザー受入は引き続き未確認。

### キャンバス上の理解負債に確認対象者と未記録欄を表示 (2026-10-27)

- 理解負債カードに、理解を確認される人・不足根拠・必要な説明を常時表示する。空欄は「未記録」とし、カード上のアクセシブル名にも同じ情報を含める。
- 解消済み扱いのときに根拠/説明関係が無い場合の「要確認」表示、接続フォームへの導線、利用者による妥当性判断は既存動作を維持。理解の推定や数値評価は追加しない。
- `npm test` — 559 passed、`npm run arch` — 99 paths・違反0、隔離fixtureの`npm run smoke` — passed、`git diff --check` — passed。ブラウザーでの視覚/スクリーンリーダー受入は未確認。

### 対象者未記録の理解負債を解消済みにできないよう制約 (2026-10-27)

- UIとpure graph modelの両方で、理解を確認される人が空の理解負債を`done`/`resolved`にできないようにした。UIは対象者欄に理由を出し、入力時に検証エラーを解除する。
- 根拠/説明の既存リンク条件も維持。モデルテストで空の作成、空の状態遷移、対象者を記録後の遷移を確認し、dialog assertionで案内を確認。
- `npm test` — 561 passed、`npm run arch` — 99 paths・違反0、隔離fixtureの`npm run smoke` — passed、`git diff --check` — passed。ブラウザー操作でのvalidationは未確認。
