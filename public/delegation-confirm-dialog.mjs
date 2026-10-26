// In-app, explicit confirmation for the only action that can resume a Codex CLI session.
import { h } from './view.mjs';

/** @param {(key:string, params?:Record<string,unknown>)=>string} t @param {{target:string,purpose:string,transfer:string,network:string,output:string,session:string}} copy @param {()=>void} onConfirm */
export function openDelegationConfirmDialog(t, copy, onConfirm) {
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const descriptionIds = ['target', 'purpose', 'transfer', 'network', 'output', 'session'].map((part) => `delegation-confirm-${part}`).join(' ');
  const dialog = h('dialog', { class: 'graph-dialog', 'aria-labelledby': 'delegation-confirm-title', 'aria-describedby': descriptionIds });
  const form = h('form', { class: 'graph-dialog__form' });
  const cancel = h('button', { class: 'textbtn', type: 'button', 'data-delegation-cancel': '', text: t('canvas.close') });
  form.append(
    h('h2', { id: 'delegation-confirm-title', text: t('graph.delegationConfirmTitle') }),
    h('p', { id: 'delegation-confirm-target', class: 'graph-dialog__privacy', text: copy.target }),
    h('section', { class: 'graph-dialog__profile' },
      h('h3', { text: t('graph.delegationConfirmPurpose') }),
      h('p', { id: 'delegation-confirm-purpose', class: 'graph-dialog__fixed', text: copy.purpose }),
    ),
    h('p', { id: 'delegation-confirm-transfer', class: 'graph-dialog__privacy', text: copy.transfer }),
    h('p', { id: 'delegation-confirm-network', class: 'graph-dialog__privacy', text: copy.network }),
    h('p', { id: 'delegation-confirm-output', class: 'graph-dialog__privacy', text: copy.output }),
    h('p', { id: 'delegation-confirm-session', class: 'graph-dialog__privacy', text: copy.session }),
    h('div', { class: 'graph-dialog__actions' },
      cancel,
      h('button', { class: 'btn btn--line', type: 'submit', text: t('graph.delegationConfirmRun') }),
    ),
  );
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }, { once: true });
  cancel.addEventListener('click', () => dialog.close());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    dialog.close();
    onConfirm();
  });
  dialog.showModal();
  cancel.focus();
  return dialog;
}
