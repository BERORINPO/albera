import { sessionRect } from './session-position.mjs';
import { boundedSessionPoint, forgetSessionPosition, loadSessionPositions, saveSessionPositions } from './session-position-store.mjs';

/** DOM/storage side effects for moving the read-only session cards on the local canvas. */
export function createSessionPositionActions(o) {
  const positions = () => o.cv.sessionPositions ?? (o.cv.sessionPositions = loadSessionPositions());

  function moveBy(id, dx, dy) {
    const current = positions();
    const rect = sessionRect(o.cv.layout, id, current);
    if (!rect) return false;
    const next = { ...current, [id]: boundedSessionPoint(rect.x + dx, rect.y + dy) };
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
    const point = boundedSessionPoint(origin.x + dx / o.cv.cam.z, origin.y + dy / o.cv.cam.z);
    o.cv.sessionDrag = { id, ...point, startX: origin.x, startY: origin.y };
    if (!o.world().querySelector(`.session-positioned[data-id="${CSS.escape(id)}"]`)) o.render();
    const el = /** @type {HTMLElement|null} */ (o.world().querySelector(`.session-positioned[data-id="${CSS.escape(id)}"]`));
    el?.classList.add('is-dragging');
    el?.style.setProperty('--x', String(o.cv.sessionDrag.x));
    el?.style.setProperty('--y', String(o.cv.sessionDrag.y));
  }

  function drop(id) {
    const drag = o.cv.sessionDrag;
    if (!drag || drag.id !== id) return o.render();
    const next = { ...positions(), [id]: boundedSessionPoint(drag.x, drag.y) };
    o.cv.sessionDrag = null;
    if (!saveSessionPositions(next)) {
      o.render();
      return o.announce(o.getT()('canvas.positionSaveError'));
    }
    o.cv.sessionPositions = next;
    o.render();
    o.announce(o.getT()('canvas.sessionMoved'));
  }

  function cancel(id) {
    if (o.cv.sessionDrag?.id !== id) return;
    o.cv.sessionDrag = null;
    o.render();
  }

  return { moveBy, reset, drag, drop, cancel, open: o.openSession };
}
