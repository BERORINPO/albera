// Accessible, nested confirmation dialog for destructive/local graph actions.
import { h } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */

/** @param {{t:T,title:string,description:string,confirmLabel:string,parent:HTMLDialogElement,returnFocus:HTMLElement|null,onConfirm:()=>boolean}} o */
export function openGraphConfirmDialog(o) {
  const dialog = h('dialog', { class: 'graph-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'graph-confirm-title', 'aria-describedby': 'graph-confirm-description' });
  const form = h('form', { class: 'graph-dialog__form' });
  form.append(
    h('h2', { id: 'graph-confirm-title', text: o.t(o.title) }),
    h('p', { id: 'graph-confirm-description', class: 'graph-dialog__privacy', text: o.description }),
    h('div', { class: 'graph-dialog__actions' },
      h('button', { class: 'textbtn', type: 'button', 'data-confirm-action': 'cancel', text: o.t('graph.removeRelationCancel') }),
      h('button', { class: 'btn btn--line graph-dialog__delete', type: 'button', 'data-confirm-action': 'confirm', text: o.t(o.confirmLabel) }),
    ),
  );
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (o.parent.open && o.returnFocus?.isConnected) o.returnFocus.focus({ preventScroll: true });
  }, { once: true });
  form.addEventListener('click', (ev) => {
    const action = ev.target instanceof Element ? ev.target.closest('[data-confirm-action]')?.getAttribute('data-confirm-action') : null;
    if (action === 'cancel') dialog.close();
    if (action === 'confirm' && o.onConfirm()) {
      dialog.addEventListener('close', () => o.parent.close(), { once: true });
      dialog.close();
    }
  });
  dialog.showModal();
  /** @type {HTMLButtonElement|null} */ (form.querySelector('[data-confirm-action="confirm"]'))?.focus();
  return true;
}
