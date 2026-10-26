// Read-only Git worktree inventory. The server returns allowlisted metadata only.

import { WorktreeOperationError } from './api.mjs';
import { h } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */

/** @param {T} t @param {{load:()=>Promise<Array<any>>}} options */
export function openWorktreeListDialog(t, options) {
  const dialog = h('dialog', { class: 'graph-dialog', 'aria-labelledby': 'worktree-list-title' });
  const form = h('form', { class: 'graph-dialog__form' });
  const message = h('p', { class: 'graph-dialog__review', role: 'status', 'aria-live': 'polite', text: t('worktree.listLoading') });
  const list = h('ul', { class: 'graph-dialog__relations', 'aria-label': t('worktree.listTitle') });
  const refresh = h('button', { class: 'textbtn', type: 'button', 'data-dialog-action': 'refresh', text: t('worktree.listButton') });
  const close = h('button', { class: 'textbtn', type: 'button', 'data-dialog-action': 'close', text: t('canvas.close') });
  form.append(h('h2', { id: 'worktree-list-title', text: t('worktree.listTitle') }), message, list,
    h('div', { class: 'graph-dialog__actions' }, refresh, close));
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  form.addEventListener('click', (event) => {
    const action = event.target instanceof Element ? event.target.closest('[data-dialog-action]')?.getAttribute('data-dialog-action') : null;
    if (action === 'close') dialog.close();
    if (action === 'refresh') void load();
  });
  dialog.showModal();
  void load();

  async function load() {
    refresh.disabled = true;
    message.textContent = t('worktree.listLoading');
    list.replaceChildren();
    try {
      const items = await options.load();
      if (!items.length) message.textContent = t('worktree.listNone');
      else {
        message.textContent = '';
        for (const item of items) {
          const branch = item.branch || t('worktree.listDetached');
          const state = t(`worktree.status.${item.status}`);
          const counts = `${item.changed} / ${item.untracked} / ${item.conflicted}`;
          const flags = [item.locked && t('worktree.flagLocked'), item.prunable && t('worktree.flagPrunable')].filter(Boolean).join(', ');
          list.append(h('li', {}, h('strong', { text: `${branch}${item.current ? ` — ${t('worktree.listCurrent')}` : ''}` }),
            h('span', { text: t('worktree.listSummary', { state, counts, flags: flags ? ` (${flags})` : '' }) })));
        }
      }
    } catch (error) {
      message.textContent = error instanceof WorktreeOperationError && error.reason === 'session_unavailable'
        ? t('worktree.listSessionUnavailable')
        : t('worktree.listFailed');
    } finally {
      refresh.disabled = false;
    }
  }
}
