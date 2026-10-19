// @ts-check
// 画面の言葉 (英語) の続き: spec/ui.md §19.9 (キャンバス)。1 行 1 キー。
// dict-en.mjs が取り込む (400 行の上限のため分けた)。キーと placeholder は dict-ja-canvas.mjs と同じにする。

/** @type {Readonly<Record<string, string | {one: string, other: string}>>} */
export const EN_CANVAS = Object.freeze({
  // 19.9 canvas
  'canvas.aria': 'Canvas: sessions by project',
  'canvas.keys': 'Arrows pan, + and − zoom, f fits everything.',
  'canvas.keysOff': 'Arrows pan. The buttons in the bar below zoom and fit everything.',
  'canvas.headAria': '{project}: {list}',
  'canvas.headKeys': 'Enter shows buttons that move this sheet. Shift and the arrow keys move it too.',
  'canvas.part': '{pile} {n}',
  'canvas.farCount': '{n} for you',
  'canvas.slip': '{pile}: {title}, {time}',
  'canvas.slipName': '{pile}: {title}',
  'canvas.slipKeys': 'Enter opens it in the Claude app. Space shows details. The arrow keys move to the session next to it.',
  'canvas.noMatch': 'not in the filter',
  'canvas.fold': 'Only to archive',
  'canvas.foldCount': { one: '{n} project', other: '{n} projects' },
  'canvas.foldOpen': 'opens To archive in the list',
  'canvas.faded': 'To archive; a related session is still open',
  'canvas.zoomIn': 'Zoom in',
  'canvas.zoomOut': 'Zoom out',
  'canvas.zoom': '{n}%',
  'canvas.fit': 'Fit all',
  'canvas.arrange': 'Rearrange',
  'canvas.arrangeDone': { one: 'Rearranged {n} project.', other: 'Rearranged {n} projects.' },
  'canvas.moved': 'Moved {project}.',
  'canvas.blocked': 'There is no room to move {project} that way.',
  'canvas.hint': 'Drag to pan. Drag or press a project name to move its sheet. Ctrl + wheel to zoom.',
  'canvas.close': 'Close',
  'canvas.barAria': 'Canvas tools',
  'canvas.sheetLead': 'Move “{project}”',
  'canvas.sheetHint': 'Each press moves it a little. On its name, Shift and the arrow keys do the same.',
  'canvas.move.left': 'Move left',
  'canvas.move.up': 'Move up',
  'canvas.move.down': 'Move down',
  'canvas.move.right': 'Move right',
  'canvas.sheetFit': 'Show this sheet',
});
