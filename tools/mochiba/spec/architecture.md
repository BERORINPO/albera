# アーキテクチャ (持ち場 v1)

表 1 は `test/arch.check.mjs` が読んで検査する。パスを変えたら、この表と検査を一緒に直す。

## 1. 役割対応表
| 役割 | パス |
|---|---|
| shared | src/shared/ |
| core | src/core/ |
| adapter | src/adapter/ |
| entry | src/entry/ |

- 依存は entry → adapter → core → shared の一方向だけ。循環は禁止
- shared は何も import しない。core は shared だけ (node: の部品・process・時計は禁止。日付は entry から受け取る)
- adapter は 1 本ごとに fake-<名前>.mjs を持つ。HTML の中身は template.html と src/entry/page/*.js (render.mjs が 1 枚にまとめる)。データは JSON で入れて DOM で描く

## 2. 外部境界表
| adapter | 相手 | Fake | fixture | credential | 書き込み |
|---|---|---|---|---|---|
| src/adapter/fs-repo.mjs | ファイル (対象 repo は読むだけ) | fake-fs-repo.mjs | test の中で組む | なし | `--out` の 1 ファイルだけ (対象の repo の中は、junction を解いた先も含めて cli が断る) |
| src/adapter/git.mjs | git (`log` と `rev-parse --show-toplevel` だけ。`core.quotePath=false`・`--no-textconv --no-ext-diff`) | fake-git.mjs | test の中の log 文字列 | なし | なし |
| src/adapter/gh.mjs | GitHub CLI (`gh pr view`) | fake-gh.mjs | test の中の JSON | gh のログイン (gh 側) | なし。無い・失敗は画面に出して続ける |

## 3. Origin・監視
- 書き出す HTML は 1 ファイルで完結。外への通信なし (CSP で default-src 'none')。「開く」は vscode://file/ のリンク
- 常駐しない。exit 0 = 書けた / 1 = 入力の誤り / 2 = 予期しない失敗

## 4. 決定ログ
| 日付+topic | 決定 | 理由と却下案 | lint 昇格 |
|---|---|---|---|
| 2026-11-24 labels-merge | `--labels` で同じ名前を付けたまとまりは、同じ役割の中で 1 つの箱にまとめる | ファイル名の最初の語だけでは試し先 (116 ファイル) が 92 箱になり 40 前後に収まらない。却下: 小さいまとまりを捨てる (spec が「1 つでも箱」) | 無し |
| 2026-11-24 git-log | `git log --numstat --summary --relative --topo-order` を 1 回だけ呼ぶ | 変更行数と「新」を同時に取るため (spec の --name-only の上位)。PR は merge の 2 番目の親からたどって割り当てる | 無し |
| 2026-11-24 core-no-clock | core は時計を持たず、今日の日付を引数で受け取る | 同じ入力なら同じ地図になるように | 有り (arch.check の禁止 API) |
| 2026-11-24 review-fixes | 表 1 のフォルダ行は .mjs/.js/.html に展開する。`..`・`/`・ドライブ名で始まるパスは読まない。`--out` は対象 repo 全体の外だけ許す | 自分自身 (フォルダで書いた表) が空の地図になったため。repo 単位で「何も書かない」を守るため。却下: フォルダ行を notice だけで捨てる | 有り (cli.test / core.test / adapter.test の回帰テスト) |
| 2026-11-24 地図の見せ方 | 機能ごとの横並びが既定・箱はドラッグ可・選んだ箱の線だけ光る・層またぎは青/同じ層はピンク・向きは流れる光の粒・押すと「つながりだけ」表示 | 画面を見ながら詰めた (矢印は重なって読めず却下、3 段先までの道は光りすぎて却下) | lint 昇格: 無し |
| 2026-11-24 紙芝居 | PR ごとの紙芝居を地図に足す。コマは git と表から自動で作り (AI 無し)、AI が書いた JSON を `--story` で渡せば差し替える。JSON の中身は core が地図と突き合わせ、合わない所だけ捨てて注意に出す | 使える AI は職場ごとに違うので、どの AI でも同じ形で書ける JSON を入口にした。却下: mochiba が AI を呼ぶ (vendor 依存・常駐が要る)、コマを手で書かせるだけ (書かないと何も出ない) | 有り (story.test の検査、validateMap が stories を検査) |
| 2026-11-24 page-split | 画面の JS を template.html から src/entry/page/*.js に分けた | template が 800 行の上限に届いたため。arch 検査は page/*.js も HTML と同じ禁止語で見る | 有り (arch.check) |
| 2026-11-24 説明の練習 | 問いに地図の箱を押して答え、地図のデータで答え合わせする。問いは地図から自動 (変わった箱・道具を使う箱・箱が使う箱) と、--story の questions から。答え合わせの関数は page/grade.js に置き、node のテストも同じファイルを読む | 案 2 を選択。却下: 言ってから開く案 (自己申告だけで確かめられない)。答え合わせを core に置く案 (画面の JS は core を import できず、写すと 2 つがずれる) | 有り (quiz.test が grade.js を読む) |
| 2026-11-24 つながりだけの折り返し | 「つながりだけ」で相手が多い箱は、相手を片側 4 列まで折り返す。行数は画面に一番大きく出る数を選ぶ。2 列目より外への線は、手前の列の行の隙間 (lane) を通す。線が 12 本を超えたら線の上の言葉は出さない (右の欄に同じ物が出る)。箱を動かすと lane をやめて普通の曲線に戻す | 1 列に縦積みすると、相手 23 の箱で 31%、32 の箱で 25% まで縮んで読めなかった (折り返し後は 71% と 68%)。却下: 層ごとに列を分ける (相手が 1 層に偏ると縦長のまま)、相手をまとめて 1 箱に畳む (中身が見えない) | 有: test/ego.test.mjs (箱が重ならない・lane が箱を横切らない・列は 4 まで) |
| 2026-11-25 issue への入口 | 画面の見出しに「要望・不具合 ↗」の `<a>` を 1 つ置く。行き先は ALBERA の公開 issue 書式 (from-a-copy.yml) の決まったアドレスだけ。arch 検査の「外の資源」規則は残し、この 1 属性だけを例外にする (1 回まで) | 持ち主 (owner) が選択 (押すリンクは読み込みでも送信でもない)。却下: コピーボタン (手間が増える)、画面に置かない (使う人が送り先を探す)、規則ごと緩める (他の https も通る) | 有り (arch.check の ALLOWED_LINK と自己テスト) |
