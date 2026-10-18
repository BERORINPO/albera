// @ts-check
// 画面: 片付け (To archive) の欄と、下に貼り付く選択の帯。
// 何も書き換えない。選んだ ID を Claude への指示文にしてコピーし、盤面から消えたものを数えるだけ。

import { COPY_CHUNK, PAGE_SIZE, POLL_MS, SEC } from '../src/shared/constants.mjs';
import { bucketTitle, cleanupGroupName, reasonLine, sentences, timeText, titleOf } from './format.mjs';
import { detailEl, langOf, metaItems, rowSig, syncRow, timeEl } from './rows.mjs';
import { pick, state, unpick } from './state.mjs';
import { checkState, cleanupIds, groupCards, groupState, planCopy, reselectIds, rowIds, selbarMode, stepOf, suggestedIds } from './ui-state.mjs';
import { fill, h, partsToNodes, reconcile, setCheck, setDisclosed } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */
/** @typedef {import('./rows.mjs').RowCtx} RowCtx */
/** @typedef {Record<string, any>} Card */

/** 「<b>選んだ数</b> / 全体」。 @param {T} t @param {number} sel @param {number} n */
const tally = (t, sel, n) => h('span', { class: 'tally' }, ...partsToNodes(t.parts('cleanup.tally', { sel: h('b', { text: String(sel) }), n })));

/** @param {Card[]} cards */
const idsOf = (cards) => cards.flatMap(rowIds);
/** @param {Card[]} cards */
const suggestedOf = (cards) => cards.filter((c) => c.cleanup?.recommended).flatMap(rowIds);

/**
 * 片付けの行 (div.slot > div.trow)。
 * @param {Card} card @param {RowCtx} ctx @param {boolean} oneProject グループ全体が 1 プロジェクトならプロジェクト名を省く
 */
function trowEl(card, ctx, oneProject) {
  const t = ctx.t;
  const title = titleOf(t, card.title);
  const ids = rowIds(card);
  const routine = ids.length > 1 || !!card.routine?.runIds;
  const aria = routine ? t('cleanup.routineAria', { n: ids.length, title }) : t('row.selectAria', { title });
  const reason = reasonLine(t, card);
  const meta = metaItems(t, card, 'cleanup', ctx, { noProject: oneProject });
  if (card.cleanup?.note) meta.splice(oneProject ? 0 : 1, 0, h('span', { text: t(`note.${card.cleanup.note}`) }));
  if (routine) meta.push(h('span', { text: t('cleanup.routineTick', { n: ids.length }) }));
  const row = h(
    'div',
    { class: 'trow', 'data-id': card.id, 'data-pile': 'cleanup', 'data-ids': ids.join(' ') },
    h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-action': 'pick-row', 'data-id': card.id, 'aria-label': aria })),
    h(
      'button',
      { class: 'trow__title', type: 'button', 'aria-expanded': 'false', 'aria-controls': `d-${card.id}`, 'aria-describedby': 'title-keys', 'data-action': 'toggle', 'data-id': card.id },
      h('span', { class: 't', lang: langOf(t, card.title) }, title, h('span', { class: 'chev', 'aria-hidden': 'true' })),
    ),
    h('span', { class: 'trow__time' }, timeEl(t, card, ctx.now)),
    reason ? h('span', { class: 'trow__body', text: reason }) : null,
    meta.length ? h('span', { class: 'trow__meta' }, ...meta) : null,
    (() => {
      const wrap = h('div', { class: 'row__detail disclose', id: `d-${card.id}` }, h('div', { class: 'disclose__in' }));
      setDisclosed(wrap, false);
      return wrap;
    })(),
  );
  return h('div', { class: 'slot' }, row);
}

/**
 * 行の一覧 (ページつき)。
 * @param {HTMLElement} box @param {HTMLElement} moreBox @param {Card[]} cards @param {string} list @param {RowCtx & {pages: Record<string, number>}} ctx @param {boolean} oneProject
 */
function renderTrows(box, moreBox, cards, list, ctx, oneProject) {
  const pages = ctx.filtering ? Infinity : Math.max(1, ctx.pages[list] ?? 1);
  const shown = cards.slice(0, pages * PAGE_SIZE);
  reconcile(box, shown, (c) => c.id, (c) => rowSig(c, 'cleanup', ctx, oneProject ? 'one' : ''), (c) => trowEl(c, ctx, oneProject), ctx.leave);
  for (const slot of /** @type {HTMLElement[]} */ ([...box.children])) syncRow(slot, ctx, (id) => detailEl(/** @type {Card} */ (cards.find((c) => c.id === id)), 'cleanup', ctx));
  const rest = cards.length - shown.length;
  fill(moreBox, rest > 0 ? h('button', { class: 'textbtn list__more', type: 'button', 'data-action': 'page', 'data-list': list, text: ctx.t('page.more', { n: Math.min(PAGE_SIZE, rest) }) }) : null);
}

/** @param {any} group */
const oneProjectOf = (group) => new Set(groupCards(group).map((c) => c.project?.key)).size <= 1;

/**
 * 理由グループ 1 つの器。中身は updateGroup が毎回合わせる。
 * 見出しの名前はグループ名と件数だけ (中のチェックボックスの名前を重ねない)。グループは landmark にしない (名前の無い section)。
 * @param {any} g @param {T} t @param {boolean} checkable
 */
function groupShell(g, t, checkable) {
  const name = cleanupGroupName(t, g.reason);
  const nameId = `gn-${g.reason}`;
  const tallyId = `gt-${g.reason}`;
  const head = checkable
    ? h(
        'h3',
        { class: 'group__head', id: `g-${g.reason}`, 'aria-labelledby': `${nameId} ${tallyId}` },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-action': 'pick-group', 'data-reason': g.reason, 'aria-label': t('cleanup.groupAria', { group: name }) }), h('span', { id: nameId, text: name })),
        h('span', { class: 'group__tally', id: tallyId }),
      )
    : h('h3', { class: 'group__head group__head--off', id: `g-${g.reason}` }, h('span', { text: name }), h('span', { class: 'group__tally' }));
  return h(
    'section',
    { class: 'group' },
    head,
    checkable ? null : h('p', { class: 'group__off', text: t('cleanup.notSuggested') }),
    h('div', { class: 'group__body' }),
    h('p', { class: 'group__more' }),
  );
}

/** サブグループ (プロジェクトごと) の器。 @param {any} g @param {any} p @param {T} t */
function subShell(g, p, t) {
  const name = p.label ?? t('project.other');
  const key = `sub:${g.reason}:${p.key}`;
  return h(
    'div',
    { class: 'sub' },
    h(
      'div',
      { class: 'sub__head' },
      p.recommendedCount > 0 ? h('input', { class: 'sub__check', type: 'checkbox', 'data-action': 'pick-sub', 'data-reason': g.reason, 'data-key': p.key, 'aria-label': t('cleanup.subAria', { n: p.recommendedCount, project: name }) }) : h('span', { class: 'sub__check' }),
      h(
        'button',
        { class: 'sub__toggle', type: 'button', 'data-action': 'sub', 'data-list': key, 'aria-controls': `s-${g.reason}-${p.key}` },
        h('span', { class: 'chev', 'aria-hidden': 'true' }),
        h('span', { class: `sub__name${p.label == null ? ' sub__name--muted' : ''}`, text: name }),
        h('span', { class: 'sub__last' }, h('time', { 'data-kind': 'moved', 'data-since': p.lastActivityAt, text: '' })),
      ),
      h('span', { class: 'sub__tally' }),
    ),
    h('div', { class: 'disclose', id: `s-${g.reason}-${p.key}` }, h('div', { class: 'disclose__in' }, h('div', { class: 'sub__rows' }), h('p', { class: 'group__more' }))),
  );
}

/**
 * 片付けの欄。
 * @param {HTMLElement} section @param {any} visible ui-state の visibleModel @param {RowCtx & {pages: Record<string, number>, batchOpen: boolean}} ctx
 */
export function renderCleanup(section, visible, ctx) {
  const t = ctx.t;
  const board = ctx.board;
  const groups = visible.cleanupGroups;
  section.hidden = ctx.filtering && groups.length === 0;
  if (section.hidden) return;
  const open = ctx.prefs.open?.cleanup ?? true;
  const btn = /** @type {HTMLElement} */ (section.querySelector('.pile__toggle'));
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  const count = visible.counts.cleanup;
  const n = ctx.filtering && !open ? t('bucket.match', { n: count }) : String(count);
  fill(btn, h('span', { class: 'chev', 'aria-hidden': 'true' }), h('span', { class: 'pile__name', text: bucketTitle(t, 'cleanup') }), ' ', h('span', { class: 'pile__n', text: n }));
  fill(/** @type {HTMLElement} */ (section.querySelector('.pile__verb')), t('bucket.cleanup.verb'));
  const body = /** @type {HTMLElement} */ (section.querySelector('#r-cleanup'));
  setDisclosed(body, open);
  const top = /** @type {HTMLElement} */ (body.querySelector('.tidy__top'));
  const suspect = board?.stats?.formatSuspect ?? null;
  const rec = Number(board?.counts?.recommended) || 0;
  const active = Number(board?.counts?.active) || 0;
  const step = stepOf(ctx.selected.size, ctx.batchOpen);
  const stepItem = (/** @type {number} */ i) =>
    h('li', { class: i === step ? 'is-now' : i < step ? 'is-done' : null }, h('span', { class: 'steps__n', text: String(i) }), t(`cleanup.step${i}`), i === step ? h('span', { class: 'vh', text: t('cleanup.stepNow') }) : i < step ? h('span', { class: 'vh', text: t('cleanup.stepDone') }) : null);
  const allIds = suggestedIds(board);
  const sigTop = [t.lang, suspect, rec, active, step, checkState(allIds, ctx.selected), allIds.filter((id) => ctx.selected.has(id)).length].join('|');
  if (top.dataset.sig !== sigTop) {
    top.dataset.sig = sigTop;
    const allBox = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', 'data-action': 'select-all' }));
    fill(
      top,
      suspect ? h('p', { class: 'banner' }, h('b', { text: t('banner.format.lead') }), ' ', t(`banner.format.${suspect}`)) : null,
      !suspect && rec > 0 ? h('p', { class: 'tidy__ba' }, ...partsToNodes(t.parts('cleanup.ba', { all: h('b', { text: String(active) }), left: h('b', { text: String(active - rec) }) }))) : null,
      h('ol', { class: 'steps', 'aria-label': t('cleanup.steps.aria') }, stepItem(1), stepItem(2), stepItem(3)),
      h('p', { class: 'tidy__why', text: t('cleanup.why') }),
      !suspect && rec > 0
        ? h('div', { class: 'tidy__all' }, h('label', { class: 'check' }, allBox, h('span', { text: t('cleanup.selectAll', { n: rec }) })), tally(t, allIds.filter((id) => ctx.selected.has(id)).length, allIds.length), h('p', { class: 'tidy__def', text: t('cleanup.def') }))
        : null,
    );
    setCheck(allBox, checkState(allIds, ctx.selected));
  }
  const list = /** @type {HTMLElement} */ (body.querySelector('.tidy__groups'));
  fill(/** @type {HTMLElement} */ (body.querySelector('.tidy__empty')), groups.length ? null : h('p', { class: 'pile__empty', text: t('cleanup.empty') }));
  reconcile(
    list,
    groups,
    (g) => g.reason,
    (g) => `${t.lang}|${g.reason}|${suggestedOf(groupCards(g)).length > 0}|${!!g.projects}`,
    (g) => groupShell(g, t, suggestedOf(groupCards(g)).length > 0),
  );
  for (const el of /** @type {HTMLElement[]} */ ([...list.children])) {
    const g = groups.find((x) => x.reason === el.dataset.key);
    if (g) updateGroup(el, g, ctx);
  }
}

/** @param {HTMLElement} el @param {any} g @param {RowCtx & {pages: Record<string, number>}} ctx */
function updateGroup(el, g, ctx) {
  const t = ctx.t;
  const cards = groupCards(g);
  const all = idsOf(cards);
  const picked = all.filter((id) => ctx.selected.has(id)).length;
  const box = /** @type {HTMLInputElement|null} */ (el.querySelector('input[data-action="pick-group"]'));
  if (box) setCheck(box, groupState(suggestedOf(cards), all, ctx.selected));
  fill(/** @type {HTMLElement} */ (el.querySelector('.group__tally')), tally(t, picked, all.length));
  const bodyEl = /** @type {HTMLElement} */ (el.querySelector('.group__body'));
  const more = /** @type {HTMLElement} */ (el.querySelector(':scope > .group__more'));
  if (!g.projects) {
    if (bodyEl.querySelector('.sub')) fill(bodyEl);
    renderTrows(bodyEl, more, g.items, `g:${g.reason}`, ctx, oneProjectOf(g));
    return;
  }
  fill(more);
  if (bodyEl.querySelector('.slot')) fill(bodyEl);
  reconcile(bodyEl, g.projects, (p) => p.key, (p) => `${t.lang}|${p.label ?? ''}|${p.recommendedCount > 0}`, (p) => subShell(g, p, t));
  for (const sub of /** @type {HTMLElement[]} */ ([...bodyEl.children])) {
    const p = g.projects.find((/** @type {any} */ x) => x.key === sub.dataset.key);
    if (!p) continue;
    const key = `sub:${g.reason}:${p.key}`;
    const open = ctx.filtering || !!ctx.prefs.open?.[key];
    const ids = idsOf(p.items);
    const n = ids.filter((id) => ctx.selected.has(id)).length;
    const sbox = /** @type {HTMLInputElement|null} */ (sub.querySelector('input.sub__check'));
    if (sbox) setCheck(sbox, groupState(suggestedOf(p.items), ids, ctx.selected));
    sub.querySelector('.sub__toggle')?.setAttribute('aria-expanded', open ? 'true' : 'false');
    const last = /** @type {HTMLElement} */ (sub.querySelector('.sub__last time'));
    last.dataset.since = String(p.lastActivityAt);
    last.textContent = timeText(t, 'moved', p.lastActivityAt, ctx.now);
    const tl = /** @type {HTMLElement} */ (sub.querySelector('.sub__tally'));
    tl.classList.toggle('is-held', !open && n > 0);
    fill(tl, tally(t, n, ids.length));
    const wrap = /** @type {HTMLElement} */ (sub.querySelector('.disclose'));
    setDisclosed(wrap, open);
    if (open || wrap.querySelector('.slot')) renderTrows(/** @type {HTMLElement} */ (sub.querySelector('.sub__rows')), /** @type {HTMLElement} */ (sub.querySelector('.disclose__in > .group__more')), p.items, key, ctx, true);
  }
}

/**
 * 選んだのに今は見えていない件数 (純粋)。closed = 閉じた欄・サブグループの中、filtered = 絞り込みで隠れている。
 * 絞り込み中のサブグループは開いている (updateGroup と同じ) ので closed に数えない。
 * @param {any} board @param {Set<string>} selected @param {any} prefs @param {any} [visible] ui-state の visibleModel
 * @returns {{closed: number, filtered: number}}
 */
export function hiddenPicks(board, selected, prefs, visible = null) {
  const pileOpen = prefs.open?.cleanup ?? true;
  const filtering = !!visible?.filtering;
  const shown = filtering ? new Set(idsOf((visible.cleanupGroups ?? []).flatMap(groupCards))) : null;
  let closed = 0;
  let filtered = 0;
  for (const g of board?.cleanupGroups ?? []) {
    const parts = g.projects ? g.projects.map((/** @type {any} */ p) => ({ items: p.items ?? [], sub: `sub:${g.reason}:${p.key}` })) : [{ items: g.items ?? [], sub: '' }];
    for (const { items, sub } of parts) {
      for (const id of idsOf(items)) {
        if (!selected.has(id)) continue;
        if (shown && !shown.has(id)) filtered++;
        else if (!pileOpen || (sub && !filtering && !prefs.open?.[sub])) closed++;
      }
    }
  }
  return { closed, filtered };
}

/**
 * 下に貼り付く帯。
 * @param {HTMLElement} el
 * @param {{t: T, now: number, board: any, visible?: any, selected: Set<string>, copied: Set<string>, batch: any, progress: any, copiedUntil: number, local: number, prefs: any, today: number, wide: boolean}} o
 */
export function renderSelbar(el, o) {
  const t = o.t;
  const mode = selbarMode(o.selected.size, o.progress);
  el.hidden = mode === 'none';
  if (mode === 'none') {
    el.dataset.sig = '';
    return;
  }
  const active = Number(o.board?.counts?.active) || 0;
  const sel = [...o.selected];
  const plan = planCopy(sel, o.copied, COPY_CHUNK);
  const flash = o.copiedUntil > o.local;
  const p = o.progress ?? { total: 0, done: 0, left: 0 };
  const s = POLL_MS / SEC;
  const hidden = hiddenPicks(o.board, o.selected, o.prefs, o.visible);
  const demo = !!o.board?.stats?.demo;
  const keysOn = o.prefs.keys !== false;
  // 選び直すのは片付けの欄に残っている ID だけ (別の欄へ移ったものは数えない)
  const again = o.batch ? reselectIds(o.batch.ids, cleanupIds(o.board)).length : 0;
  const sig = [t.lang, mode, sel.length, plan.from, plan.to, plan.restart, flash, p.total, p.done, active, hidden.closed, hidden.filtered, again, demo, keysOn, o.today, o.batch?.text?.length ?? 0].join('|');
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  const details = /** @type {HTMLDetailsElement|null} */ (el.querySelector('details'));
  const detailsOpen = details ? details.open : o.wide;
  const copyBtn = (/** @type {string} */ cls) => {
    if (flash) return h('button', { class: `btn ${cls}`, type: 'button', 'data-action': 'copy', text: t('sel.copiedBtn') });
    const label = plan.restart && o.batch ? t('sel.copyAgain') : o.batch ? t('sel.copyNext', { k: plan.chunk.length, from: plan.from, to: plan.to }) : sel.length > COPY_CHUNK ? t('sel.copyRange', { from: plan.from, to: plan.to, n: sel.length }) : t('sel.copy');
    // c の印は見た目の手掛かりだけ (名前には入れない)。1 文字キーを止めているときは CSS で隠す
    const kbd = !o.batch ? h('kbd', { class: 'hk', 'aria-hidden': 'true', text: 'c' }) : null;
    return h('button', { class: `btn ${cls}`, type: 'button', 'data-action': 'copy', 'aria-keyshortcuts': kbd && keysOn ? 'c' : null }, label, kbd ? ' ' : null, kbd);
  };
  const demoNote = demo ? h('p', { class: 'selbar__note', text: t('sel.demo') }) : null;
  const copiedText = () => {
    const lines = String(o.batch?.text ?? '').split('\n');
    const head = lines.slice(0, 4);
    const rest = lines.length - head.length;
    const pre = h('pre', {}, [...head, rest > 0 ? t('sel.moreLines', { n: rest }) : null].filter((x) => x != null).join('\n'));
    return h('details', { class: 'selbar__copied', open: detailsOpen }, h('summary', { text: t('sel.copiedText') }), pre);
  };
  const clear = h('button', { class: 'textbtn', type: 'button', 'data-action': 'clear-selection', text: t('sel.clear') });
  const close = h('button', { class: 'textbtn', type: 'button', 'data-action': 'close-batch', text: t('sel.close') });
  /** @type {Array<Node|null>} */
  let parts = [];
  if (mode === 'picked') {
    const note = sentences(t, hidden.closed > 0 ? t('sel.hidden', { h: hidden.closed }) : '', hidden.filtered > 0 ? t('sel.filtered', { h: hidden.filtered }) : '', t('sel.sum', { all: active, left: Math.max(0, active - sel.length) }));
    parts = [h('p', { class: 'selbar__lead', text: t('sel.count', { n: sel.length }) }), h('div', { class: 'selbar__acts' }, copyBtn('btn--ink'), clear), h('p', { class: 'selbar__note', text: note }), h('p', { class: 'selbar__how', text: t('sel.how') })];
  } else if (mode === 'copied') {
    parts = [
      h('p', { class: 'selbar__lead', text: t('sel.paste') }),
      h('div', { class: 'selbar__acts' }, copyBtn('btn--line')),
      h('div', { class: 'selbar__prog' }, h('p', { text: `${t('sel.progress', { done: p.done, total: p.total })}${t('sep.sentence')}${t('sel.checkingZero', { s })}` })),
      copiedText(),
      demoNote,
      h('p', { class: 'selbar__note', text: t('sel.permission') }),
    ];
  } else if (mode === 'progress') {
    parts = [
      h('p', { class: 'selbar__lead', text: t('sel.progress', { done: p.done, total: p.total }) }),
      h('div', { class: 'selbar__acts' }, copyBtn('btn--line')),
      h('div', { class: 'selbar__prog' }, h('p', { text: sentences(t, t('sel.checking', { left: p.left, s }), t('sel.now', { all: o.batch?.activeAtStart ?? active, now: active })) })),
      demoNote,
      h('p', { class: 'selbar__note', text: t('sel.permission') }),
      h('p', { class: 'selbar__how', text: t('sel.cantArchive') }),
    ];
  } else if (mode === 'done') {
    parts = [h('p', { class: 'selbar__lead', text: t('sel.done', { n: p.total }) }), h('div', { class: 'selbar__acts' }, close), h('p', { class: 'selbar__note', text: t('sel.doneSum', { all: o.batch?.activeAtStart ?? active, now: active, today: o.today }) })];
  } else {
    parts = [
      h('p', { class: 'selbar__lead', text: p.done > 0 ? t('sel.left', { done: p.done, left: p.left }) : t('sel.paste') }),
      h('div', { class: 'selbar__acts' }, again > 0 ? h('button', { class: 'btn btn--ink', type: 'button', 'data-action': 'reselect', text: t('sel.reselect', { n: again }) }) : null, close),
      h('p', { class: 'selbar__note', text: p.done > 0 ? t('sel.leftWhy') : t('sel.none') }),
      demoNote,
    ];
  }
  fill(el, ...parts);
  el.setAttribute('aria-label', t('sel.aria'));
}

/** 片付けの欄の器の中身 (index.html の #r-cleanup に一度だけ入れる)。 */
export function cleanupBodyParts() {
  return [h('div', { class: 'tidy__top' }), h('div', { class: 'tidy__groups' }), h('div', { class: 'tidy__empty' })];
}

// ---------- 選ぶ (チェックボックスとキー x / a) ----------

/** グループ・サブグループのチェック: 何も選んでいなければおすすめを選び、それ以外は全部外す。 @param {Card[]} cards */
function toggleGroup(cards) {
  const all = idsOf(cards);
  const sug = suggestedOf(cards);
  if (groupState(sug, all, state.selected) === 'off') pick(sug);
  else unpick(all);
}

/**
 * 片付けの欄のチェックボックスが変わったとき。扱ったら true。
 * グループとサブグループは、描いたのと同じ見え方 (絞り込み後) の行だけを選ぶ・外す。見えていない行には触らない。
 * @param {HTMLInputElement} el
 * @param {any} [visible] ui-state の visibleModel (無ければ盤面そのまま)
 */
export function applyPick(el, visible = null) {
  const groups = (visible ?? state.board)?.cleanupGroups ?? [];
  const action = el.dataset?.action;
  const group = () => groups.find((/** @type {any} */ x) => x.reason === el.dataset.reason);
  if (action === 'pick-row') {
    const ids = (el.closest('.trow')?.getAttribute('data-ids') ?? '').split(' ').filter(Boolean);
    if (el.checked) pick(ids);
    else unpick(ids);
  } else if (action === 'pick-group') {
    const g = group();
    if (g) toggleGroup(groupCards(g));
  } else if (action === 'pick-sub') {
    const p = group()?.projects?.find((/** @type {any} */ x) => x.key === el.dataset.key);
    if (p) toggleGroup(p.items);
  } else if (action === 'select-all') {
    const ids = suggestedIds(state.board);
    if (checkState(ids, state.selected) === 'off') pick(ids);
    else unpick(ids);
  } else return false;
  return true;
}

/**
 * キー x: カーソルの片付けの行を選ぶ / 外す (定期実行は全部の回をまとめて)。
 * @param {HTMLElement|null} row
 * @returns {'picked'|'unpicked'|false}
 */
export function togglePickRow(row) {
  if (!row || !row.classList.contains('trow')) return false;
  const ids = (row.dataset.ids ?? '').split(' ').filter(Boolean);
  if (ids.every((x) => state.selected.has(x))) {
    unpick(ids);
    return 'unpicked';
  }
  pick(ids);
  return 'picked';
}

/** キー a: おすすめを全部選ぶ (足すだけ)。形式が怪しいときは何もしない。選んだ数を返す。 */
export function pickAllSuggested() {
  if (state.board?.stats?.formatSuspect) return 0;
  const ids = suggestedIds(state.board);
  pick(ids);
  return ids.length;
}
