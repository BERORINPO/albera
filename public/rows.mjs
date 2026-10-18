// @ts-check
// 画面: 返事待ち・止まったかも・未読・作業中・最近の行と、行の「詳しく」(親子の木を含む)。
// 行は ID ごとに使い回し、署名が変わったものだけ作り直す。カーソル・開閉・選択は作り直さずに syncRow で合わせる。

import { MAX_PR_BADGES, MAX_PRS, PREVIEW, RECENT_MS, DAY } from '../src/shared/constants.mjs';
import {
  askText, bucketTitle, cardTime, childrenText, contentLang, createdText, dayKey, deepLink, isOtherProject, prLabel, projectLabel,
  prStateWord, quietHint, reasonLine, routineFlaky, routineHistory, spansRepos, timeText, titleOf,
} from './format.mjs';
import { familyTree } from './ui-state.mjs';
import { fill, h, partsToNodes, reconcile, setDisclosed } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */
/** @typedef {Record<string, any>} Card */
/**
 * @typedef {Object} RowCtx
 * @property {T} t
 * @property {number} now
 * @property {any} board
 * @property {Map<string, {card: Card, pile: string}>} index
 * @property {string|null} nextId
 * @property {string|null} cursorId
 * @property {Set<string>} open
 * @property {Set<string>} selected
 * @property {Set<string>} copied
 * @property {boolean} filtering
 * @property {any} prefs
 * @property {(pile: string, id: string) => boolean} isNew
 * @property {(pile: string, id: string) => boolean} takeArrival
 * @property {(el: HTMLElement) => boolean} leave
 */

/** 中身の言語が画面と違うときだけ lang を付ける。 @param {T} t @param {unknown} text */
export const langOf = (t, text) => {
  const l = contentLang(text);
  return l === t.lang ? null : l;
};

/** 時刻のセル。renderTimes が data-kind と data-since から書き直す。 @param {T} t @param {Card} card @param {number} now */
export function timeEl(t, card, now) {
  const { kind, since } = cardTime(card);
  const iso = Number.isFinite(since) && since > 0 ? new Date(since).toISOString() : null;
  return h('time', { datetime: iso, 'data-kind': kind, 'data-since': since, text: timeText(t, kind, since, now) });
}

/**
 * 「開く ↗」。ID の形が違えば開けないことを伝える (tab では止まる)。デモでは、開いてもアプリに本物が無いことを title で伝える。
 * @param {T} t @param {Card} card @param {string} [cls] @param {boolean} [demo]
 */
export function openEl(t, card, cls = 'row__open', demo = false) {
  const href = deepLink(card.id);
  const title = titleOf(t, card.title);
  if (!href) return h('a', { class: cls, role: 'link', tabindex: '0', 'aria-disabled': 'true', title: t('open.disabled'), text: t('open.row') });
  return h('a', { class: cls, href, 'data-action': 'open', 'data-id': card.id, 'aria-label': t('open.aria', { title }), title: t(demo ? 'open.demoTitle' : 'open.title'), text: t('open.row') });
}

/** 親子のリンク (押すとその親子だけ表示)。 @param {T} t @param {Card} card */
function familyLinks(t, card) {
  const f = card.family;
  if (!f) return [];
  const out = [];
  const link = (/** @type {string} */ text) =>
    f.rootId ? h('button', { class: 'link', type: 'button', 'data-action': 'family', 'data-root': f.rootId, title: t('family.filterTitle'), text }) : h('span', { text });
  if (f.parentId) {
    const name = f.parentTitle == null ? t('family.parentMissing') : f.parentTitle || t('untitled');
    out.push(link(t('family.parent', { name })));
  }
  if (f.children?.total > 0) out.push(link(childrenText(t, f.children)));
  return out;
}

/**
 * 行の下の小さな項目 (プロジェクト・親子・PR・定期実行・作業中の補足・新着・コピー済み)。
 * @param {T} t @param {Card} card @param {string} pile @param {RowCtx} ctx @param {{noProject?: boolean}} [o]
 */
export function metaItems(t, card, pile, ctx, o = {}) {
  const out = [];
  if (!o.noProject) {
    const other = isOtherProject(card.project);
    out.push(h('span', { class: other ? 'is-other' : null, title: other ? t('project.otherGloss') : null, text: projectLabel(t, card.project) }));
  }
  out.push(...familyLinks(t, card));
  const prs = card.prs ?? [];
  const multi = spansRepos(prs);
  for (const pr of prs.filter((/** @type {any} */ p) => p.state === 'OPEN').slice(0, MAX_PR_BADGES)) out.push(h('span', { text: prLabel(t, pr, multi) }));
  if (card.routine && pile !== 'cleanup') {
    out.push(h('span', { text: t('routine.runs', { n: card.routine.runs }) }));
    const flaky = routineFlaky(t, card.routine);
    if (flaky) out.push(h('span', { class: 'is-ink', text: flaky }));
  }
  if (pile === 'working' && (card.reason === 'background' || card.reason === 'starting')) out.push(h('span', { text: t(`reason.${card.reason}`) }));
  if (pile === 'working') {
    const hint = quietHint(t, card.since, ctx.now);
    out.push(h('span', { class: 'row__hint', 'data-hint-since': card.since, hidden: !hint, text: hint }));
  }
  if (ctx.isNew(pile, card.id)) out.push(h('span', { class: 'is-ink', text: t('badge.new') }));
  if (ctx.copied.has(card.id)) out.push(h('span', { class: 'is-ink', text: t('row.copied') }));
  return out;
}

/** 行の本文 (欄ごとに違う)。 @param {T} t @param {Card} card @param {string} pile */
function bodyEl(t, card, pile) {
  if (pile === 'working') return null;
  if (pile === 'needs_you') {
    if (card.body) return h('p', { class: 'row__body is-question' }, h('span', { class: 't' }, h('q', { lang: contentLang(card.body), text: card.body })));
    const ask = askText(t, card);
    return ask ? h('p', { class: 'row__body' }, h('span', { class: 't', text: ask })) : null;
  }
  const text = pile === 'trouble' ? reasonLine(t, card) : card.body;
  if (!text) return null;
  return h('p', { class: 'row__body' }, h('span', { class: 't', lang: langOf(t, text), text }));
}

/** 行の署名 (これが変わったときだけ作り直す)。 @param {Card} card @param {string} pile @param {RowCtx} ctx @param {string} [extra] */
export function rowSig(card, pile, ctx, extra = '') {
  const flags = [ctx.nextId === card.id ? 'next' : '', ctx.isNew(pile, card.id) ? 'new' : '', ctx.copied.has(card.id) ? 'copied' : '', extra].join(',');
  return `${ctx.t.lang}|${pile}|${JSON.stringify(card)}|${flags}`;
}

/** 開閉の器と、中身を作る関数。 @param {string} id */
const detailShell = (id) => {
  const wrap = h('div', { class: 'row__detail disclose', id: `d-${id}` }, h('div', { class: 'disclose__in' }));
  setDisclosed(wrap, false);
  return wrap;
};

/**
 * 行 (li.slot > div.row) を作る。
 * @param {Card} card @param {string} pile @param {RowCtx} ctx @param {{noProject?: boolean}} [o]
 */
export function rowEl(card, pile, ctx, o = {}) {
  const t = ctx.t;
  const title = titleOf(t, card.title);
  const isNext = ctx.nextId === card.id && pile !== 'recent';
  const arrive = ctx.takeArrival(pile, card.id);
  const row = h(
    'div',
    { class: `row${isNext ? ' is-next' : ''}${arrive ? ' is-new' : ''}`, 'data-id': card.id, 'data-pile': pile },
    h('span', { class: 'row__mark', 'aria-hidden': 'true' }),
    h(
      'button',
      { class: 'row__title', type: 'button', 'aria-expanded': 'false', 'aria-controls': `d-${card.id}`, 'aria-describedby': 'title-keys', 'data-action': 'toggle', 'data-id': card.id },
      h('span', { class: 't', lang: langOf(t, card.title) }, title, h('span', { class: 'chev', 'aria-hidden': 'true' })),
    ),
    h('span', { class: 'row__time' }, timeEl(t, card, ctx.now)),
    bodyEl(t, card, pile),
    h('p', { class: 'row__meta' }, ...metaItems(t, card, pile, ctx, o)),
    openEl(t, card, 'row__open', !!ctx.board?.stats?.demo),
    detailShell(card.id),
  );
  return h('li', { class: 'slot' }, row);
}

/** カーソル・開閉・選択を、作り直さずに合わせる。 @param {HTMLElement} slot @param {RowCtx} ctx @param {(id: string) => HTMLElement} [buildDetail] */
export function syncRow(slot, ctx, buildDetail) {
  const row = /** @type {HTMLElement|null} */ (slot.firstElementChild);
  if (!row) return;
  const id = row.dataset.id ?? '';
  row.classList.toggle('is-cursor', ctx.cursorId === id);
  const picked = ctx.selected.has(id) || (row.dataset.ids ? row.dataset.ids.split(' ').every((x) => ctx.selected.has(x)) : false);
  if (row.classList.contains('trow')) {
    row.classList.toggle('is-picked', picked);
    const box = /** @type {HTMLInputElement|null} */ (row.querySelector('input[data-action="pick-row"]'));
    if (box && box.checked !== picked) box.checked = picked;
  }
  const open = ctx.open.has(id);
  const btn = row.querySelector('[data-action="toggle"]');
  btn?.setAttribute('aria-expanded', open ? 'true' : 'false');
  row.classList.toggle('is-open', open);
  const wrap = /** @type {HTMLElement|null} */ (row.querySelector('.row__detail'));
  if (!wrap) return;
  // 詳しくは最初に開いたときに作る。行のカードが変われば行ごと作り直される。ここで見るのは、行の外で詳しくに効くもの
  // (親子の木の顔ぶれと欄・「今日」の日付・言語) だけ。ほかのカードが変わっただけでは作り直さない (手で選んだ文字を消さない)。
  // 時刻は time[data-kind] なので renderTimes が書き直す。
  const stamp = detailStamp(ctx, id);
  if (open && wrap.dataset.built !== stamp && buildDetail) {
    fill(/** @type {HTMLElement} */ (wrap.firstElementChild), buildDetail(id));
    wrap.dataset.built = stamp;
  }
  setDisclosed(wrap, open);
}

/**
 * 詳しくを作り直すかの印: 言語・今日の日付・親子の木に出るもの (各メンバーの欄・題名・作成・親)。
 * @param {RowCtx} ctx @param {string} id
 */
export function detailStamp(ctx, id) {
  const card = ctx.index.get(id)?.card;
  const rootId = card?.family?.rootId;
  let fam = '';
  if (rootId) {
    const f = ctx.board?.families?.[rootId];
    const members = (f?.memberIds ?? []).map((/** @type {string} */ m) => {
      const e = ctx.index.get(m);
      return e ? `${e.card.id}:${e.pile}:${e.card.title}:${e.card.createdAt}:${e.card.family?.parentId ?? ''}` : `-${m}`;
    });
    fam = `${f?.title ?? ''}|${members.join(',')}`;
  }
  return `${ctx.t.lang}|${dayKey(ctx.now)}|${fam}`;
}

/** @param {string} label @param {Node|string|null} value @param {string} [cls] */
function dlRow(label, value, cls) {
  if (value == null || value === '') return [];
  return [h('dt', { text: label }), h('dd', { class: cls ?? null }, value)];
}

/**
 * 親子の木 (ul.tree)。自分は太字と「← これ」、他の人は押すとその行へ移る。
 * @param {T} t @param {Card} card @param {RowCtx} ctx
 */
export function familyTreeEl(t, card, ctx) {
  const rootId = card.family?.rootId;
  if (!rootId) return null;
  const tree = familyTree(ctx.board, ctx.index, rootId, card.id);
  if (!tree || !tree.roots.length) return null;
  /** @param {any} n @returns {HTMLElement} */
  const node = (n) => {
    const title = titleOf(t, n.title);
    const name = n.self
      ? h('span', { class: 'tree__t' }, h('span', { lang: langOf(t, n.title), text: title }), ' ', h('span', { class: 'tree__self', text: t('detail.self') }))
      : h('button', { class: 'tree__t link', type: 'button', 'data-action': 'jump-to', 'data-id': n.id, lang: langOf(t, n.title), text: title });
    return h(
      'li',
      { class: n.self ? 'is-self' : null },
      h('div', { class: 'tree__row' }, name, h('span', { class: 'tree__p', text: bucketTitle(t, n.pile) })),
      n.children.length ? h('ul', {}, ...n.children.map(node)) : null,
    );
  };
  const rootTitle = titleOf(t, ctx.board?.families?.[rootId]?.title);
  return h(
    'div',
    {},
    h('ul', { class: 'tree', 'aria-label': t('detail.relatedAria', { title: rootTitle }) }, ...tree.roots.map(node)),
    tree.more > 0 ? h('p', { class: 'tree__more', text: t('detail.treeMore', { n: tree.more }) }) : null,
  );
}

/**
 * 「詳しく」の中身。
 * @param {Card} card @param {string} pile @param {RowCtx} ctx
 */
export function detailEl(card, pile, ctx) {
  const t = ctx.t;
  const d = card.detail ?? {};
  const prs = (card.prs ?? []).slice().sort((/** @type {any} */ a, /** @type {any} */ b) => (a.state === 'OPEN' ? 0 : 1) - (b.state === 'OPEN' ? 0 : 1)).slice(0, MAX_PRS);
  const prList = prs.length
    ? h(
        'ul',
        { class: 'detail__prs' },
        ...prs.map((/** @type {any} */ pr) => {
          const text = t('pr.detail', { num: pr.num, repo: pr.repo, state: prStateWord(t, pr.state) });
          return h('li', {}, pr.url ? h('a', { href: pr.url, target: '_blank', rel: 'noopener noreferrer', text }) : text);
        }),
        Number(d.prsMore) > 0 ? h('li', { text: t('pr.more', { n: d.prsMore }) }) : null,
      )
    : null;
  const routine = card.routine ? [routineHistory(t, card.routine), routineFlaky(t, card.routine)].filter(Boolean).join(t('sep.sentence')) : '';
  const fam = familyTreeEl(t, card, ctx);
  const actions = [
    pile === 'cleanup' ? openEl(t, card, 'textbtn', !!ctx.board?.stats?.demo) : null,
    card.family?.rootId ? h('button', { class: 'textbtn', type: 'button', 'data-action': 'family', 'data-root': card.family.rootId, text: t('detail.familyOnly') }) : null,
    h('button', { class: 'textbtn', type: 'button', 'data-action': 'copy-id', 'data-id': card.id, text: t('detail.copyId') }),
    deepLink(card.id) ? h('button', { class: 'textbtn', type: 'button', 'data-action': 'copy-link', 'data-id': card.id, text: t('detail.copyLink') }) : null,
  ];
  return h(
    'div',
    { class: 'detail__in' },
    h(
      'dl',
      {},
      ...dlRow(t('detail.state'), h('span', {}, ...partsToNodes(t.parts('detail.stateValue', { pile: bucketTitle(t, pile), time: timeEl(t, card, ctx.now) })))),
      ...dlRow(t('detail.summary'), d.statusDetail ? h('q', { lang: contentLang(d.statusDetail), text: d.statusDetail }) : null),
      ...dlRow(t('detail.error'), d.error ? h('span', { class: 'pre', lang: langOf(t, d.error), text: d.error }) : null),
      ...dlRow(t('detail.branch'), d.branch ?? null, 'path'),
      ...dlRow(t('detail.worktree'), d.worktreeName ?? null, 'path'),
      ...dlRow(t('detail.folder'), d.cwd ?? null, 'path'),
      ...dlRow(t('detail.created'), createdText(t, card.createdAt, ctx.now)),
      ...dlRow(t('detail.turns'), Number(d.completedTurns) > 0 ? t('detail.turnsValue', { n: d.completedTurns }) : null),
      ...dlRow(t('detail.routine'), routine || null),
      ...dlRow(t('detail.pr'), prList),
      ...dlRow(t('detail.related'), fam),
    ),
    h('p', { class: 'detail__acts' }, ...actions),
  );
}

/**
 * 「残り N 件を表示」と「最初の N 件だけ表示」。
 * @param {T} t @param {string} list @param {number} total @param {number} preview @param {boolean} expanded
 */
function moreButton(t, list, total, preview, expanded) {
  if (total <= preview) return null;
  const text = expanded ? t('list.less', { n: preview }) : t('list.more', { n: total - preview });
  return h('button', { class: 'textbtn list__more', type: 'button', 'data-action': 'more', 'data-list': list, 'aria-expanded': expanded ? 'true' : 'false', text });
}

/**
 * 行の一覧を ol に並べる (表示件数の制限つき)。
 * @param {HTMLElement} ol @param {HTMLElement} moreBox @param {Card[]} cards @param {string} pile @param {string} list @param {number} preview @param {RowCtx} ctx @param {{noProject?: boolean}} [o]
 */
export function renderRows(ol, moreBox, cards, pile, list, preview, ctx, o = {}) {
  const expanded = ctx.filtering || !!ctx.prefs.more?.[list];
  const shown = expanded ? cards : cards.slice(0, preview);
  reconcile(ol, shown, (c) => c.id, (c) => rowSig(c, pile, ctx, o.noProject ? 'np' : ''), (c) => rowEl(c, pile, ctx, o), ctx.leave);
  for (const slot of /** @type {HTMLElement[]} */ ([...ol.children])) syncRow(slot, ctx, (id) => detailEl(/** @type {Card} */ (ctx.index.get(id)?.card ?? cards.find((c) => c.id === id)), pile, ctx));
  fill(moreBox, ctx.filtering ? null : moreButton(ctx.t, list, cards.length, preview, expanded));
}

/**
 * 返事待ち・止まったかも・未読・作業中。空なら欄ごと隠す (台帳には 0 と出る)。
 * @param {HTMLElement} section @param {string} pile @param {Card[]} cards @param {RowCtx} ctx
 */
export function renderPile(section, pile, cards, ctx) {
  section.hidden = cards.length === 0;
  if (section.hidden) return;
  const t = ctx.t;
  const head = /** @type {HTMLElement} */ (section.querySelector('.pile__head'));
  fill(head, h('span', { class: 'pile__name', text: bucketTitle(t, pile) }), ' ', h('span', { class: 'pile__n', text: String(cards.length) }));
  fill(/** @type {HTMLElement} */ (section.querySelector('.pile__verb')), t(`bucket.${pile}.verb`));
  const preview = pile === 'unread' || pile === 'working' ? PREVIEW[pile] : Infinity;
  renderRows(/** @type {HTMLElement} */ (section.querySelector('.rows')), /** @type {HTMLElement} */ (section.querySelector('.pile__more')), cards, pile, pile, preview, ctx);
}

/** 読み込み中: 返事待ちの欄に罫線だけの空の行を 3 つ。 @param {HTMLElement} section @param {T} t */
export function renderLoadingPile(section, t) {
  section.hidden = false;
  fill(/** @type {HTMLElement} */ (section.querySelector('.pile__head')), h('span', { class: 'pile__name', text: bucketTitle(t, 'needs_you') }));
  fill(/** @type {HTMLElement} */ (section.querySelector('.pile__verb')), t('bucket.needs_you.verb'));
  const ol = /** @type {HTMLElement} */ (section.querySelector('.rows'));
  fill(ol, ...[0, 1, 2].map(() => h('li', { class: 'slot is-blank', 'aria-hidden': 'true' }, h('div', { class: 'row' }))));
  fill(/** @type {HTMLElement} */ (section.querySelector('.pile__more')));
}

/** 開閉できる欄の見出しのボタン (最近)。無ければ作る。 @param {HTMLElement} section @param {string} pile @param {boolean} open */
function toggleButton(section, pile, open) {
  const head = /** @type {HTMLElement} */ (section.querySelector('.pile__head'));
  let btn = /** @type {HTMLElement|null} */ (head.querySelector('.pile__toggle'));
  if (!btn) {
    btn = h('button', { class: 'pile__toggle', type: 'button', 'data-action': 'pile', 'data-pile': pile, 'aria-controls': `r-${pile}` });
    fill(head, btn);
  }
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  return btn;
}

/**
 * 最近。プロジェクトごと、閉じていれば各プロジェクトの件数だけ。
 * @param {HTMLElement} section @param {any[]} groups @param {number} count @param {RowCtx} ctx
 */
export function renderRecent(section, groups, count, ctx) {
  const t = ctx.t;
  section.hidden = ctx.filtering && groups.length === 0;
  if (section.hidden) return;
  const open = ctx.prefs.open?.recent ?? false;
  const btn = toggleButton(section, 'recent', open);
  const n = ctx.filtering && !open ? t('bucket.match', { n: count }) : String(count);
  fill(btn, h('span', { class: 'chev', 'aria-hidden': 'true' }), h('span', { class: 'pile__name', text: bucketTitle(t, 'recent') }), ' ', h('span', { class: 'pile__n', text: n }));
  const days = RECENT_MS / DAY;
  fill(/** @type {HTMLElement} */ (section.querySelector('.pile__verb')), t('bucket.recent.verb', { days }));
  const peek = /** @type {HTMLElement} */ (section.querySelector('.pile__peek'));
  peek.hidden = open || groups.length === 0;
  fill(peek, ...groups.map((g) => h('span', { class: g.label == null ? 'is-other' : null, text: `${g.label ?? t('project.other')} ${g.items.length}` })));
  const body = /** @type {HTMLElement} */ (section.querySelector('#r-recent'));
  setDisclosed(body, open);
  const inner = /** @type {HTMLElement} */ (body.firstElementChild);
  if (!groups.length) {
    fill(inner, h('p', { class: 'pile__empty', text: t('recent.empty', { days }) }));
    return;
  }
  if (inner.querySelector('.pile__empty')) fill(inner);
  reconcile(
    inner,
    groups,
    (g) => g.key,
    (g) => `${t.lang}|${g.label ?? ''}`,
    (g) =>
      h(
        'section',
        { class: 'rgroup', 'aria-label': g.label ?? t('project.other') },
        h('h3', { class: 'rgroup__head' }, h('span', { class: g.label == null ? 'is-other' : null, title: g.label == null ? t('project.otherGloss') : null, text: g.label ?? t('project.other') }), ' ', h('span', { class: 'rgroup__n' })),
        h('ol', { class: 'rows' }),
        h('p', { class: 'pile__more' }),
      ),
  );
  for (const el of /** @type {HTMLElement[]} */ ([...inner.children])) {
    const g = groups.find((x) => x.key === el.dataset.key);
    if (!g) continue;
    fill(/** @type {HTMLElement} */ (el.querySelector('.rgroup__n')), String(g.items.length));
    renderRows(/** @type {HTMLElement} */ (el.querySelector('.rows')), /** @type {HTMLElement} */ (el.querySelector('.pile__more')), g.items, 'recent', `recent:${g.key}`, PREVIEW.recentGroup, ctx, { noProject: true });
  }
}
