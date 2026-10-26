// Explicit confirmation boundary for creating a local worktree. No CLI session is launched.

import { WorktreeOperationError } from './api.mjs';
import { worktreeDetailText } from './worktree-detail.mjs';
import { h } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */

/** @param {T} t @param {{sessionId:string,project:string,baseBranch:string,gitWorktree?:any,worktree:(branch:string)=>Promise<any>}} o */
export function openWorktreeDialog(t, o) {
  const dialog = h('dialog', { class: 'graph-dialog', 'aria-labelledby': 'worktree-dialog-title' });
  const form = h('form', { class: 'graph-dialog__form' });
  const branch = h('input', { name: 'branch', required: true, maxlength: '80', pattern: '[A-Za-z0-9][A-Za-z0-9._/-]{0,79}', autocomplete: 'off' });
  const confirmRun = h('input', { name: 'acknowledge', type: 'checkbox', required: true });
  const submit = h('button', { class: 'btn btn--line', type: 'submit', text: t('worktree.create') });
  const message = h('p', { class: 'graph-dialog__review', role: 'status', 'aria-live': 'polite' });
  const current = worktreeDetailText(t, o.gitWorktree);
  form.append(
    h('h2', { id: 'worktree-dialog-title', text: t('worktree.title') }),
    h('p', { class: 'graph-dialog__privacy', text: t('worktree.target', { project: o.project, branch: o.baseBranch || t('worktree.currentHead') }) }),
    h('p', { class: 'graph-dialog__privacy', text: t('worktree.baseState', { state: current.status || t('detail.gitState.unknown'), flags: current.flags ? ` (${current.flags})` : '' }) }),
    h('p', { class: 'graph-dialog__privacy', text: t('worktree.impact') }),
    h('label', { class: 'graph-dialog__field' }, h('span', { text: t('worktree.branch') }), branch),
    h('label', { class: 'graph-dialog__ack' }, confirmRun, h('span', { text: t('worktree.acknowledge') })),
    message,
    h('div', { class: 'graph-dialog__actions' },
      h('button', { class: 'textbtn', type: 'button', 'data-dialog-action': 'cancel', text: t('canvas.close') }),
      submit,
    ),
  );
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  form.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('[data-dialog-action="cancel"]')) dialog.close();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    submit.disabled = true;
    branch.disabled = true;
    confirmRun.disabled = true;
    message.textContent = t('worktree.creating');
    try {
      const result = await o.worktree(branch.value.trim());
      message.textContent = t('worktree.created', { branch: result.branch, status: t(`worktree.status.${result.status}`) });
      submit.hidden = true;
    } catch (error) {
      message.textContent = error instanceof WorktreeOperationError
        ? t(`worktree.error.${error.reason}`)
        : t('worktree.error.failed');
      submit.disabled = false;
      branch.disabled = false;
      confirmRun.disabled = false;
    }
  });
  dialog.showModal();
  branch.focus();
}
