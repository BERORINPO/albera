// Explicit confirmation for removing one local worktree directory. The branch is kept.

import { WorktreeOperationError } from './api.mjs';
import { h } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */

/** @param {T} t @param {{branch:string,remove:(branch:string)=>Promise<any>,onRemoved:()=>void}} options */
export function openWorktreeRemoveDialog(t, options) {
  const dialog = h('dialog', { class: 'graph-dialog', 'aria-labelledby': 'worktree-remove-title' });
  const form = h('form', { class: 'graph-dialog__form' });
  const message = h('p', { class: 'graph-dialog__review', role: 'status', 'aria-live': 'polite' });
  const input = h('input', { name: 'branch', value: '', maxlength: '80', autocomplete: 'off', spellcheck: false, required: true });
  const confirm = h('button', { class: 'btn btn--line graph-dialog__delete', type: 'submit', disabled: true, text: t('worktree.removeConfirm') });
  const acknowledge = h('input', { type: 'checkbox', name: 'acknowledge' });
  const close = h('button', { class: 'textbtn', type: 'button', 'data-dialog-action': 'close', text: t('canvas.close') });
  form.append(
    h('h2', { id: 'worktree-remove-title', text: t('worktree.removeTitle') }),
    h('p', { class: 'graph-dialog__privacy', text: t('worktree.removeImpact') }),
    h('p', { class: 'graph-dialog__fixed', text: options.branch }),
    h('label', { class: 'graph-dialog__field' }, h('span', { text: t('worktree.removeTypeBranch') }), input),
    h('label', { class: 'graph-dialog__field' }, acknowledge, h('span', { text: t('worktree.removeAcknowledge') })),
    message,
    h('div', { class: 'graph-dialog__actions' }, close, confirm),
  );
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  form.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('[data-dialog-action="close"]')) dialog.close();
  });
  const update = () => { confirm.disabled = input.value !== options.branch || !acknowledge.checked; };
  input.addEventListener('input', update);
  acknowledge.addEventListener('change', update);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (input.value !== options.branch || !acknowledge.checked) return update();
    confirm.disabled = true;
    close.disabled = true;
    message.textContent = t('worktree.removing');
    try {
      await options.remove(options.branch);
      options.onRemoved();
      message.textContent = t('worktree.removed', { branch: options.branch });
      dialog.close();
    } catch (error) {
      const reason = error instanceof WorktreeOperationError ? error.reason : 'failed';
      const key = ['not_clean', 'current', 'locked', 'prunable', 'not_found', 'demo_disabled'].includes(reason) ? `worktree.removeError.${reason}` : 'worktree.removeError.failed';
      message.textContent = t(key);
      close.disabled = false;
      update();
    }
  });
  dialog.showModal();
  input.focus();
}
