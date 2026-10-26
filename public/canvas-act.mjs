// @ts-check
// キャンバスのキー/ボタン/ポインタ操作 (spec/ui.md §10.7–§10.8); canvas-input.mjs がキーを決め、canvas-ctl.mjs が状態とカメラを持つ。

import { CANVAS } from '../src/shared/constants.mjs';
import { minZoom, panBy, stepZoom, zoomAt } from './canvas-camera.mjs';
import {
  apply, canvasJumpPile, closeBar, cv, moveCam, fitAll, fitSheet, fitToggle, headOf, isCanvas, moveCanvasCursor, ok, openBar, openSheetBar, placeSheet, rearrange,
  resized, reveal, revealEl, setCanvasCursor, size, slipClick, switchView, viewport, world, zoomTo,
} from './canvas-ctl.mjs';
import { bindCanvas, canvasEscapeStep } from './canvas-input.mjs';
import { neighbour } from './canvas-layout.mjs';
import { openSession, render, view } from './render.mjs';
import { state } from './state.mjs';
import { nextUp, PILES } from './ui-state.mjs';
import { addGraphNode, addTaskForSession, addWorktreeForSession, graphPlacementObstacles, moveGraphNode, nextGraphNodePosition, updateGraphNode } from './graph-model.mjs';
import { loadGraph, saveGraph } from './graph-store.mjs';
import { openGraphNodeDialog } from './graph-dialog.mjs';
import { GRAPH_CARD_SIZE } from './graph-render.mjs';
import { announce } from './view.mjs';
import { createWorktree, listWorktrees, removeWorktree } from './api.mjs';
import { runDelegationForEdge } from './delegation-act.mjs';
import { openWorktreeDialog } from './worktree-dialog.mjs';
import { openWorktreeListDialog } from './worktree-list-dialog.mjs';
import { worktreeRecordBody } from './worktree-record.mjs';
import { openRelatedSessionDetail, resolveRelatedSessionShortId } from './session-relations.mjs';
import { createGraphActions } from './graph-actions.mjs';
import { cancelGraphConnection } from './graph-connect-mode.mjs';

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** 今フォーカスのある付箋 (無ければカーソル)。 */
function focusedId() {
  const a = document.activeElement;
  const li = a instanceof Element ? a.closest('#cv-world .slip[data-id]') : null;
  return /** @type {HTMLElement|null} */ (li)?.dataset.id ?? state.cursor?.id ?? null;
}

/** j / k: 読む順で次・前の合う付箋。 @param {1|-1} dir */
function step(dir) {
  const order = cv.order.filter(ok);
  if (!order.length) return false;
  const i = order.indexOf(focusedId() ?? '');
  moveCanvasCursor(i < 0 ? order[dir > 0 ? 0 : order.length - 1] : order[Math.max(0, Math.min(order.length - 1, i + dir))]);
  return true;
}

/** Esc (spec/ui.md §10.8)。 */
function escape() {
  if (cancelGraphConnection(cv, render)) {
    announce(state.t('graph.connectCancelled'));
    return true;
  }
  const input = /** @type {HTMLInputElement} */ ($('filter'));
  const a = document.activeElement;
  const s = canvasEscapeStep({
    inFilter: a === input, filterValue: input.value, bar: cv.bar?.kind ?? null, onSlipOrHead: !!(a instanceof Element && a.matches('.slip__title, .sheet__head')), family: state.family, q: state.filter,
  });
  if (!s) return false;
  if (s === 'bar-close') return closeBar();
  if (s === 'to-viewport') return viewport().focus({ preventScroll: true }), true;
  if (s === 'filter-blur') return input.blur(), true;
  if (s === 'family-clear') state.family = null;
  else {
    state.filter = '';
    input.value = '';
  }
  render();
  return true;
}

/** 向きごとのカメラを動かす符号 (用紙を動かすときは逆向き)。 */
const SIGN = Object.freeze({ left: [1, 0], right: [-1, 0], up: [0, 1], down: [0, -1] });

/**
 * 用紙を NUDGE だけ動かし、その柱が見えるようにカメラを合わせる (Shift + 矢印と、帯の「用紙を動かす」のボタン)。
 * @param {string} key @param {string} dir
 */
function nudgeSheet(key, dir) {
  const s = cv.layout?.sheets.find((x) => x.key === key);
  const sign = /** @type {Record<string, number[]>} */ (SIGN)[dir];
  if (!s || !sign) return false;
  placeSheet(s.key, s.x - sign[0] * CANVAS.NUDGE, s.y - sign[1] * CANVAS.NUDGE);
  revealEl(headOf(s.key));
  return true;
}

/** Session selectors use an opaque short ID and provider only; session titles and paths may contain sensitive text. */
function graphSessions() {
  return [...view.index.keys()].map((id) => ({ id, title: `${id.startsWith('codex_') ? 'Codex' : id.startsWith('copilot_') ? 'GitHub Copilot' : id.startsWith('opencode_') ? 'OpenCode' : 'Claude'} session #${id.slice(-8)}` }));
}

function graphChanged(doc) {
  if (!saveGraph(doc)) return announce(state.t('graph.saveError')), false;
  render();
  return true;
}

const graphActions = createGraphActions({
  cv, loadGraph, graphChanged, graphSessions, render, announce, getT: () => state.t, world,
  sessionIds: () => new Set(view.index.keys()),
});

/** Place a new graph card outside project sheets and the archive fold. */
function nextCanvasGraphPosition(graph) {
  const vpSize = size();
  const center = { x: cv.cam.x + vpSize.w / (2 * cv.cam.z) - GRAPH_CARD_SIZE.width / 2, y: cv.cam.y + vpSize.h / (2 * cv.cam.z) - GRAPH_CARD_SIZE.height / 2 };
  const obstacles = graphPlacementObstacles(cv.layout);
  return nextGraphNodePosition(graph, center, GRAPH_CARD_SIZE, obstacles);
}

function newGraphNode() {
  const graph = loadGraph();
  const position = nextCanvasGraphPosition(graph);
  openGraphNodeDialog({ t: state.t, announce, graph, sessions: graphSessions(), position, onSave: (input) => graphChanged(addGraphNode(graph, input, `g_${crypto.randomUUID()}`)) });
}

function newTaskForSession(sessionId) {
  if (!view.index.has(sessionId)) return false;
  const graph = loadGraph();
  const position = nextCanvasGraphPosition(graph);
  openGraphNodeDialog({
    t: state.t, announce, graph, sessions: graphSessions(), position, initialKind: 'task', initialTitle: state.t('graph.taskFromSessionTitle'),
    onSave: (input) => graphChanged(addTaskForSession(graph, input, `g_${crypto.randomUUID()}`, `e_${crypto.randomUUID()}`, sessionId)),
  });
  return true;
}

function createWorktreeForSession(sessionId) {
  const entry = view.index.get(sessionId);
  if (!entry) return false;
  const card = entry.card;
  openWorktreeDialog(state.t, {
    sessionId,
    project: card.project?.label || state.t('project.other'),
    baseBranch: card.detail?.gitWorktree?.branch || card.detail?.branch || '',
    gitWorktree: card.detail?.gitWorktree,
    worktree: (branch) => createWorktree(sessionId, branch),
    onCreated: (result) => {
      const graph = loadGraph();
      const position = nextCanvasGraphPosition(graph);
      const base = card.detail?.gitWorktree?.branch || card.detail?.branch || state.t('worktree.currentHead');
      const next = addWorktreeForSession(graph, {
        kind: 'worktree', title: result.branch,
        body: worktreeRecordBody(state.t, card.project?.label, base, result),
        status: 'open', ...position, checkedPerson: '', missingEvidence: '', neededExplanation: '',
      }, `g_${crypto.randomUUID()}`, `e_${crypto.randomUUID()}`, sessionId);
      return next === graph ? false : graphChanged(next);
    },
  });
  return true;
}
function listWorktreesForSession(sessionId) {
  const entry = view.index.get(sessionId);
  if (!entry) return false;
  openWorktreeListDialog(state.t, {
    load: () => listWorktrees(sessionId),
    remove: state.board?.stats?.demo ? undefined : (branch) => removeWorktree(sessionId, branch),
    requireRemovableFlag: entry.card.detail?.executionLocation === 'wsl',
    onRemoved: (branch) => {
      const graph = loadGraph();
      const card = graph.nodes.find((node) => node.kind === 'worktree' && node.title === branch
        && graph.edges.some((edge) => edge.from === `graph:${node.id}` && edge.to === `session:${sessionId}`));
      if (!card) return;
      graphChanged(updateGraphNode(graph, card.id, { status: 'done', body: `${card.body}\n${state.t('worktree.removedRecord')}` }));
    },
    record: (item) => {
      const graph = loadGraph();
      const position = nextCanvasGraphPosition(graph);
      const base = entry.card.detail?.gitWorktree?.branch || entry.card.detail?.branch || state.t('worktree.currentHead');
      const branch = item.branch || state.t('worktree.listDetached');
      const next = addWorktreeForSession(graph, {
        kind: 'worktree', title: branch,
        body: worktreeRecordBody(state.t, entry.card.project?.label, base, item),
        status: 'open', ...position, checkedPerson: '', missingEvidence: '', neededExplanation: '',
      }, `g_${crypto.randomUUID()}`, `e_${crypto.randomUUID()}`, sessionId, 'Recorded from read-only worktree inventory');
      return next !== graph && graphChanged(next);
    },
  });
  return true;
}


function moveGraphBy(id, dx, dy) {
  const graph = loadGraph();
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return false;
  graphChanged(moveGraphNode(graph, id, node.x + dx, node.y + dy));
  return true;
}

/**
 * キャンバスのキーの動作 (canvas-input.mjs の canvasKeyAction の名前)。true なら preventDefault。
 * @param {string} action
 */
export function runCanvasKey(action) {
  const dir = /** @type {'left'|'right'|'up'|'down'} */ (action.split('-')[1]);
  const sign = SIGN[dir] ?? [0, 0];
  if (action.startsWith('pan-')) {
    const d = action.endsWith('-big') ? CANVAS.PAN_STEP_BIG : CANVAS.PAN_STEP;
    moveCam(panBy(cv.cam, sign[0] * d, sign[1] * d));
    apply(true);
    return true;
  }
  if (action.startsWith('move-')) {
    const from = focusedId();
    const to = from && cv.layout ? neighbour(cv.layout, from, dir, ok) : null;
    if (to) moveCanvasCursor(to);
    return true;
  }
  if (action.startsWith('nudge-')) return nudgeSheet(/** @type {HTMLElement|null} */ (document.activeElement)?.dataset?.key ?? '', dir);
  if (action.startsWith('jump-')) {
    canvasJumpPile(PILES[Number(action.slice(5)) - 1]);
    return true;
  }
  switch (action) {
    case 'next':
      return step(1);
    case 'prev':
      return step(-1);
    case 'open': {
      const id = focusedId() ?? nextUp(state.board)?.card.id;
      return id ? openSession(id) : false;
    }
    case 'peek': {
      const id = focusedId();
      if (!id) return false;
      if (cv.bar?.kind === 'detail' && cv.bar.id === id) return closeBar();
      return openBar('detail', id);
    }
    case 'handoff': {
      const id = focusedId() ?? nextUp(state.board)?.card.id;
      return id ? openBar('handoff', id) : false;
    }
    case 'sheet':
      return openSheetBar(/** @type {HTMLElement|null} */ (document.activeElement)?.dataset?.key ?? '');
    case 'zoom-in':
      return zoomTo(stepZoom(cv.cam.z, 1, size().w)), true;
    case 'zoom-out':
      return zoomTo(stepZoom(cv.cam.z, -1, size().w)), true;
    case 'zoom-reset':
      return zoomTo(1), true;
    case 'fit':
      return fitAll(), true;
    case 'fit-toggle':
      return fitToggle(), true;
    case 'view':
      return switchView('list'), true;
    case 'escape':
      return escape();
    default:
      if (action.startsWith('graph-move-')) {
        const dir = action.slice('graph-move-'.length);
        const delta = /** @type {Record<string,number[]>} */ ({ left: [-24, 0], right: [24, 0], up: [0, -24], down: [0, 24] })[dir];
        const id = /** @type {HTMLElement|null} */ (document.activeElement)?.dataset.id;
        return id && delta ? moveGraphBy(id, delta[0], delta[1]) : false;
      }
      return false;
  }
}

/** 帯とキャンバスのボタン (app.mjs のクリックから)。 @type {Record<string, (el: HTMLElement) => unknown>} */
export const CANVAS_CLICK = {
  'view-toggle': () => switchView(isCanvas() ? 'list' : 'canvas'),
  'graph-show-diagnostics': () => {
    switchView('list');
    const details = /** @type {HTMLDetailsElement|null} */ ($('foot').querySelector('.foot__diag'));
    if (details) details.open = true;
    details?.querySelector('summary')?.focus();
  },
  slip: (el) => slipClick(el.dataset.id ?? ''),
  // 用紙の帯の「最近 N」「片付け N」と、片付けだけのまとめの見出し: 一覧のその欄へ
  'canvas-back': (el) => canvasJumpPile(el.dataset.pile === 'recent' ? 'recent' : 'cleanup'),
  'canvas-fit': () => fitAll(),
  'canvas-arrange': () => rearrange(),
  'canvas-zoom-in': () => zoomTo(stepZoom(cv.cam.z, 1, size().w)),
  'canvas-zoom-out': () => zoomTo(stepZoom(cv.cam.z, -1, size().w)),
  'canvas-close': () => closeBar(),
  'handoff-close': () => closeBar(),
  'canvas-move': (el) => nudgeSheet(el.dataset.key ?? '', el.dataset.dir ?? ''),
  'canvas-sheet-fit': (el) => fitSheet(el.dataset.key ?? ''),
  'graph-new': () => newGraphNode(),
  'graph-review-gaps': () => graphActions.reviewFirstGap(),
  'graph-open': (el) => graphActions.openNode(el.dataset.id ?? ''),
  'graph-connect-node': (el) => graphActions.startConnect(el.dataset.id ?? ''),
  'graph-connect-session-handle': (el) => graphActions.connectSession(el.dataset.id ?? ''),
  'canvas-open-session': (el) => openRelatedSessionDetail(el.dataset.id ?? '', openBar),
  'canvas-open-short-session': (el) => {
    const id = resolveRelatedSessionShortId(el.dataset.source ?? '', el.dataset.id ?? '', [...view.index.keys()].map((id) => ({ id })));
    if (id) openRelatedSessionDetail(id, openBar);
  },
  'graph-connect': (el) => graphActions.connectSession(el.dataset.id ?? ''),
  'graph-edit-edge': (el) => graphActions.editEdge(el.dataset.id ?? ''),
  'delegation-run': (el) => runDelegationForEdge(el.dataset.id ?? '', el.dataset.sourceSession ?? '', { view, state, graphChanged, announce }),
  'graph-task-from-session': (el) => newTaskForSession(el.dataset.id ?? ''),
  'worktree-create': (el) => createWorktreeForSession(el.dataset.id ?? ''),
  'worktree-list': (el) => listWorktreesForSession(el.dataset.id ?? ''),
};

/** ブラウザが (フォーカスに合わせて) 表示枠をスクロールしたら、その分をカメラに移してスクロールを 0 に戻す。 */
function absorbScroll() {
  const vp = viewport();
  if (!vp.scrollLeft && !vp.scrollTop) return;
  moveCam(panBy(cv.cam, -vp.scrollLeft, -vp.scrollTop));
  vp.scrollLeft = 0;
  vp.scrollTop = 0;
  apply(true);
}

/** 起動時に 1 回: ポインタ・大きさ・スクロール・フォーカス。 */
export function initCanvas() {
  const vp = viewport();
  const sheetEl = (/** @type {string} */ key) => /** @type {HTMLElement|null} */ ([...world().children].find((el) => /** @type {HTMLElement} */ (el).dataset.key === key) ?? null);
  const snap = (/** @type {number} */ v) => Math.max(0, Math.round(v / CANVAS.SNAP) * CANVAS.SNAP);
  bindCanvas(vp, {
    pan: (/** @type {number} */ dx, /** @type {number} */ dy) => {
      moveCam(panBy(cv.cam, dx, dy));
      apply();
    },
    zoomBy: (/** @type {number} */ f, /** @type {number} */ px, /** @type {number} */ py) => {
      moveCam(zoomAt(cv.cam, cv.cam.z * f, px, py, minZoom(size().w)));
      apply();
    },
    dragSheet: (/** @type {string} */ key, /** @type {number} */ dx, /** @type {number} */ dy) => {
      const s = cv.layout?.sheets.find((x) => x.key === key);
      const el = sheetEl(key);
      if (!s || !el) return;
      // 位置は cv に持つ: ドラッグの途中で描き直しても (5 秒ごとの取得)、用紙を席へ戻さない
      cv.drag = { key, x: snap(s.x + dx / cv.cam.z), y: snap(s.y + dy / cv.cam.z) };
      el.classList.add('is-dragging');
      el.style.setProperty('--x', String(cv.drag.x));
      el.style.setProperty('--y', String(cv.drag.y));
    },
    dropSheet: (/** @type {string} */ key) => {
      sheetEl(key)?.classList.remove('is-dragging');
      const d = cv.drag;
      cv.drag = null;
      if (d && d.key === key) placeSheet(key, d.x, d.y);
      else render();
    },
    dragGraph: (/** @type {string} */ id, /** @type {number} */ dx, /** @type {number} */ dy) => {
      const node = loadGraph().nodes.find((n) => n.id === id);
      const el = /** @type {HTMLElement|null} */ (world().querySelector(`.graph-node[data-id="${CSS.escape(id)}"]`));
      if (!node || !el) return;
      cv.graphDrag = { id, x: Math.round(node.x + dx / cv.cam.z), y: Math.round(node.y + dy / cv.cam.z) };
      el.classList.add('is-dragging');
      el.style.setProperty('--x', String(cv.graphDrag.x));
      el.style.setProperty('--y', String(cv.graphDrag.y));
    },
    dropGraph: (/** @type {string} */ id, /** @type {number} */ dx, /** @type {number} */ dy) => {
      world().querySelector(`.graph-node[data-id="${CSS.escape(id)}"]`)?.classList.remove('is-dragging');
      const drag = cv.graphDrag;
      cv.graphDrag = null;
      const graph = loadGraph();
      const node = graph.nodes.find((n) => n.id === id);
      if (drag?.id === id && node) graphChanged(moveGraphNode(graph, id, node.x + dx / cv.cam.z, node.y + dy / cv.cam.z));
    },
    connectGraph: (/** @type {'graph'|'session'} */ sourceKind, /** @type {string} */ sourceId, /** @type {'graph'|'session'} */ targetKind, /** @type {string} */ targetId) => graphActions.connectCanvasEndpoints(sourceKind, sourceId, targetKind, targetId),
    graphConnectHover: (/** @type {'graph'|'session'} */ sourceKind, /** @type {string} */ sourceId, /** @type {'graph'|'session'|null} */ targetKind, /** @type {string|null} */ targetId) => {
      world().querySelector('.graph-connect-handle.is-connect-source')?.classList.remove('is-connect-source');
      world().querySelector('.canvas-connect-handle.is-connect-source')?.classList.remove('is-connect-source');
      world().querySelector('.graph-node.is-connect-target')?.classList.remove('is-connect-target');
      world().querySelector('.slip.is-connect-target')?.classList.remove('is-connect-target');
      world().querySelector(`.${sourceKind === 'session' ? 'canvas-connect-handle' : 'graph-connect-handle'}[data-id="${CSS.escape(sourceId)}"]`)?.classList.add('is-connect-source');
      if (targetId) world().querySelector(`.${targetKind === 'session' ? 'slip' : 'graph-node'}[data-id="${CSS.escape(targetId)}"]`)?.classList.add('is-connect-target');
    },
    openGraph: (/** @type {string} */ id) => graphActions.openNode(id),
    // 動かさずに押した柱: フォーカスを置き、帯に「用紙を動かす」のボタンを出す (ドラッグのできない人の道、WCAG 2.5.7)
    focusHead: (/** @type {HTMLElement} */ head) => {
      head.focus({ preventScroll: true });
      openSheetBar(head.dataset.key ?? '', false);
    },
  });
  vp.addEventListener('scroll', absorbScroll);
  // Tab で付箋に来たら、そこをカーソルにして見えるように動かす。柱と片付けの帯の見出し、片付けだけのまとめの見出しも見えるように動かす。
  // 描き直しのあとにプログラムが戻したフォーカス (cv.quiet) では何もしない: 取得はカメラを動かさない
  vp.addEventListener('focusin', (ev) => {
    absorbScroll();
    if (cv.quiet || !(ev.target instanceof Element)) return;
    if (ev.target.matches('.sheet__head, .sheet__backhead, .fold__head')) return revealEl(ev.target);
    const li = ev.target.closest('.slip[data-id]');
    const id = /** @type {HTMLElement|null} */ (li)?.dataset.id;
    if (!id || !ev.target.matches('.slip__title')) return;
    if (state.cursor?.id !== id) {
      setCanvasCursor(id);
      for (const el of /** @type {HTMLElement[]} */ ([...world().querySelectorAll('.slip.is-cursor')])) el.classList.remove('is-cursor');
      li?.classList.add('is-cursor');
    }
    reveal(id);
  });
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (!isCanvas() || !resized(size())) return;
      // 幅が NARROW_PX を越えた: その幅の席で並べ直して描く (drawCanvas が席を読み直し、開いたときのカメラにする)
      if (cv.narrow !== size().w < CANVAS.NARROW_PX) render();
      else apply(true);
    }).observe(vp);
  }
}
