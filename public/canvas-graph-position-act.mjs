import { CANVAS } from '../src/shared/constants.mjs';
import { graphPlacementObstacles, nextGraphNodePosition } from './graph-model.mjs';
import { GRAPH_CARD_SIZE } from './graph-render.mjs';

/** Session choices use only a provider label and opaque short ID. */
export function graphSessionChoices(index) {
  return [...index.keys()].map((id) => ({ id, title: `${id.startsWith('codex_') ? 'Codex' : id.startsWith('copilot_') ? 'GitHub Copilot' : id.startsWith('opencode_') ? 'OpenCode' : 'Claude'} session #${id.slice(-8)}` }));
}

/** Place a graph card outside project sheets and the archive fold. */
export function nextCanvasGraphPosition(cv, size, graph) {
  const viewport = size();
  return nextGraphNodePosition(graph, {
    x: cv.cam.x + viewport.w / (2 * cv.cam.z) - GRAPH_CARD_SIZE.width / 2,
    y: cv.cam.y + viewport.h / (2 * cv.cam.z) - GRAPH_CARD_SIZE.height / 2,
  }, graphPlacementObstacles(cv.layout));
}

export function nudgeCanvasSheet({ cv, key, dir, placeSheet, headOf, revealEl }) {
  const sheet = cv.layout?.sheets.find((item) => item.key === key);
  const sign = /** @type {Record<string, number[]>} */ ({ left: [1, 0], right: [-1, 0], up: [0, 1], down: [0, -1] })[dir];
  if (!sheet || !sign) return false;
  placeSheet(sheet.key, sheet.x - sign[0] * CANVAS.NUDGE, sheet.y - sign[1] * CANVAS.NUDGE);
  revealEl(headOf(sheet.key));
  return true;
}
