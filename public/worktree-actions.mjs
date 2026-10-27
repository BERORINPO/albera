// Shared worktree controls for list and canvas session detail.
import { worktreeCreationAvailability } from './worktree-availability.mjs';
import { h } from './view.mjs';

/** @param {(key:string)=>string} t @param {any} card @param {boolean} demo */
export function worktreeDetailActions(t, card, demo) {
  const availability = worktreeCreationAvailability(card.detail?.executionLocation, demo);
  return [
    availability.notice ? h('span', { class: 'detail__note', role: 'note', text: t(availability.notice === 'demo' ? 'worktree.demoUnavailable' : 'worktree.wslUnavailable') }) : null,
    availability.enabled ? h('button', { class: 'textbtn', type: 'button', 'data-action': 'worktree-create', 'data-id': card.id, text: t('worktree.openCreate') }) : null,
    h('button', { class: 'textbtn', type: 'button', 'data-action': 'worktree-list', 'data-id': card.id, text: t('worktree.listButton') }),
  ];
}
