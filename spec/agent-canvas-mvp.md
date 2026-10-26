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
- 関係の `delegates` は追跡用記録に限り、自動委譲や CLI 実行はしない。PM policy、実行条件の検出、Obsidian、WSL、音声 Main AI、企業権限制御は今段階の完了条件に含まれない。ユーザーの後続依頼でworktreeの明示作成・一覧・確認付き削除を段階実装中。実Gitへの作成・削除は未検証。
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
- 製品像の未完了: WSLは明示WSL共有経由のopt-in adapterと合成UI例を追加したが、実WSLファイル共有・実セッションとの適合性は未確認。Copilot保存形式はCLI/app共通のためCLIだけとは識別せず、OpenCode legacy形式も状態/イベントはunknownのまま扱う。実行条件の自動検出、worktreeの実Git確認、Obsidian vault indexing/knowledge extraction、REAの自動解析/完全Evidence取込は未完了。ユーザーは音声Main AIと企業権限制御を完成条件として確認したが、音声の開始/停止主体・処理/保存先と、利用者ロール・許可/禁止操作の仕様は提示待ちであり、ここでは推測して実装しない。Obsidianは手動vault-relative note参照のみ追加し、vault走査や内容取得はしない。委譲記録の元/先は関係線とセッション詳細から追えるようになったが、実際の委譲実行は未実装。理解負債はユーザー記述の対象者・不足根拠・必要説明をカードに記録するだけで、自動推定やスコアはない。
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
| 操作可能なCanvas | 一覧/Canvas切替、検索とsource/state/project絞り込み、session slipsとtask/artifact/decision/worktree/理解負債/execution profile/Obsidian参照カード、ドラッグ・キーボード移動、パン・ズーム、関係線、localStorage復元 | 最新のラベル修正以降に全操作をブラウザーから通す手動受入確認は未実施。自動テストと過去の合成ブラウザー確認の範囲を超えて完成とはしない |
| セッション・イベント | Claude Code、Codex CLI、Copilot、OpenCodeにread-only adapterがあり、同じboardでallowlistイベント・状態・詳細を表示。関係pickerも表示中の全providerを対象とする | Codex CLI起点の実セッションは未確認。Copilot保存先はCLI/app共通、OpenCode DBもproducer clientをadapterが識別しない。OpenCode旧schemaは一覧以外の状態/イベントをunknown扱い |
| ハーネス・実行条件 | 詳細に観測可能なprovider/sourceを表示。Codex CLIはCLI markerを満たす記録に限定。場所・分離・network・approvalは不明初期値の手動profileとして関連付け可能 | Copilot/OpenCodeではCLIかアプリかを断定できない。セッションや環境から実行条件を自動検出しない。profile値は利用者申告で、実際の設定・モデル・実行条件の証明ではない |
| 委譲 | 委譲元/先、目的、状態を関係線と詳細に記録 | CLI起動・agentへの実委譲は未実装。外部作用は明示操作後のみという境界は維持するが、起動するCLI・引数・入力・権限範囲は仕様未確定 |
| Git worktree / PM policy | local Git worktreeの読取一覧、明示確認後の作成、clean/non-current等を再確認した確認付き削除、canvas上のpath-free記録。作成/一覧/削除adapterは一時Git repoで統合確認済み | 実ユーザーrepoへの操作とブラウザー確認dialogの一連受入は未確認。WSL worktree操作は無効。PM policyは「この依頼の安全条件だけ」で、追加の自動規則なし |
| Comprehension Graph / 理解負債 | 理解を確認される人、未提示の根拠、必要な説明を記録。`evidence`/`explains`未接続をグラフ欠損として提示し、根拠先へ移動可能 | 人の理解度を推定・採点しない。記録と関係付けは利用者判断で、自動的に理解負債を発見する機能ではない |
| REA / Knowledge Layer | ユーザー確認済みの短いREA要約をartifactへ手動記録。Obsidian vault-relative note URIを手動登録して明示リンクで開く | REAは起動せず完全Evidenceを取込まない。Obsidian vault走査、内容読取/書込、indexing/知識抽出は未実装 |
| OpenCode / Copilot / WSL | OpenCode DBとCopilotイベントのread-only adapter。明示設定されたWSL共有を使うopt-in Codex reader | 実WSL共有は未確認。CLI/app producer識別、OpenCode legacy状態、未知形式の挙動には上記の制限がある |
| 音声 Main AI | なし | ユーザーは完成条件と指定。開始/停止主体、音声・文字起こしの処理先/保存先、同意と削除の仕様は貼付待ち。推測実装しない |
| 企業向け権限制御 | なし | ユーザーは完成条件と指定。利用者role、操作ごとの許可/禁止、監査・組織設定の仕様は貼付待ち。推測実装しない |

この表は実装済みと未確認を区別する追跡情報であり、未完了項目の代替完成条件ではない。音声Main AI・企業権限・委譲実行の仕様が確認でき、各機能を実装・検証するまではAgent Canvas製品像全体を完了扱いにしない。
