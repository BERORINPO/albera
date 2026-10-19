// @ts-check
// 画面の言葉 (日本語) の続き: spec/ui.md §19.9 (キャンバス)。1 行 1 キー。
// dict-ja.mjs が取り込む (400 行の上限のため分けた)。キーと placeholder は dict-en-canvas.mjs と同じにする。

/** @type {Readonly<Record<string, string>>} */
export const JA_CANVAS = Object.freeze({
  // 19.9 canvas
  'canvas.aria': 'キャンバス: プロジェクトごとのセッション',
  'canvas.keys': '矢印で移動、+ と − で拡大縮小、f で全体',
  'canvas.keysOff': '矢印で移動。拡大縮小と全体の表示は下の帯のボタンで',
  'canvas.headAria': '{project}: {list}',
  'canvas.headKeys': 'Enter で用紙を動かすボタンを表示。Shift と矢印でも動かせます',
  'canvas.part': '{pile} {n}',
  'canvas.farCount': '要対応 {n}',
  'canvas.slip': '{pile}: {title}、{time}',
  'canvas.slipName': '{pile}: {title}',
  'canvas.slipKeys': 'Enter で Claude アプリで開く。Space で詳しく。矢印で隣のセッションへ',
  'canvas.noMatch': '絞り込み外',
  'canvas.fold': '片付けだけ',
  'canvas.foldCount': '{n} 件のプロジェクト',
  'canvas.foldOpen': '一覧の片付けを開く',
  'canvas.faded': '片付け (親子の誰かがまだ使用中)',
  'canvas.zoomIn': '拡大',
  'canvas.zoomOut': '縮小',
  'canvas.zoom': '{n}%',
  'canvas.fit': '全体を表示',
  'canvas.arrange': '並べ直す',
  'canvas.arrangeDone': '{n} 件のプロジェクトを並べ直しました。',
  'canvas.moved': '{project} を動かしました。',
  'canvas.blocked': '{project} はその向きにはもう動かせません。',
  'canvas.hint': 'ドラッグで移動。プロジェクト名をドラッグか押すと用紙を動かせます。Ctrl+ホイールで拡大縮小',
  'canvas.close': '閉じる',
  'canvas.barAria': 'キャンバスの操作',
  'canvas.sheetLead': '『{project}』を動かす',
  'canvas.sheetHint': '押すたびに少しずつ動きます。プロジェクト名の上では Shift と矢印でも同じです',
  'canvas.move.left': '左へ',
  'canvas.move.up': '上へ',
  'canvas.move.down': '下へ',
  'canvas.move.right': '右へ',
  'canvas.sheetFit': 'この用紙を表示',
});
