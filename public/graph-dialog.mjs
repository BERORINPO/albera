// @ts-check
// Accessible local editor for graph cards and user-authored relations.

import { APPROVAL_MODES, DELEGATION_STATES, EXECUTION_LOCATIONS, GRAPH_EDGE_KINDS, GRAPH_NODE_KINDS, GRAPH_NODE_STATES, NETWORK_ACCESS, WORKSPACE_ISOLATIONS, obsidianOpenUri, reviewUnderstandingGaps, safeArtifactUrl, safeObsidianFile, safeObsidianVault } from './graph-model.mjs';
import { h } from './view.mjs';
import { graphSessionLabel } from './graph-session-label.mjs';
import { cancelGraphDialog, confirmBlockedOperationRelease, connectMissingComprehensionEdge, graphDialogFocusTarget } from './graph-dialog-actions.mjs';

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

/** @param {T} t @param {any} node */
function knowledgeFields(t, node) {
  return h('fieldset', { class: 'graph-dialog__profile', 'data-knowledge-note': '' },
    h('legend', { text: t('graph.knowledgeNote') }),
    h('p', { class: 'graph-dialog__hint', text: t('graph.knowledgeNoteManual') }),
    h('label', { class: 'graph-dialog__field' }, h('span', { text: t('graph.knowledgeVault') }), h('input', { name: 'knowledgeVault', maxlength: '100', autocomplete: 'off', required: true, value: node?.knowledgeVault ?? '' })),
    h('label', { class: 'graph-dialog__field' }, h('span', { text: t('graph.knowledgeFile') }), h('input', { name: 'knowledgeFile', maxlength: '240', autocomplete: 'off', required: true, value: node?.knowledgeFile ?? '' })),
  );
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
  return session ? graphSessionLabel(session, t) : t('graph.missingSession');
}

/** @param {T} t @param {Array<{id:string,title:string}>} options @param {string} name @param {string} selected @param {string} excluded */
function endpointSelect(t, options, name, selected, excluded = '') {
  return h('label', { class: 'graph-dialog__field' }, h('span', { text: t(name === 'from' ? 'graph.from' : 'graph.to') }), h('select', { name }, ...options.filter((x) => x.id !== excluded).map((x) => h('option', { value: x.id, selected: x.id === selected, text: x.title }))));
}

/** @param {string} key */
const endpointKey = (key) => key.startsWith('graph:') || key.startsWith('session:') ? key : '';

/**
 * @param {{t:T,node?:any,position?:{x:number,y:number},initialKind?:string,initialTitle?:string,graph:any,sessions:Array<{id:string,title:string}>,onSave:(v:any,sessionIds:Set<string>)=>void,onDelete?:(id:string)=>void,onConnect?:(from:string,kind?:string)=>void,onEditEdge?:(edge:any)=>void}} o
 */
export function openGraphNodeDialog(o) {
  const { t, node, graph, sessions } = o;
  const dialog = h('dialog', { class: 'graph-dialog', 'aria-labelledby': 'graph-dialog-title' });
  const form = h('form', { class: 'graph-dialog__form' });
  const title = node ? t('graph.editTitle') : t('graph.newTitle');
  form.append(h('h2', { id: 'graph-dialog-title', text: title }), h('p', { class: 'graph-dialog__privacy', text: t('graph.localOnly') }));
  const operationLocked = !!node && graph.edges.some((edge) => edge.operationId && edge.status !== 'completed' && (edge.from === `graph:${node.id}` || edge.to === `graph:${node.id}`));
  if (operationLocked) form.append(h('p', { class: 'graph-dialog__privacy', text: t('graph.nodeHasOperation') }));
  if (node?.kind === 'understanding_gap') {
    const review = reviewUnderstandingGaps(graph, new Set(sessions.map((session) => session.id))).find((item) => item.id === node.id);
    if (review?.missing.length) form.append(
      h('p', { class: 'graph-dialog__review', text: t('graph.reviewHint', { links: review.missing.map((kind) => t(`graph.link.${kind}`)).join(', ') }) }),
      h('div', { class: 'graph-dialog__review-actions' }, ...review.missing.map((kind) => h('button', {
        class: 'textbtn', type: 'button', 'data-dialog-action': 'connect-missing', 'data-edge-kind': kind,
        text: t(`graph.resolveMissing.${kind}`),
      }))),
    );
  }
  form.append(
    selectField(t, 'graph.kindLabel', 'kind', [...GRAPH_NODE_KINDS], node?.kind ?? o.initialKind ?? 'task', (v) => t(`graph.kind.${v}`)),
    inputField(t, 'graph.titleLabel', 'title', node?.title ?? o.initialTitle ?? '', true),
    areaField(t, 'graph.bodyLabel', 'body', node?.body ?? ''),
    h('p', { class: 'graph-dialog__hint', 'data-artifact-summary-hint': '', text: t('graph.artifactSummaryManual') }),
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
    knowledgeFields(t, node),
  );
  const kindSelect = /** @type {HTMLSelectElement|null} */ (form.querySelector('[name="kind"]'));
  const refField = /** @type {HTMLElement|null} */ (form.querySelector('[data-artifact-reference]'));
  const artifactSummaryHint = /** @type {HTMLElement|null} */ (form.querySelector('[data-artifact-summary-hint]'));
  const refInput = /** @type {HTMLInputElement|null} */ (form.querySelector('[name="referenceUrl"]'));
  const statusInput = /** @type {HTMLSelectElement|null} */ (form.querySelector('[name="status"]'));
  const profileFields = /** @type {HTMLElement|null} */ (form.querySelector('[data-execution-profile]'));
  const comprehensionFields = /** @type {HTMLElement|null} */ (form.querySelector('[data-comprehension-fields]'));
  const knowledgeNoteFields = /** @type {HTMLFieldSetElement|null} */ (form.querySelector('[data-knowledge-note]'));
  const knowledgeVaultInput = /** @type {HTMLInputElement|null} */ (form.querySelector('[name="knowledgeVault"]'));
  const knowledgeFileInput = /** @type {HTMLInputElement|null} */ (form.querySelector('[name="knowledgeFile"]'));
  const syncReferenceField = () => {
    const artifact = kindSelect?.value === 'artifact';
    if (refField) refField.hidden = !artifact;
    if (artifactSummaryHint) artifactSummaryHint.hidden = !artifact;
  };
  const syncProfileFields = () => { if (profileFields) profileFields.hidden = kindSelect?.value !== 'execution_profile'; };
  const syncComprehensionFields = () => { if (comprehensionFields) comprehensionFields.hidden = kindSelect?.value !== 'understanding_gap'; };
  const syncKnowledgeFields = () => {
    const enabled = kindSelect?.value === 'obsidian_note';
    if (knowledgeNoteFields) {
      knowledgeNoteFields.hidden = !enabled;
      knowledgeNoteFields.disabled = !enabled;
    }
  };
  kindSelect?.addEventListener('change', syncReferenceField);
  kindSelect?.addEventListener('change', syncProfileFields);
  kindSelect?.addEventListener('change', syncComprehensionFields);
  kindSelect?.addEventListener('change', syncKnowledgeFields);
  refInput?.addEventListener('input', () => refInput.setCustomValidity(''));
  statusInput?.addEventListener('change', () => statusInput.setCustomValidity(''));
  for (const name of ['missingEvidence', 'neededExplanation']) form.querySelector(`[name="${name}"]`)?.addEventListener('input', () => statusInput?.setCustomValidity(''));
  knowledgeVaultInput?.addEventListener('input', () => knowledgeVaultInput.setCustomValidity(''));
  knowledgeFileInput?.addEventListener('input', () => knowledgeFileInput.setCustomValidity(''));
  syncReferenceField();
  syncProfileFields();
  syncComprehensionFields();
  syncKnowledgeFields();
  if (node?.url) form.append(h('a', { class: 'graph-dialog__reference-link', href: node.url, target: '_blank', rel: 'noopener noreferrer', text: t('graph.openReference') }));
  const knowledgeUri = node?.kind === 'obsidian_note' ? obsidianOpenUri(node.knowledgeVault, node.knowledgeFile) : '';
  if (knowledgeUri) form.append(h('a', { class: 'graph-dialog__reference-link', href: knowledgeUri, target: '_blank', rel: 'noopener noreferrer', text: t('graph.openKnowledgeNote') }));
  if (node) {
    const linked = graph.edges.filter((e) => e.from === `graph:${node.id}` || e.to === `graph:${node.id}`);
    form.append(h('h3', { class: 'graph-dialog__subhead', text: t('graph.relations') }));
    form.append(linked.length
      ? h('ul', { class: 'graph-dialog__relations' }, ...linked.map((e) => {
        const other = e.from === `graph:${node.id}` ? e.to : e.from;
        const direction = e.from === `graph:${node.id}` ? t('graph.relationOut') : t('graph.relationIn');
        return h('li', {},
          h('span', { text: `${direction}: ${endpointLabel(other, graph, sessions, t)} — ${t(`graph.edge.${e.kind}`)}${e.purpose ? `: ${e.purpose}` : e.kind === 'delegates' ? `: ${t('graph.delegationPurposeMissing')}` : ''}${e.kind === 'delegates' ? ` (${t(`graph.delegation.${e.status}`)})` : ''}` }),
          o.onEditEdge ? h('button', { class: 'textbtn', type: 'button', 'data-dialog-action': 'edit-edge', 'data-edge-id': e.id, text: t('graph.editRelation') }) : null,
        );
      }))
      : h('p', { class: 'graph-dialog__empty', text: t('graph.noRelations') }));
  }
  const acts = h('div', { class: 'graph-dialog__actions' });
  if (node && o.onConnect) acts.append(h('button', { class: 'textbtn', type: 'button', 'data-dialog-action': 'connect', text: t('graph.connect') }));
  if (node && o.onDelete && !operationLocked) acts.append(h('button', { class: 'textbtn graph-dialog__delete', type: 'button', 'data-dialog-action': 'delete', text: t('graph.delete') }));
  acts.append(h('button', { class: 'textbtn', type: 'button', 'data-dialog-action': 'cancel', text: t('canvas.close') }), h('button', { class: 'btn btn--line', type: 'submit', text: t('graph.save') }));
  form.append(acts);
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  form.addEventListener('click', (ev) => {
    const button = ev.target instanceof Element ? ev.target.closest('[data-dialog-action]') : null;
    const action = button?.getAttribute('data-dialog-action');
    if (!action) return;
    if (cancelGraphDialog(action, () => dialog.close())) return;
    if (!node) return;
    if (action === 'connect' && o.onConnect) {
      dialog.close();
      o.onConnect(`graph:${node.id}`);
    }
    if (action === 'connect-missing' && o.onConnect) {
      const kind = button?.getAttribute('data-edge-kind') ?? '';
      connectMissingComprehensionEdge({ nodeId: node.id, edgeKind: kind, close: () => dialog.close(), connect: o.onConnect });
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
    if (String(data.kind) === 'understanding_gap' && ['done', 'resolved'].includes(String(data.status))) {
      const sessionsById = new Set(sessions.map((session) => session.id));
      const candidate = {
        ...graph,
        nodes: graph.nodes.map((item) => item.id === node?.id ? {
          ...item,
          kind: 'understanding_gap',
          missingEvidence: String(data.missingEvidence ?? ''),
          neededExplanation: String(data.neededExplanation ?? ''),
        } : item),
      };
      const missing = node
        ? reviewUnderstandingGaps(candidate, sessionsById).find((item) => item.id === node.id)?.missing ?? []
        : [String(data.missingEvidence ?? '').trim() ? 'evidence' : '', String(data.neededExplanation ?? '').trim() ? 'explains' : ''].filter(Boolean);
      if (missing.length) {
        statusInput?.setCustomValidity(t('graph.resolveNeedsLinks', { links: missing.map((kind) => t(`graph.link.${kind}`)).join(', ') }));
        statusInput?.reportValidity();
        return;
      }
    }
    const referenceUrl = safeArtifactUrl(data.referenceUrl, String(data.kind));
    if (String(data.kind) === 'artifact' && String(data.referenceUrl ?? '').trim() && !referenceUrl) {
      refInput?.setCustomValidity(t('graph.referenceInvalid'));
      refInput?.reportValidity();
      return;
    }
    const knowledgeVault = String(data.kind) === 'obsidian_note' ? safeObsidianVault(data.knowledgeVault) : '';
    const knowledgeFile = String(data.kind) === 'obsidian_note' ? safeObsidianFile(data.knowledgeFile) : '';
    if (String(data.kind) === 'obsidian_note' && (!knowledgeVault || !knowledgeFile)) {
      knowledgeVaultInput?.setCustomValidity(knowledgeVault ? '' : t('graph.knowledgeVaultInvalid'));
      knowledgeFileInput?.setCustomValidity(knowledgeFile ? '' : t('graph.knowledgeFileInvalid'));
      (knowledgeVaultInput?.validationMessage ? knowledgeVaultInput : knowledgeFileInput)?.reportValidity();
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
      knowledgeVault,
      knowledgeFile,
    }, new Set(sessions.map((session) => session.id)));
    dialog.close();
  });
  dialog.showModal();
  /** @type {HTMLInputElement|null} */ (form.querySelector('[name="title"]'))?.focus();
}

/**
 * @param {{t:T,from:string,edge?:any,initialTo?:string,initialKind?:string,graph:any,sessions:Array<{id:string,title:string}>,onConnect:(v:any)=>void,onDeleteEdge?:(id:string)=>void,onResolveOperation?:(id:string,operationId:string)=>boolean}} o
 */
export function openGraphRelationDialog(o) {
  const { t, from, graph, sessions, edge } = o;
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const options = [
    ...graph.nodes.map((n) => ({ id: `graph:${n.id}`, title: `${t(`graph.kind.${n.kind}`)}: ${n.title}` })),
    ...sessions.map((s) => ({ id: `session:${s.id}`, title: graphSessionLabel(s, t) })),
  ];
  const fromKey = endpointKey(from);
  const missingEndpoint = (key) => ({
    id: key,
    title: t(key.startsWith('session:') ? 'graph.missingSession' : 'graph.missingNode'),
  });
  const fromItem = options.find((x) => x.id === fromKey) ?? (edge ? missingEndpoint(fromKey) : null);
  const toItem = edge ? options.find((x) => x.id === edge.to) ?? missingEndpoint(edge.to) : null;
  if (!fromItem || (edge && !toItem)) return false;
  const dialog = h('dialog', { class: 'graph-dialog', 'aria-labelledby': 'graph-connect-title' });
  const form = h('form', { class: 'graph-dialog__form' });
  form.append(h('h2', { id: 'graph-connect-title', text: t(edge?.operationId ? 'graph.operationRelationTitle' : edge ? 'graph.editRelationTitle' : 'graph.connectTitle') }), h('p', { class: 'graph-dialog__privacy', text: t('graph.recordOnly') }));
  if (edge?.operationId) {
    form.append(
      fixedField(t, 'graph.from', fromItem.title),
      fixedField(t, 'graph.to', toItem.title),
      fixedField(t, 'graph.edgeKind', t(`graph.edge.${edge.kind}`)),
      fixedField(t, 'graph.purpose', edge.purpose),
      fixedField(t, 'graph.delegationStatus', t(`graph.delegation.${edge.status}`)),
      h('p', { class: 'graph-dialog__privacy', text: t('graph.operationManaged') }),
      edge.status === 'blocked' ? h('p', { class: 'graph-dialog__privacy', text: t('graph.blockedOperationNeedsReview') }) : null,
      h('div', { class: 'graph-dialog__actions' },
        edge.status === 'completed' && o.onDeleteEdge ? h('button', { class: 'textbtn graph-dialog__delete', type: 'button', 'data-dialog-action': 'delete-edge', text: t('graph.deleteRelation') }) : null,
        edge.status === 'blocked' && o.onResolveOperation ? h('button', { class: 'textbtn', type: 'button', 'data-dialog-action': 'release-operation', text: t('graph.releaseOperationLock') }) : null,
        h('button', { class: 'textbtn', type: 'button', 'data-dialog-action': 'cancel', text: t('canvas.close') }),
      ),
    );
  } else {
    form.append(
      fixedField(t, 'graph.from', fromItem.title),
      edge ? fixedField(t, 'graph.to', toItem.title) : endpointSelect(t, options, 'to', o.initialTo ?? '', fromKey),
      selectField(t, 'graph.edgeKind', 'kind', [...GRAPH_EDGE_KINDS], edge?.kind ?? (GRAPH_EDGE_KINDS.includes(o.initialKind ?? '') ? o.initialKind : 'related'), (v) => t(`graph.edge.${v}`)),
      inputField(t, 'graph.purpose', 'purpose', edge?.purpose ?? '', edge?.kind === 'delegates' || o.initialKind === 'delegates'),
      selectField(t, 'graph.delegationStatus', 'status', [...DELEGATION_STATES], edge?.status || 'planned', (v) => t(`graph.delegation.${v}`)),
      h('div', { class: 'graph-dialog__actions' },
        edge && o.onDeleteEdge ? h('button', { class: 'textbtn graph-dialog__delete', type: 'button', 'data-dialog-action': 'delete-edge', text: t('graph.deleteRelation') }) : null,
        h('button', { class: 'textbtn', type: 'button', 'data-dialog-action': 'cancel', text: t('canvas.close') }),
        h('button', { class: 'btn btn--line', type: 'submit', text: t(edge ? 'graph.saveRelation' : 'graph.connect') }),
      ),
    );
  }
  dialog.append(form);
  const kindInput = /** @type {HTMLSelectElement|null} */ (form.querySelector('[name="kind"]'));
  const purposeInput = /** @type {HTMLInputElement|null} */ (form.querySelector('[name="purpose"]'));
  kindInput?.addEventListener('change', () => {
    if (purposeInput) purposeInput.required = kindInput.value === 'delegates';
  });
  document.body.append(dialog);
  dialog.addEventListener('close', () => {
    dialog.remove();
    requestAnimationFrame(() => {
      const sourceId = fromKey.startsWith('graph:') ? fromKey.slice(6) : fromKey.startsWith('session:') ? fromKey.slice(8) : '';
      const sourceSelector = fromKey.startsWith('graph:') ? '.graph-node' : '.slip__title';
      const sourceCard = sourceId
        ? /** @type {HTMLElement|null} */ (document.querySelector(`${sourceSelector}[data-id="${CSS.escape(sourceId)}"]`))
        : null;
      const viewport = /** @type {HTMLElement|null} */ (document.querySelector('#cv-view'));
      const target = graphDialogFocusTarget(returnFocus, sourceCard, viewport);
      target?.focus({ preventScroll: true });
    });
  }, { once: true });
  form.addEventListener('click', (ev) => {
    const button = ev.target instanceof Element ? ev.target.closest('[data-dialog-action]') : null;
    const action = button?.getAttribute('data-dialog-action');
    if (action === 'cancel') dialog.close();
    if (action === 'release-operation' && o.onResolveOperation && confirmBlockedOperationRelease({
      edge,
      confirm: () => window.confirm(t('graph.resolveBlockedOperationConfirm')),
      resolve: o.onResolveOperation,
    })) dialog.close();
    const confirmKey = edge?.operationId ? 'graph.removeCompletedOperationRelationConfirm' : 'graph.removeRelationConfirm';
    if (action === 'delete-edge' && edge && o.onDeleteEdge && (!edge.operationId || edge.status === 'completed') && window.confirm(t(confirmKey))) {
      o.onDeleteEdge(edge.id);
      dialog.close();
    }
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (edge?.operationId) return;
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
