// @ts-check
// 画面: キャンバスの帯 (#cv-bar、spec/ui.md §10.9)。4 つの状態: いつもの (凡例・ヒント・引き継ぎどき・拡大縮小・全体・並べ直す)、
// 詳しく (一覧と同じ dl と操作の行 + 閉じる)、引き継ぎ (一覧と同じ案内 + 閉じる)、用紙を動かす (矢印のボタン・この用紙を表示・閉じる)。
// 閉じるまで出したまま (選択の帯と同じ)。

import { handoffGuideEl, handoffPlan } from './handoff.mjs';
import { bucketTitle, titleOf } from './format.mjs';
import { obsidianOpenUri } from './graph-model.mjs';
import { detailEl, detailStamp } from './rows.mjs';
import { isCompletedLocalCodexTarget } from './events.mjs';
import { delegationAvailability } from './delegation-availability.mjs';
import { comprehensionGapSummary, sessionRelationEntries } from './session-relations.mjs';
import { reviewUnderstandingGaps } from './graph-model.mjs';
import { fill, h } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */
/** @typedef {{kind: 'detail'|'handoff'|'sheet', id: string}} BarState  sheet の id は用紙の key */

/** 凡例の印: 付箋になる 4 つの欄だけ (最近と片付けは用紙の帯の言葉で、印にはならない) */
const LEGEND = Object.freeze(['needs_you', 'trouble', 'unread', 'working']);
/** 凡例の目盛りの見本の割合 */
const SAMPLE_PCT = 72;
/** 用紙を動かすボタン (向きと矢印) */
const MOVES = Object.freeze([['left', '←'], ['up', '↑'], ['down', '↓'], ['right', '→']]);

/** 拡大縮小の割合の文字。 @param {T} t @param {number} z */
export const zoomText = (t, z) => t('canvas.zoom', { n: Math.round(z * 100) });

/** いつもの帯 (40rem より狭いと、デモのしるしもここ: 帯の左は空いている)。 @param {T} t @param {{z: number, due: number, keysOn: boolean, demo?: boolean}} o */
function defaultBar(t, o) {
  const reviewCount = reviewUnderstandingGaps(o.graph ?? { nodes: [], edges: [] }, new Set(o.rowCtx?.index?.keys?.() ?? [])).length;
  const tick = h('span', { class: 'cvtick', 'aria-hidden': 'true' });
  tick.style.setProperty('--p', String(SAMPLE_PCT));
  const fit = h('button', { class: 'textbtn', type: 'button', 'data-action': 'canvas-fit' }, t('canvas.fit'), ' ', h('kbd', { class: 'hk', 'aria-hidden': 'true', text: 'f' }));
  if (o.keysOn) fit.setAttribute('aria-keyshortcuts', 'f');
  return [
    o.demo ? h('p', { class: 'cbar__demo', text: t('mast.demo') }) : null,
    h(
      'p',
      { class: 'cbar__legend', 'aria-hidden': 'true' },
      ...LEGEND.map((p) => h('span', {}, h('i', { class: `mark mark--${p}` }), bucketTitle(t, p))),
      h('span', {}, h('span', { class: 'ctx' }, tick), t('detail.context')),
    ),
    h('p', { class: 'cbar__hint', text: t('canvas.hint') }),
    h(
      'p',
      { class: 'cbar__tools' },
      o.due > 0 ? h('button', { class: 'textbtn cbar__due', type: 'button', 'data-action': 'due-next', text: t('ctx.dueCount', { n: o.due }) }) : null,
      reviewCount ? h('button', { class: 'textbtn cbar__due', type: 'button', 'data-action': 'graph-review-gaps', text: t('graph.reviewCount', { n: reviewCount }) }) : null,
      h(
        'span',
        { class: 'cbar__zoom' },
        h('button', { class: 'textbtn is-sym', type: 'button', 'data-action': 'canvas-zoom-out', 'aria-label': t('canvas.zoomOut'), text: '−' }),
        h('span', { class: 'cbar__pct', id: 'cv-zoom', text: zoomText(t, o.z) }),
        h('button', { class: 'textbtn is-sym', type: 'button', 'data-action': 'canvas-zoom-in', 'aria-label': t('canvas.zoomIn'), text: '+' }),
      ),
      fit,
      h('button', { class: 'textbtn cbar__arrange', type: 'button', 'data-action': 'canvas-arrange', text: t('canvas.arrange') }),
      h('button', { class: 'textbtn', type: 'button', 'data-action': 'graph-new', text: t('graph.newButton') }),
    ),
  ];
}

/**
 * 詳しく: 一覧の詳しくと同じ中身 (引き継ぎの案内は除く。キャンバスでは帯の引き継ぎの状態が受け持つ) と、操作の行の最後に「閉じる」。
 * 案内のあるカードには「引き継ぐ」も置く (帯の引き継ぎの状態を開く。Tab で届き、1 文字キーを止めても使える道)。
 * @param {T} t @param {any} card @param {string} pile @param {any} rowCtx
 */
function sessionRelations(t, card, graph, sessionIndex, demo) {
  const sessions = [...sessionIndex.keys()].map((id) => ({ id }));
  const entries = sessionRelationEntries(graph?.edges ?? [], card.id, graph ?? { nodes: [] }, sessions);
  const items = entries.map((entry) => {
    const direction = t(entry.direction === 'out' ? 'graph.sessionRelationOut' : 'graph.sessionRelationIn');
    const status = entry.kind === 'delegates' ? ` (${t(`graph.delegation.${entry.status}`)})` : '';
    const endpoint = entry.endpoint === 'graph'
      ? h('button', { class: 'textbtn graph-session-relations__node', type: 'button', 'data-action': 'graph-open', 'data-id': entry.node.id, text: `${t(`graph.kind.${entry.node.kind}`)}: ${entry.node.title}` })
      : h('button', { class: 'textbtn graph-session-relations__node', type: 'button', 'data-action': 'canvas-open-session', 'data-id': entry.sessionId, text: `${t(`source.${entry.sessionId.startsWith('codex_') ? 'codex' : entry.sessionId.startsWith('copilot_') ? 'copilot' : entry.sessionId.startsWith('opencode_') ? 'opencode' : 'claude'}`)} #${entry.sessionId.slice(-8)}` });
    const localNode = entry.endpoint === 'graph' && entry.node.kind === 'obsidian_note'
      ? graph.nodes.find((node) => node.id === entry.node.id)
      : null;
    const openNoteUri = localNode ? obsidianOpenUri(localNode.knowledgeVault, localNode.knowledgeFile) : '';
    const targetCard = entry.endpoint === 'session' ? sessionIndex.get(entry.sessionId)?.card : null;
    const edge = graph?.edges?.find((item) => item.id === entry.edgeId);
    const delegation = delegationAvailability({
      entry, demo, hasOperationId: Boolean(edge?.operationId),
      target: targetCard ? {
        executionLocation: targetCard.detail?.executionLocation,
        completedLocalCodex: isCompletedLocalCodexTarget(targetCard),
      } : undefined,
    });
    return h('li', {},
      endpoint,
      openNoteUri ? h('a', { class: 'textbtn graph-session-relations__node', href: openNoteUri, target: '_blank', rel: 'noopener noreferrer', text: t('graph.openKnowledgeNote') }) : null,
      h('span', { text: `${direction} — ${t(`graph.edge.${entry.kind}`)}${status}` }),
      entry.purpose ? h('small', { text: entry.purpose }) : entry.kind === 'delegates' ? h('small', { class: 'graph-dialog__hint', text: t('graph.delegationPurposeMissing') }) : null,
      entry.kind === 'delegates' ? h('button', { class: 'textbtn graph-session-relations__node', type: 'button', 'data-action': 'graph-edit-edge', 'data-id': entry.edgeId, text: t('graph.editDelegation') }) : null,
      delegation.action
        ? h('button', { class: 'textbtn graph-session-relations__node', type: 'button', 'data-action': 'delegation-run', 'data-id': entry.edgeId, 'data-source-session': card.id, text: t(delegation.action === 'check' ? 'graph.checkDelegation' : 'graph.runDelegation') })
        : delegation.reason ? h('small', { class: 'graph-dialog__hint', text: t(delegation.reason) }) : null,
      entry.endpoint === 'graph' && entry.node.kind === 'execution_profile'
        ? h('small', { text: t('graph.executionProfileSummary', { values: [
          t(`graph.executionLocation.${entry.node.executionLocation}`),
          t(`graph.workspaceIsolation.${entry.node.workspaceIsolation}`),
          t(`graph.networkAccess.${entry.node.networkAccess}`),
          t(`graph.approvalMode.${entry.node.approvalMode}`),
        ].join(' / ') }) })
        : null,
      entry.endpoint === 'graph' && entry.node.kind === 'understanding_gap'
        ? h('div', {}, h('small', { text: comprehensionGapSummary(entry.node, t).join(' / ') }),
          entry.node.evidenceLinks.length ? h('small', {}, t('graph.evidenceLinks'), ' ', ...gapTargetButtons(t, entry.node.evidenceLinks)) : null,
          entry.node.explanationLinks.length ? h('small', {}, t('graph.explanationLinks'), ' ', ...gapTargetButtons(t, entry.node.explanationLinks)) : null,
        )
        : null,
    );
  });
  return items.length
    ? h('section', { class: 'graph-session-relations', 'aria-label': t('graph.relations') }, h('h3', { text: t('graph.relatedCards') }), h('ul', {}, ...items))
    : null;
}

function gapTargetButtons(t, links) {
  return links.flatMap((link, index) => [
    index ? ', ' : '',
    h('button', {
      class: 'textbtn graph-session-relations__node', type: 'button',
      'data-action': link.endpoint === 'graph' ? 'graph-open' : 'canvas-open-short-session',
      'data-id': link.endpoint === 'graph' ? link.nodeId : link.shortId,
      ...(link.endpoint === 'session' ? { 'data-source': link.source } : {}),
      text: link.endpoint === 'graph' ? `${t(`graph.kind.${link.kind}`)}: ${link.title}` : `${t(`source.${link.source}`)} #${link.shortId}`,
    }),
  ]);
}

function detailBar(t, card, pile, rowCtx, graph, demo) {
  const el = detailEl(card, pile, rowCtx);
  el.querySelector('section.handoff')?.remove();
  const relations = sessionRelations(t, card, graph, rowCtx.index, demo);
  if (relations) el.append(relations);
  const acts = el.querySelector('.detail__acts') ?? el.appendChild(h('p', { class: 'detail__acts' }));
  if (handoffPlan(card, rowCtx.handoff?.[card.id], rowCtx.now).guide) {
    acts.prepend(h('button', { class: 'textbtn is-strong', type: 'button', 'data-action': 'handoff-open', 'data-id': card.id, 'aria-label': t('handoff.openAria', { title: titleOf(t, card.title) }), text: t('handoff.open') }));
  }
  acts.append(h('button', { class: 'textbtn', type: 'button', 'data-action': 'graph-connect', 'data-id': card.id, text: t('graph.connectSession') }));
  acts.append(h('button', { class: 'textbtn', type: 'button', 'data-action': 'graph-task-from-session', 'data-id': card.id, text: t('graph.taskFromSession') }));
  acts.append(h('button', { class: 'textbtn', type: 'button', 'data-action': 'canvas-close', 'data-id': card.id, text: t('canvas.close') }));
  return el;
}

/**
 * 用紙を動かす: ドラッグの代わりの、ポインタ 1 回で押せるボタン (WCAG 2.5.7)。押すたびに NUDGE ずつ。
 * @param {T} t @param {{key: string, name: string}} sheet
 */
function sheetBar(t, sheet) {
  return h(
    'section',
    { class: 'sheetbar', 'aria-labelledby': 'sb-lead' },
    h('h3', { class: 'sheetbar__lead', id: 'sb-lead', text: t('canvas.sheetLead', { project: sheet.name }) }),
    h('p', { class: 'sheetbar__hint', text: t('canvas.sheetHint') }),
    h(
      'p',
      { class: 'sheetbar__acts' },
      h('span', { class: 'cbar__zoom' }, ...MOVES.map(([dir, sym]) => h('button', { class: 'textbtn is-sym', type: 'button', 'data-action': 'canvas-move', 'data-dir': dir, 'data-key': sheet.key, 'aria-label': t(`canvas.move.${dir}`), text: sym }))),
      h('button', { class: 'textbtn', type: 'button', 'data-action': 'canvas-sheet-fit', 'data-key': sheet.key, text: t('canvas.sheetFit') }),
      h('button', { class: 'textbtn', type: 'button', 'data-action': 'canvas-close', text: t('canvas.close') }),
    ),
  );
}

/** 引き継ぎ: 案内 (無ければ理由を見出しにして「閉じる」だけ)。 @param {T} t @param {any} card @param {{now: number, stored: any, demo: boolean}} o */
function handoffBar(t, card, o) {
  const plan = handoffPlan(card, o.stored, o.now);
  if (plan.guide) return handoffGuideEl(t, card, { kind: plan.guide, inBar: true, demo: o.demo });
  return h(
    'section',
    { class: 'handoff' },
    h('h3', { class: 'handoff__lead', text: t('live.handoffNo', { why: t(plan.why ?? 'handoff.whyUnknown') }) }),
    h('p', { class: 'handoff__acts' }, h('button', { class: 'textbtn', type: 'button', 'data-action': 'handoff-close', 'data-id': card.id, text: t('handoff.close') })),
  );
}

/**
 * 帯を描く。署名が変わったときだけ作り直す (手で選んだ文字と「コピーした ✓」を残す)。拡大縮小の割合は作り直さずに書く。
 * @param {HTMLElement} el #cv-bar
 * @param {{t: T, bar: BarState|null, entry: {card: any, pile: string}|null, sheet?: {key: string, name: string}|null, z: number, due: number, keysOn: boolean, now: number, demo: boolean, rowCtx: any, graph?: any}} o
 * @returns {BarState|null} 実際に出した状態 (カードや用紙が消えていれば null に戻す)
 */
export function renderBar(el, o) {
  const t = o.t;
  const bar = o.bar && (o.bar.kind === 'sheet' ? o.sheet : o.entry) ? o.bar : null;
  let sig;
  if (!bar) {
    const reviewCount = reviewUnderstandingGaps(o.graph ?? { nodes: [], edges: [] }, new Set(o.rowCtx?.index?.keys?.() ?? [])).length;
    sig = `default|${t.lang}|${o.due}|${reviewCount}|${o.keysOn}|${o.demo}`;
  }
  else if (bar.kind === 'sheet') sig = `sheet|${bar.id}|${t.lang}|${o.sheet?.name}`;
  else {
    const card = /** @type {any} */ (o.entry).card;
    const row = handoffPlan(card, o.rowCtx.handoff?.[card.id], o.now).row ?? '';
    sig = `${bar.kind}|${bar.id}|${o.entry?.pile}|${row}|${detailStamp(o.rowCtx, bar.id)}|${JSON.stringify(card)}|${JSON.stringify(o.graph?.edges ?? [])}|${o.demo}`;
  }
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    el.dataset.state = bar ? bar.kind : 'default';
    if (!bar) fill(el, ...defaultBar(t, o));
    else if (bar.kind === 'sheet') fill(el, sheetBar(t, /** @type {{key: string, name: string}} */ (o.sheet)));
    else {
      const { card, pile } = /** @type {{card: any, pile: string}} */ (o.entry);
      fill(el, bar.kind === 'detail' ? detailBar(t, card, pile, o.rowCtx, o.graph, o.demo) : handoffBar(t, card, { now: o.now, stored: o.rowCtx.handoff?.[card.id], demo: o.demo }));
    }
    // 名前: いつもの帯は「キャンバスの操作」(凡例は aria-hidden なので凡例の名前にしない)、ほかは帯の見出し
    const lead = bar ? el.querySelector('.handoff__lead, .sheetbar__lead')?.textContent ?? '' : '';
    const label = !bar ? t('canvas.barAria') : bar.kind !== 'detail' ? lead : t('canvas.slip', { pile: bucketTitle(t, /** @type {any} */ (o.entry).pile), title: titleOf(t, /** @type {any} */ (o.entry).card.title), time: el.querySelector('time')?.textContent ?? '' });
    el.setAttribute('aria-label', label);
  }
  const pct = el.querySelector('#cv-zoom');
  const z = zoomText(t, o.z);
  if (pct && pct.textContent !== z) pct.textContent = z;
  return bar;
}
