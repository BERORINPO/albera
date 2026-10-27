import { canvasSig, slipEl, slipFlags } from './canvas-slip.mjs';
import { h } from './view.mjs';
import { sessionRect } from './session-position.mjs';

/** Render user-positioned read-only sessions above the project sheets. Provider data stays in its existing view model. */
export function renderPositionedSessions(root, o) {
  const ids = [...o.index.keys()].filter((id) => Object.hasOwn(o.positions ?? {}, id) || o.drag?.id === id);
  const cards = ids.map((id) => {
    const entry = o.index.get(id);
    const source = o.layout.sheets.flatMap((sheet) => sheet.slips).find((slip) => slip.id === id);
    const rect = sessionRect(o.layout, id, o.positions, o.drag);
    return entry && source && rect ? { id, entry, source, rect } : null;
  }).filter(Boolean);
  const ol = root.querySelector('.graph-layer__sessions') ?? h('ol', { class: 'graph-layer__sessions', 'aria-label': o.t('canvas.positionedSessions') });
  ol.setAttribute('aria-label', o.t('canvas.positionedSessions'));
  root.append(ol);
  const byId = new Map(cards.map((item) => [item.id, item]));
  const itemOptions = { nextId: o.nextId, now: o.now, handoff: o.handoff, demo: o.demo, isNew: o.isNew, takeArrival: o.takeArrival };
  for (const card of cards) {
    let el = ol.querySelector(`.session-positioned[data-id="${CSS.escape(card.id)}"]`);
    const sig = canvasSig(o.t.lang, card.entry.card, slipFlags(card.entry.card, card.source, itemOptions));
    const focused = !!el?.contains(document.activeElement);
    if (!el || el.dataset.sig !== sig) {
      el = slipEl(o.t, card.entry.card, { ...card.source, pile: card.entry.pile }, itemOptions);
      el.classList.add('session-positioned');
      el.setAttribute('data-session-positioned', 'true');
      el.dataset.sig = sig;
      el.append(
        h('button', { class: 'canvas-session-reset', type: 'button', 'data-action': 'session-reset', 'data-id': card.id, 'aria-label': o.t('canvas.resetSessionPosition', { title: card.entry.card.title }), text: '↩' }),
      );
      const prior = ol.querySelector(`.session-positioned[data-id="${CSS.escape(card.id)}"]`);
      if (prior) prior.replaceWith(el);
      else ol.append(el);
      if (focused) el.querySelector('.canvas-session-move')?.focus({ preventScroll: true });
    }
    el.classList.toggle('is-dim', !o.matched?.has(card.id) && !!o.matched);
    el.style.setProperty('--x', String(card.rect.x));
    el.style.setProperty('--y', String(card.rect.y));
    el.style.setProperty('--w', String(card.rect.w));
    el.style.setProperty('--h', String(card.rect.h));
    const title = el.querySelector('.slip__title');
    if (title) title.tabIndex = 0;
    const move = el.querySelector('.canvas-session-move');
    if (move) move.setAttribute('aria-label', o.t('canvas.moveSession', { title: card.entry.card.title }));
    const reset = el.querySelector('.canvas-session-reset');
    if (reset) reset.setAttribute('aria-label', o.t('canvas.resetSessionPosition', { title: card.entry.card.title }));
  }
  for (const el of [...ol.querySelectorAll('.session-positioned[data-id]')]) if (!byId.has(el.dataset.id ?? '')) el.remove();
}
