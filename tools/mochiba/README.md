# 持ち場 (mochiba) v1

> **English summary**: an experimental part of ALBERA. From a repository's role tables (`spec/architecture.md`, or a file passed with `--arch`), its imports and its git history, it writes one self-contained HTML page: a map of the code, a walk through each pull request, and a practice mode. No AI, read-only, no network. Run `node src/entry/cli.mjs map <folder in a git repo> --since 7` from this folder (Node 22+, no install). The page and these docs are in Japanese for now.

repo の設計の表 (`spec/architecture.md`)・コードの import・git の変更から「地図」を作り、1 枚の HTML に書き出す。
AI は使わない。対象 repo には何も書かない (読むだけ)。仕様は [spec/v1.md](spec/v1.md)。

## 使い方

Node 22 以上だけで動く (入れる物なし)。この repo の一番上で:

```
node src/entry/cli.mjs map C:\work\shop-app --since 7 --labels examples/labels.example.json
```

1. 書き出し先が `書いた: ...\out\shop-app-map.html` と出る
2. その HTML をブラウザで開く (ダブルクリックでよい)
3. 光っている箱を押すと、右に「中のファイル・この期間の commit と PR・つながる箱」が出る。「開く」で VS Code が開く
4. 右上の「紙芝居」で、PR 1 本を地図の上で 1 コマずつ追える (← → キーで進む)。仕様は [spec/story.md](spec/story.md)
5. 右上の「練習」で、問いに地図の箱を押して答える。答え合わせは地図のデータでする (AI 無し)。仕様は [spec/practice.md](spec/practice.md)

| 引数 | 意味 | 無い時 |
|---|---|---|
| `--since` | 日数 (`7`) か日付 (`2026-11-20`) | 対象フォルダの最後の commit の 1 日前から |
| `--arch` | 役割対応表と外部境界表を書いた md。対象の repo に表を足せない時 (仕事の repo など) に、対象の外に置いた物を渡す | `<対象>/spec/architecture.md` |
| `--labels` | 英字のまとまりに日本語の名前を付ける JSON。同じ名前を付けたまとまりは 1 つの箱になる | 英字のまま |
| `--story` | AI に書かせた紙芝居の JSON (形は spec/story.md。紙芝居の右の欄の「AI に書かせる文をコピー」で頼み文が手に入る) | git と表から自動で作った紙芝居だけ |
| `--out` | 書き出す HTML | `out/<フォルダ名>-map.html` |

- 終わり方: 0 = 書けた / 1 = 入力の誤り (直し方を 1 行で出す) / 2 = 予期しない失敗
- `gh` (GitHub CLI) があれば PR の説明と CI の結果も載る。無ければ「PR の説明は取れなかった (gh 無し)」と出して残りを作る
- 明るい表示: 右上の「明るさ」、または URL の末尾に `#light`

## 仕事の repo で使う

[docs/work-repo.md](docs/work-repo.md) (表を repo の外に置いて `--arch` で渡す・外へは何も送らない)

## 確かめ

```
node --test                 # 全部 (core の単体、fake での cli の通し、arch 検査)
node test/arch.check.mjs    # 依存の向きだけ
```
