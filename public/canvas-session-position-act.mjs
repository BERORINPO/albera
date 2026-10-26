import { sessionRect } from './session-position.mjs';
import { forgetSessionPosition, loadSessionPositions, saveSessionPositions } from './session-position-store.mjs';

/** DOM/storage side effects for moving the read-only session cards on the local canvas. */
export function createSessionPositionActions(o) {
  const positions = () => o.cv.sessionPositions ?? (o.cv.sessionPositions = loadSessionPositions());

  function moveBy(id, dx, dy) {
    const current = positions();
    const rect = sessionRect(o.cv.layout, id, current);
    if (!rect) return false;
    const next = { ...current, [id]: { x: Math.round(rect.x + dx), y: Math.round(rect.y + dy) } };
    if (!saveSessionPositions(next)) return o.announce(o.getT()('canvas.positionSaveError')), false;
    o.cv.sessionPositions = next;
    o.render();
    o.world().querySelector(`.session-positioned[data-id="${CSS.escape(id)}"] .canvas-session-move`)?.focus({ preventScroll: true });
    o.announce(o.getT()('canvas.sessionMoved'));
    return true;
  }

  function reset(id) {
    const current = positions();
    if (!forgetSessionPosition(current, id)) return o.announce(o.getT()('canvas.positionSaveError')), false;
    o.cv.sessionPositions = current;
    o.render();
    o.focusSlip(id);
    o.announce(o.getT()('canvas.sessionPositionReset'));
    return true;
  }

  function drag(id, dx, dy) {
    const current = positions();
    const origin = o.cv.sessionDrag?.id === id ? { x: o.cv.sessionDrag.startX, y: o.cv.sessionDrag.startY } : sessionRect(o.cv.layout, id, current);
    if (!origin) return;
    o.cv.sessionDrag = { id, x: Math.round(origin.x + dx / o.cv.cam.z), y: Math.round(origin.y + dy / o.cv.cam.z), startX: origin.x, startY: origin.y };
    if (!o.world().querySelector(`.session-positioned[data-id="${CSS.escape(id)}"]`)) o.render();
    const el = /** @type {HTMLElement|null} */ (o.world().querySelector(`.session-positioned[data-id="${CSS.escape(id)}"]`));
    el?.classList.add('is-dragging');
    el?.style.setProperty('--x', String(o.cv.sessionDrag.x));
    el?.style.setProperty('--y', String(o.cv.sessionDrag.y));
  }

  function drop(id) {
    const drag = o.cv.sessionDrag;
    if (!drag || drag.id !== id) return o.render();
    const next = { ...positions(), [id]: { x: drag.x, y: drag.y } };
    o.cv.sessionDrag = null;
    if (!saveSessionPositions(next)) {
      o.render();
      return o.announce(o.getT()('canvas.positionSaveError'));
    }
    o.cv.sessionPositions = next;
    o.render();
    o.announce(o.getT()('canvas.sessionMoved'));
  }

  return { moveBy, reset, drag, drop, open: o.openSession };
}
