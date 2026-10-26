// @ts-check
// Accessible local editor for graph cards and user-authored relations.

import { APPROVAL_MODES, DELEGATION_STATES, EXECUTION_LOCATIONS, GRAPH_EDGE_KINDS, GRAPH_NODE_KINDS, GRAPH_NODE_STATES, NETWORK_ACCESS, WORKSPACE_ISOLATIONS, reviewUnderstandingGaps, safeArtifactUrl } from './graph-model.mjs';
import { h } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */

/** @param {T} t @param {string} label @param {string} name @param {string} value @param {boolean} [required] */
function inputField(t, label, name, value = '', required = false) {
  const input = h('input', { name, value, maxlength: name === 'title' ? '100' : '240', required });
  return h('label', { class: 'graph-dialog__field' }, h('span', { text: t(label) }), input);
}

/** @param {T} t @param {string} label @param {string} name @param {string[]} values @param {string} selected @param {(v:string)=>string} text */
function selectField(t, label, name, values, selected, text) {
  return h('label', { class: 'graph-dialog__field' }, h('span', { text: t(label) }), h('select', { name }, ...values.map((v) => h('option', { value: v, selected: v === selected, text: text(v) }))));
}

/** @param {T} t @param {string} label @param {string} name @param {string} value */
function areaField(t, label, name, value = '') {
  return h('label', { class: 'graph-dialog__field' }, h('span', { text: t(label) }), h('textarea', { name, maxlength: name === 'body' ? '1000' : '500', rows: name === 'body' ? '4' : '2', text: value }));
}

/** @param {T} t @param {string} value */
function referenceField(t, value) {
  return h('label', { class: 'graph-dialog__field', 'data-artifact-reference': '' },
    h('span', { text: t('graph.referenceUrl') }),
    h('input', { name: 'referenceUrl', type: 'url', maxlength: '500', autocomplete: 'off', placeholder: 'https://…', value }),
    h('span', { class: 'graph-dialog__hint', text: t('graph.referencePrivacy') }));
}

/** @param {T} t @param {string} label @param {string} value */
function fixedField(t, label, value) {
  return h('div', { class: 'graph-dialog__field' }, h('span', { text: t(label) }), h('p', { class: 'graph-dialog__fixed', text: value }));
}

/** @param {string} endpoint @param {any} graph @param {Array<{id:string,title:string}>} sessions @param {T} t */
function endpointLabel(endpoint, graph, sessions, t) {
  if (endpoint.startsWith('graph:')) {
    const node = graph.nodes.find((n) => n.id === endpoint.slice(6));
    return node ? node.title : t('graph.missingNode');
  }
  const session = sessions.find((s) => s.id === endpoint.slice(8));
  return session?.title ?? t('graph.missingSession');
}

/** @param {T} t @param {Array<{id:string,title:string}>} options @param {string} name @param {string} selected @param {string} excluded */
function endpointSelect(t, options, name, selected, excluded = '') {
  return h('label', { class: 'graph-dialog__field' }, h('span', { text: t(name === 'from' ? 'graph.from' : 'graph.to') }), h('select', { name }, ...options.filter((x) => x.id !== excluded).map((x) => h('option', { value: x.id, selected: x.id === selected, text: x.title }))));
}

/** @param {string} key */
const endpointKey = (key) => key.startsWith('graph:') || key.startsWith('session:') ? key : '';

/**
 * @param {{t:T,node?:any,position?:{x:number,y:number},initialKind?:string,initialTitle?:string,graph:any,sessions:Array<{id:string,title:string}>,onSave:(v:any)=>void,onDelete?:(id:string)=>void,onConnect?:(from:string)=>void,onEditEdge?:(edge:any)=>void}} o
 */
export function openGraphNodeDialog(o) {
  const { t, node, graph, sessions } = o;
  const dialog = h('dialog', { class: 'graph-dialog', 'aria-labelledby': 'graph-dialog-title' });
  const form = h('form', { class: 'graph-dialog__form' });
  const title = node ? t('graph.editTitle') : t('graph.newTitle');
  form.append(h('h2', { id: 'graph-dialog-title', text: title }), h('p', { class: 'graph-dialog__privacy', text: t('graph.localOnly') }));
  if (node?.kind === 'understanding_gap') {
    const review = reviewUnderstandingGaps(graph).find((item) => item.id === node.id);
    if (review?.missing.length) form.append(h('p', { class: 'graph-dialog__review', text: t('graph.reviewHint', { links: review.missing.map((kind) => t(`graph.link.${kind}`)).join(', ') }) }));
  }
  form.append(
    selectField(t, 'graph.kindLabel', 'kind', [...GRAPH_NODE_KINDS], node?.kind ?? o.initialKind ?? 'task', (v) => t(`graph.kind.${v}`)),
    inputField(t, 'graph.titleLabel', 'title', node?.title ?? o.initialTitle ?? '', true),
    areaField(t, 'graph.bodyLabel', 'body', node?.body ?? ''),
    referenceField(t, node?.url ?? ''),
    selectField(t, 'graph.statusLabel', 'status', [...GRAPH_NODE_STATES], node?.status ?? 'open', (v) => t(`graph.status.${v}`)),
    h('fieldset', { class: 'graph-dialog__profile', 'data-comprehension-fields': '' },
      h('legend', { text: t('graph.comprehensionFields') }),
      inputField(t, 'graph.checkedPerson', 'checkedPerson', node?.checkedPerson ?? ''),
      areaField(t, 'graph.missingEvidenceLabel', 'missingEvidence', node?.missingEvidence ?? ''),
      areaField(t, 'graph.neededExplanationLabel', 'neededExplanation', node?.neededExplanation ?? ''),
    ),
    h('fieldset', { class: 'graph-dialog__profile', 'data-execution-profile': '' },
      h('legend', { text: t('graph.executionProfile') }),
      h('p', { class: 'graph-dialog__hint', text: t('graph.executionProfileManual') }),
      selectField(t, 'graph.executionLocation', 'executionLocation', [...EXECUTION_LOCATIONS], node?.executionLocation ?? 'unknown', (v) => t(`graph.executionLocation.${v}`)),
      selectField(t, 'graph.workspaceIsolation', 'workspaceIsolation', [...WORKSPACE_ISOLATIONS], node?.workspaceIsolation ?? 'unknown', (v) => t(`graph.workspaceIsolation.${v}`)),
      selectField(t, 'graph.networkAccess', 'networkAccess', [...NETWORK_ACCESS], node?.networkAccess ?? 'unknown', (v) => t(`graph.networkAccess.${v}`)),
      selectField(t, 'graph.approvalMode', 'approvalMode', [...APPROVAL_MODES], node?.approvalMode ?? 'unknown', (v) => t(`graph.approvalMode.${v}`)),
    ),
  );
  const kindSelect = /** @type {HTMLSelectElement|null} */ (form.querySelector('[name="kind"]'));
  const refField = /** @type {HTMLElement|null} */ (form.querySelector('[data-artifact-reference]'));
  const refInput = /** @type {HTMLInputElement|null} */ (form.querySelector('[name="referenceUrl"]'));
  const profileFields = /** @type {HTMLElement|null} */ (form.querySelector('[data-execution-profile]'));
  const comprehensionFields = /** @type {HTMLElement|null} */ (form.querySelector('[data-comprehension-fields]'));
  const syncReferenceField = () => { if (refField) refField.hidden = kindSelect?.value !== 'artifact'; };
  const syncProfileFields = () => { if (profileFields) profileFields.hidden = kindSelect?.value !== 'execution_profile'; };
  const syncComprehensionFields = () => { if (comprehensionFields) comprehensionFields.hidden = kindSelect?.value !== 'understanding_gap'; };
  kindSelect?.addEventListener('change', syncReferenceField);
  kindSelect?.addEventListener('change', syncProfileFields);
  kindSelect?.addEventListener('change', syncComprehensionFields);
  refInput?.addEventListener('input', () => refInput.setCustomValidity(''));
  syncReferenceField();
  syncProfileFields();
  syncComprehensionFields();
  if (node?.url) form.append(h('a', { class: 'graph-dialog__reference-link', href: node.url, target: '_blank', rel: 'noopener noreferrer', text: t('graph.openReference') }));
  if (node) {
    const linked = graph.edges.filter((e) => e.from === `graph:${node.id}` || e.to === `graph:${node.id}`);
    form.append(h('h3', { class: 'graph-dialog__subhead', text: t('graph.relations') }));
    form.append(linked.length
      ? h('ul', { class: 'graph-dialog__relations' }, ...linked.map((e) => {
        const other = e.from === `graph:${node.id}` ? e.to : e.from;
        const direction = e.from === `graph:${node.id}` ? t('graph.relationOut') : t('graph.relationIn');
        return h('li', {},
          h('span', { text: `${direction}: ${endpointLabel(other, graph, sessions, t)} — ${t(`graph.edge.${e.kind}`)}${e.purpose ? `: ${e.purpose}` : ''}${e.kind === 'delegates' ? ` (${t(`graph.delegation.${e.status}`)})` : ''}` }),
          o.onEditEdge ? h('button', { class: 'textbtn', type: 'button', 'data-dialog-action': 'edit-edge', 'data-edge-id': e.id, text: t('graph.editRelation') }) : null,
        );
      }))
      : h('p', { class: 'graph-dialog__empty', text: t('graph.noRelations') }));
  }
  const acts = h('div', { class: 'graph-dialog__actions' });
  if (node && o.onConnect) acts.append(h('button', { class: 'textbtn', type: 'button', 'data-dialog-action': 'connect', text: t('graph.connect') }));
  if (node && o.onDelete) acts.append(h('button', { class: 'textbtn graph-dialog__delete', type: 'button', 'data-dialog-action': 'delete', text: t('graph.delete') }));
  acts.append(h('button', { class: 'textbtn', type: 'button', 'data-dialog-action': 'cancel', text: t('canvas.close') }), h('button', { class: 'btn btn--line', type: 'submit', text: t('graph.save') }));
  form.append(acts);
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  form.addEventListener('click', (ev) => {
    const button = ev.target instanceof Element ? ev.target.closest('[data-dialog-action]') : null;
    const action = button?.getAttribute('data-dialog-action');
    if (!action || !node) return;
    if (action === 'cancel') dialog.close();
    if (action === 'connect' && o.onConnect) {
      dialog.close();
      o.onConnect(`graph:${node.id}`);
    }
    if (action === 'edit-edge' && o.onEditEdge) {
      const edge = graph.edges.find((item) => item.id === button?.getAttribute('data-edge-id'));
      if (edge) {
        dialog.close();
        o.onEditEdge(edge);
      }
    }
    const deleteMessage = node.kind === 'worktree' ? 'graph.worktreeDeleteConfirm' : 'graph.deleteConfirm';
    if (action === 'delete' && o.onDelete && window.confirm(t(deleteMessage, { title: node.title }))) {
      o.onDelete(node.id);
      dialog.close();
    }
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const referenceUrl = safeArtifactUrl(data.referenceUrl, String(data.kind));
    if (String(data.kind) === 'artifact' && String(data.referenceUrl ?? '').trim() && !referenceUrl) {
      refInput?.setCustomValidity(t('graph.referenceInvalid'));
      refInput?.reportValidity();
      return;
    }
    o.onSave({
      ...(node ? { id: node.id } : {}),
      ...(o.position ?? {}),
      kind: data.kind,
      title: data.title,
      body: data.body,
      url: referenceUrl,
      status: data.status,
      checkedPerson: data.checkedPerson,
      missingEvidence: data.missingEvidence,
      neededExplanation: data.neededExplanation,
      executionLocation: data.executionLocation,
      workspaceIsolation: data.workspaceIsolation,
      networkAccess: data.networkAccess,
      approvalMode: data.approvalMode,
    });
    dialog.close();
  });
  dialog.showModal();
  /** @type {HTMLInputElement|null} */ (form.querySelector('[name="title"]'))?.focus();
}

/**
 * @param {{t:T,from:string,edge?:any,graph:any,sessions:Array<{id:string,title:string}>,onConnect:(v:any)=>void,onDeleteEdge?:(id:string)=>void}} o
 */
export function openGraphRelationDialog(o) {
  const { t, from, graph, sessions, edge } = o;
  const options = [
    ...graph.nodes.map((n) => ({ id: `graph:${n.id}`, title: `${t(`graph.kind.${n.kind}`)}: ${n.title}` })),
    ...sessions.map((s) => ({ id: `session:${s.id}`, title: `${t('graph.session')}: ${s.title}` })),
  ];
  const fromKey = endpointKey(from);
  const fromItem = options.find((x) => x.id === fromKey);
  const toItem = edge ? options.find((x) => x.id === edge.to) : null;
  if (!fromItem || (edge && !toItem)) return false;
  const dialog = h('dialog', { class: 'graph-dialog', 'aria-labelledby': 'graph-connect-title' });
  const form = h('form', { class: 'graph-dialog__form' });
  form.append(
    h('h2', { id: 'graph-connect-title', text: t(edge ? 'graph.editRelationTitle' : 'graph.connectTitle') }),
    h('p', { class: 'graph-dialog__privacy', text: t('graph.recordOnly') }),
    fixedField(t, 'graph.from', fromItem.title),
    edge ? fixedField(t, 'graph.to', toItem.title) : endpointSelect(t, options, 'to', '', fromKey),
    selectField(t, 'graph.edgeKind', 'kind', [...GRAPH_EDGE_KINDS], edge?.kind ?? 'related', (v) => t(`graph.edge.${v}`)),
    inputField(t, 'graph.purpose', 'purpose', edge?.purpose ?? ''),
    selectField(t, 'graph.delegationStatus', 'status', [...DELEGATION_STATES], edge?.status || 'planned', (v) => t(`graph.delegation.${v}`)),
    h('div', { class: 'graph-dialog__actions' },
      edge && o.onDeleteEdge ? h('button', { class: 'textbtn graph-dialog__delete', type: 'button', 'data-dialog-action': 'delete-edge', text: t('graph.deleteRelation') }) : null,
      h('button', { class: 'textbtn', type: 'button', 'data-dialog-action': 'cancel', text: t('canvas.close') }),
      h('button', { class: 'btn btn--line', type: 'submit', text: t(edge ? 'graph.saveRelation' : 'graph.connect') }),
    ),
  );
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  form.addEventListener('click', (ev) => {
    const button = ev.target instanceof Element ? ev.target.closest('[data-dialog-action]') : null;
    const action = button?.getAttribute('data-dialog-action');
    if (action === 'cancel') dialog.close();
    if (action === 'delete-edge' && edge && o.onDeleteEdge && window.confirm(t('graph.removeRelationConfirm'))) {
      o.onDeleteEdge(edge.id);
      dialog.close();
    }
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const to = edge ? edge.to : String(data.to ?? '');
    if (!endpointKey(to) || to === fromKey) return;
    o.onConnect({ from: fromKey, to, kind: data.kind, purpose: data.purpose, status: data.status });
    dialog.close();
  });
  dialog.showModal();
  /** @type {HTMLSelectElement|null} */ (form.querySelector('[name="to"]'))?.focus();
  return true;
}
