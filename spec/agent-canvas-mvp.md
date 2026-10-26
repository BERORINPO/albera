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
- REA はユーザー指定の `morluto/rea` (REA: Reverse Engineer Anything) と特定された。公式READMEは、ローカル実行のCLI/MCPからバイナリ・アプリ・実行時挙動を解析し、根拠と制約を含む結果を返すOSSと説明する。Agent Canvasで結び付ける対象 (解析したアプリ、Evidence、レポート、セッションなど) と、参照/取込の境界は未合意。セットアップ・解析実行・直接連携は推測で追加しない。
- PM policy は「この依頼の安全条件だけ適用」と確認した。個別の自動化・承認規則は追加しない。
- 実装のフォローアップはMVPのPR #3を変更せず、後続PRで扱う。
- 2026-10-26: worktreeの読み取り専用状態調査を開始。最大20件の最近の未アーカイブセッションを対象にし、porcelain出力から安全な要約だけをセッション詳細へ渡す。個別PMポリシーは未定義のまま (依頼にある安全条件のみ)。
- 2026-10-26: セッション詳細から明示確認後にローカルworktreeを作るAPIと、同じrepository内の最大20件のpath-free一覧を段階追加。作成結果はブラウザー内のスナップショットカードとして元セッションと関連付ける。カードはlive registryではなく、編集・削除はGit状態を変えない。実worktree作成は未検証。削除・回収とPM policyは未実装。
- 2026-10-26: 読み取り専用一覧のworktreeを、明示操作で元セッションに結び付けてキャンバスへ記録できる。同じbranchの再記録はカード内容だけを更新し、配置を保つ。これはlocalStorageへの記録で、Git状態は変更しない。
- 2026-10-26: worktree削除は、一覧でclean・非current・非locked・非prunableと確認できるbranch worktreeだけを対象に、ブランチ名の入力と影響確認を要求する画面を追加。削除は作業フォルダに限りbranchは残す。ignored filesが消える可能性、実Gitリポジトリでの未検証を明記し、デモでは無効。
- 2026-10-26: 次の独立段階として GitHub Copilot のローカル `session-state/<UUID>/events.jsonl` を追加。read-only adapter が固定されたイベント種別と時刻だけを許可し、Codexと同じ一覧・キャンバス・詳細・source filterに統合する。フォーム/イベントの不一致と不明イベントを安全側で除外し、診断には候補・認識・状態・除外件数のみを返す。合成デモにCopilotカードを1件追加。
- CopilotのCLIとCopilotアプリは同じ `COPILOT_HOME/session-state` を使う。記録のproducer名だけでCLI由来と断定せず、画面上のsource名は「GitHub Copilot」とする。公式の保存先資料とSDKイベント型を実装根拠とした。ローカルの確認では対象ディレクトリは存在したものの `events.jsonl` は0件だったため、実セッション適合性・実データ表示は未検証のまま。fixtureとデモの結果を実データ確認と扱わない。
- 形式根拠: [Copilot CLI config directory reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference) と [Copilot session data](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/session-data) は `session-state/<id>/events.jsonl` の保存先とCLI/app共有を説明する。イベント名は [Copilot SDK generated session event types](https://github.com/github/copilot-sdk/blob/c57638f4a7ce2255a34192d5035932d0e109bbdd/nodejs/src/generated/session-events.ts) に基づく。CLI固有markerではないため、Copilot CLIだけの記録と区別できることは保証しない。
- 2026-10-26: OpenCode縦断段階を追加。`OPENCODE_DB` (既定 `~/.local/share/opencode/opencode.db`) をNode `node:sqlite` のread-onlyで開き、公式V2 `session_v2` / `session_message` の allowlist列だけ読む。wireにはOpenCode source・opaque session ID・時刻・許可イベントコードだけを出し、親IDはopaque化する。idle outcomeは成功・中断・失敗だけを分類し、不明 outcome/JSONはunknownに倒す。旧 `session` スキーマではテーブル構造で識別した上で、安全な一覧用カラム (ID、プロジェクト判定用ディレクトリ、親ID、作成/更新時刻) だけを読み、transcriptテーブルには触れない。旧形式の状態とイベントはunknownで表示し、読み込み状態に明記する。未知形式は除外する。SQLite APIはNode上でexperimentalであり、Node 22.18+ (22系) または24.4+のみ使用する。
- OpenCode形式の根拠: [OpenCode storage docs](https://github.com/anomalyco/opencode/blob/dev/services/www/src/docs/content/cli/providers.mdx) は既定の `opencode.db`、`XDG_DATA_HOME`、リリースチャンネルと `OPENCODE_DB` による場所変更を説明する。[OpenCode session schema](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/sql.ts) と [session message types](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/session-message.ts) のV2定義を根拠にする。read-only optionのruntime gateは [Node.js SQLite docs](https://nodejs.org/api/sqlite.html) の追加バージョン履歴に基づく。
- 2026-10-26: 安全なローカル確認で設定先DBのテーブル構造が現行V2ではなくlegacy `session` 系と確認できた。adapterは安全な一覧列だけを読むlegacy分岐を追加し、状態/イベントは推定せずunknownとする。DBの行内容や件数、セッション識別子、パスは出力しない。OpenCode実データの表示確認は件数とsource/state集計のみで行い、本文は確認しない。
- REAは `https://github.com/morluto/rea.git` と特定された。公式READMEはローカル分析、根拠と制約を含む結果、CLI/MCP経路を説明する。Agent Canvas上で関連付ける対象と、ファイル参照/取込のどちらにするかは未合意のため、連携実装は保留。セットアップ/解析コマンドは実行していない。
- 製品像の未完了: 追加CLIやWSL、実行条件の安全な要約、worktreeの実Git確認、Obsidian知識層、REA関係、音声Main AI、企業権限制御は未完了または範囲未合意。委譲記録の元/先は関係線とセッション詳細から追えるようになったが、実際の委譲実行は未実装。理解負債はユーザー記述の対象者・不足根拠・必要説明をカードに記録するだけで、自動推定やスコアはない。
