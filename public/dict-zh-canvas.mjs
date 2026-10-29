// @ts-check
// 画面の言葉 (簡体字中国語) の続き: spec/ui.md §19.9 (キャンバス)。1 行 1 キー。
// dict-zh.mjs が取り込む (400 行の上限のため分けた)。キーと placeholder は dict-en-canvas.mjs と同じにする。

/** @type {Readonly<Record<string, string>>} */
export const ZH_CANVAS = Object.freeze({
  // 19.9 canvas
  'canvas.aria': '画布：按项目分组的会话',
  'canvas.keys': '方向键平移，+ 和 − 缩放，f 显示全部。',
  'canvas.keysOff': '方向键平移。下方工具栏的按钮可以缩放和显示全部。',
  'canvas.headAria': '{project}：{list}',
  'canvas.headKeys': '按 Enter 显示移动此画板的按钮。Shift 加方向键也可以移动。',
  'canvas.part': '{pile} {n}',
  'canvas.farCount': '{n} 个需要你',
  'canvas.slip': '{pile}：{title}，{time}',
  'canvas.slipName': '{pile}：{title}',
  'canvas.slipKeys': '按 Enter 在 Claude 应用中打开。按空格查看详情。方向键移到相邻的会话。',
  'canvas.noMatch': '不在筛选范围内',
  'canvas.fold': '仅待归档',
  'canvas.foldCount': '{n} 个项目',
  'canvas.foldOpen': '在列表中打开“待归档”',
  'canvas.faded': '待归档；但有相关会话仍在使用',
  'canvas.zoomIn': '放大',
  'canvas.zoomOut': '缩小',
  'canvas.zoom': '{n}%',
  'canvas.fit': '显示全部',
  'canvas.arrange': '重新排列',
  'canvas.arrangeDone': '已重新排列 {n} 个项目。',
  'canvas.moved': '已移动 {project}。',
  'canvas.blocked': '那个方向没有空间移动 {project}。',
  'canvas.hint': '拖动可平移。拖动或按住项目名可移动它的画板。Ctrl + 滚轮缩放。',
  'canvas.close': '关闭',
  'canvas.barAria': '画布工具',
  'canvas.sheetLead': '移动“{project}”',
  'canvas.sheetHint': '每按一次移动一点。在项目名上，Shift 加方向键效果相同。',
  'canvas.move.left': '向左移动',
  'canvas.move.up': '向上移动',
  'canvas.move.down': '向下移动',
  'canvas.move.right': '向右移动',
  'canvas.sheetFit': '显示此画板',
});
