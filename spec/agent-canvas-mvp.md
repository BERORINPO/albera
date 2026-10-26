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

### 依頼との差

- Codex CLI のセッションストアを読む adapter と source 共通の session/event model がない。
- 複数イベントの履歴をカード/詳細に描く機能がない (現状は最新状態の要約)。
- セッション間の委譲を安全に実行する境界、Git worktree のライフサイクル、PM ポリシーもない。
- Obsidian、Comprehension Graph、OpenCode/Copilot CLI、WSL、音声 Main AI、企業権限制御も現行範囲外。

## MVP で最初に通す縦断機能

**Codex CLI のローカルセッションを読み取り、イベント要約を既存キャンバスに表示する。**

### 完了条件

1. Codex CLI が作るセッションファイルを read-only で検出し、Claude 用 adapter と分離して解析する。
2. 既存のカード形式に source を追加し、Claude と Codex のセッションを同じプロジェクトキャンバスに表示できる。
3. 詳細に時刻順のイベント要約を表示する。ツール入力・出力、プロンプト本文、環境変数、トークンや認証情報は wire format に含めない。
4. 合成 fixture で検出・未完了イベント・終了イベント・壊れた行・不明イベントを検証し、両 CLI のイベントを混在させても既存 Claude 表示が変わらないことを確認する。
5. `npm test` と `npm run arch` を通し、起動・更新が read-only であることを確認する。

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
