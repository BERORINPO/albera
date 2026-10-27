// @ts-check
// 画面: 最初の 3 秒 (lede)・件数の台帳・お知らせの帯・最初の 1 回の読み方。
// ledeState は純粋関数。lede は「次の 1 件」だけを言い、台帳の数字を繰り返さない。

import { DAY, MIN, QUIET_MS, RECENT_MS } from '../src/shared/constants.mjs';
import { agoText, askText, bucketTitle, contentLang, deepLink, ledeTimeLine, reasonLine, sentences, titleOf } from './format.mjs';
import { dueIds } from './handoff.mjs';
import { nextUp, PILES } from './ui-state.mjs';
import { fill, h, partsToNodes } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */

const LONG_TITLE = 40;

/**
 * lede がどの状態か (純粋)。
 * @param {{board: any, loading: boolean, fail: null|'offline'|'server'|'version'|'render'}} s
 * @returns {'loading'|'offline'|'server'|'version'|'render'|'empty'|'busy'|'stuck'|'unread'|'quiet'}
 */
export function ledeState(s) {
  if (!s.board) {
    if (s.fail) return s.fail;
    return 'loading';
  }
  const c = s.board.counts ?? {};
  if ((Number(c.active) || 0) === 0) return 'empty';
  const next = nextUp(s.board);
  if (!next) return 'quiet';
  return next.pile === 'needs_you' ? 'busy' : next.pile === 'trouble' ? 'stuck' : 'unread';
}

/**
 * 「開く Enter」(ページでただ 1 つの塗りのボタン)。Enter の印は見た目の手掛かりだけ (名前には入れず aria-keyshortcuts で伝える)。
 * @param {T} t @param {string} id @param {boolean} demo
 */
function ledeOpen(t, id, demo) {
  const href = deepLink(id);
  const kids = [t('open.text'), ' ', h('kbd', { 'aria-hidden': 'true', text: 'Enter' })];
  if (!href) return h('a', { class: 'btn btn--fill', role: 'link', tabindex: '0', 'aria-disabled': 'true', title: t('open.disabled') }, ...kids);
  return h('a', { class: 'btn btn--fill', href, 'data-action': 'open', 'data-id': id, 'aria-keyshortcuts': 'Enter', title: t(demo ? 'open.demoTitle' : 'open.title') }, ...kids);
}

/**
 * lede を描く。
 * @param {HTMLElement} el #lede
 * @param {{t: T, now: number, board: any, loading: boolean, fail: any, calmSince: string|null}} o
 */
export function renderLede(el, o) {
  const t = o.t;
  const st = ledeState(o);
  const next = o.board ? nextUp(o.board) : null;
  const c = o.board?.counts ?? {};
  const sig = [t.lang, st, next?.card.id, next?.card.title, next?.card.body, next?.card.since, c.needs_you, c.trouble, c.unread, c.working, c.cleanup, c.recommended, o.calmSince, Math.floor(o.now / MIN)].join('|');
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.className = 'lede';
  /** @param {string} key @param {Record<string, unknown>} [p] */
  const title = (key, p) => h('h1', { class: 'lede__title' }, ...partsToNodes(t.parts(key, p)));
  /** @param {string} text */
  const note = (text) => h('p', { class: 'lede__q is-note', text });
  if (st === 'loading') return void fill(el, title('lede.loading'), note(t('lede.loadingNote')));
  if (st === 'empty') return void fill(el, title('lede.empty'), note(t('lede.emptyNote')));
  if (st === 'server') return void fill(el, title('lede.serverError'), note(t('lede.serverErrorNote')));
  // 版が違う・描けなかったときは帯が言うので、lede は空にする (見出しは読み上げ用に 1 つだけ残す)
  if (st === 'version' || st === 'render') return void fill(el, h('h1', { class: 'vh', text: t(`banner.${st}.lead`) }));
  if (st === 'offline') return void fill(el, title('lede.offline'), h('p', { class: 'lede__q is-note' }, ...partsToNodes(t.parts('lede.offlineNote', { cmd: h('code', { text: 'npx albera' }) }))));
  if (st === 'quiet' || !next) {
    const working = Number(c.working) || 0;
    const line = sentences(t, o.calmSince ? t('lede.calmSince', { time: o.calmSince }) : '', working > 0 ? t('lede.calmWorking', { n: working }) : t('lede.calmIdle'));
    const cleanup = Number(c.cleanup) || 0;
    return void fill(
      el,
      h('h1', { class: 'lede__title is-calm', text: t('lede.calm') }),
      h('p', { class: 'lede__q is-note', text: line }),
      cleanup > 0
        ? h('div', { class: 'lede__act' }, h('button', { class: 'btn btn--line', type: 'button', 'data-action': 'jump', 'data-pile': 'cleanup', text: t('lede.calmCleanupBtn') }), h('p', { class: 'lede__more', text: t('lede.calmCleanup', { n: cleanup, r: Number(c.recommended) || 0 }) }))
        : null,
    );
  }
  const { pile, card } = next;
  const name = titleOf(t, card.title);
  const titleSpan = h('span', { class: 'lede__name', lang: contentLang(name) === t.lang ? null : contentLang(name), text: name });
  el.classList.toggle('lede--long', [...name].length > LONG_TITLE);
  const key = pile === 'needs_you' ? 'lede.answer' : pile === 'trouble' ? 'lede.check' : 'lede.read';
  let quote = null;
  if (pile === 'needs_you') {
    if (card.body) quote = h('p', { class: 'lede__q' }, h('q', { lang: contentLang(card.body), text: card.body }));
    else if (askText(t, card)) quote = h('p', { class: 'lede__q is-ask', text: askText(t, card) });
  } else if (pile === 'trouble') {
    const r = reasonLine(t, card);
    if (r) quote = h('p', { class: 'lede__q', text: r });
  } else if (card.body) {
    quote = h('p', { class: 'lede__q is-clamp', lang: contentLang(card.body) === t.lang ? null : contentLang(card.body), text: card.body });
  }
  const more = (Number(c[pile]) || 0) - 1;
  fill(
    el,
    title(key, { title: titleSpan }),
    h('p', { class: 'lede__since', text: ledeTimeLine(t, pile, card, o.now) }),
    quote,
    h('div', { class: 'lede__act' }, ledeOpen(t, card.id, !!o.board?.stats?.demo), more > 0 ? h('p', { class: 'lede__more', text: t(`lede.more.${pile}`, { n: more }) }) : null),
  );
}

/**
 * 件数の台帳と、表示の切り替え (一覧 ⇄ キャンバス)。
 * @param {HTMLElement} nav #ledger @param {HTMLElement} toggle #view-toggle
 * @param {{t: T, board: any, visible: any, view?: 'list'|'canvas', keysOn?: boolean}} o
 */
export function renderLedger(nav, toggle, o) {
  const t = o.t;
  const c = o.board?.counts ?? null;
  const counts = o.visible?.counts ?? null;
  const filtering = !!o.visible?.filtering;
  const sig = [t.lang, JSON.stringify(counts), filtering, c?.active, c?.archived, o.visible?.total].join('|');
  if (nav.dataset.sig !== sig) {
    nav.dataset.sig = sig;
    nav.setAttribute('aria-label', t('ledger.aria'));
    const items = PILES.map((pile) => {
      const n = counts ? Number(counts[pile]) || 0 : null;
      const act = n != null && n > 0 && (pile === 'needs_you' || pile === 'trouble' || pile === 'unread');
      return h(
        'li',
        { class: act ? 'is-act' : n === 0 ? 'is-zero' : null },
        h('a', { href: `#p-${pile}`, 'data-action': 'jump', 'data-pile': pile }, h('span', { class: 'label', text: bucketTitle(t, pile) }), h('span', { class: 'dots', 'aria-hidden': 'true' }), h('span', { class: 'n', text: n == null ? '–' : String(n) })),
      );
    });
    const archived = Number(c?.archived) || 0;
    const total = !c
      ? null
      : filtering
        ? h('p', { class: 'index__total' }, h('span', { text: t('ledger.match', { m: o.visible.total, n: Number(c.active) || 0 }) }), h('span', { class: 'n' }))
        : h('p', { class: 'index__total' }, h('span', { text: archived > 0 ? t('ledger.total', { a: archived }) : t('ledger.totalNoArchived') }), h('span', { class: 'n', text: String(Number(c.active) || 0) }));
    fill(nav, h('ol', {}, ...items), total);
  }
  const label = t(o.view === 'canvas' ? 'view.list' : 'view.canvas');
  const keysOn = o.keysOn !== false;
  if (toggle.dataset.label !== `${t.lang}|${label}|${keysOn}`) {
    toggle.dataset.label = `${t.lang}|${label}|${keysOn}`;
    // v の印は見た目の手掛かりだけ。名前は label だけにして、キーは aria-keyshortcuts で伝える (1 文字キーを止めたら外す)
    fill(toggle, label, ' ', h('kbd', { class: 'hk', 'aria-hidden': 'true', text: 'v' }));
    if (keysOn) toggle.setAttribute('aria-keyshortcuts', 'v');
    else toggle.removeAttribute('aria-keyshortcuts');
  }
  // キャンバスからはいつでも一覧へ戻れる。一覧では、セッションがあるときだけ
  toggle.hidden = o.view !== 'canvas' && (!o.board || (Number(c?.active) || 0) === 0);
}

/**
 * お知らせの帯 (順番: 版 → 繋がらない → サーバー → 形式 → 親子 → 絞り込み → 一致なし)。
 * @param {HTMLElement} el #banners
 * @param {{t: T, now: number, board: any, fail: any, lastOk: number, visible: any, q: string, family: string|null}} o
 */
export function renderBanners(el, o) {
  const t = o.t;
  const ago = o.lastOk ? agoText(t, o.now - o.lastOk) : '';
  const sig = [t.lang, o.fail, !!o.board, ago, o.board?.stats?.formatSuspect, o.family, o.q, o.visible?.total, o.visible?.filtering].join('|');
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  /** @param {string} lead @param {string} text @param {Node|null} [ctl] */
  const banner = (lead, text, ctl = null) => h('p', { class: 'banner' }, h('b', { text: lead }), text ? `${t.lang === 'ja' ? '' : ' '}${text}` : null, ctl ? h('span', { class: 'banner__ctl' }, ctl) : null);
  const out = [];
  const reload = () => h('button', { class: 'btn btn--line', type: 'button', 'data-action': 'reload', text: t('banner.version.btn') });
  if (o.fail === 'version') out.push(banner(t('banner.version.lead'), t('banner.version.text'), reload()));
  if (o.fail === 'render') out.push(banner(t('banner.render.lead'), t('banner.render.text'), reload()));
  if (o.board && o.fail === 'offline') out.push(banner(t('banner.offline.lead'), t('banner.offline.text', { ago })));
  if (o.board && o.fail === 'server') out.push(banner(t('banner.server.lead'), t('banner.server.text', { ago })));
  const suspect = o.board?.stats?.formatSuspect;
  if (suspect) out.push(banner(t('banner.format.lead'), t(`banner.format.${suspect}`)));
  const v = o.visible;
  const none = v && v.filtering && v.total === 0;
  const clear = (/** @type {string} */ action) => h('button', { class: 'textbtn', type: 'button', 'data-action': action, text: t('banner.clear') });
  if (o.board && o.family) {
    const title = titleOf(t, o.board.families?.[o.family]?.title);
    out.push(h('p', { class: 'banner banner--filter' }, t('banner.family', { title }), ' ', clear('clear-family')));
  }
  if (o.board && o.q && !none) out.push(h('p', { class: 'banner banner--filter' }, t('banner.filter', { q: o.q, n: v?.total ?? 0 }), ' ', clear('clear-filter')));
  if (o.board && none) {
    const ctl = h('button', { class: 'btn btn--line', type: 'button', 'data-action': 'clear-filters', 'aria-keyshortcuts': 'Escape' }, t('nomatch.clear'), ' ', h('kbd', { 'aria-hidden': 'true', text: 'Esc' }));
    out.push(o.q ? banner(t('nomatch.query.lead', { q: o.q }), t('nomatch.query.text'), ctl) : banner(t('nomatch.family'), '', ctl));
  }
  fill(el, ...out);
}

/**
 * 最初の 1 回だけの読み方。保存できない環境では出さない (help にいつもある)。
 * 最近の上に 1 行だけ: 押すとその場で 6 つの欄の意味が開く (details なので処理も動きも要らない)。「わかった」で以後は出さない。
 * 開いていない間は台帳と同じ欄の名前を繰り返さず、最近と片付けを下へ押し出さない。
 * @param {HTMLElement} el #intro
 * @param {{t: T, show: boolean}} o
 */
export function renderIntro(el, o) {
  const t = o.t;
  el.hidden = !o.show;
  if (!o.show) return void fill(el);
  const sig = t.lang;
  if (el.dataset.sig === sig && el.firstChild) return;
  el.dataset.sig = sig;
  const days = RECENT_MS / DAY;
  fill(
    el,
    h(
      'details',
      { class: 'intro' },
      h('summary', { class: 'textbtn intro__sum' }, h('span', { class: 'chev', 'aria-hidden': 'true' }), h('span', { text: t('intro.title') })),
      h(
        'div',
        { class: 'legend' },
        h('ol', {}, ...PILES.map((p) => h('li', {}, h('b', { text: bucketTitle(t, p) }), h('span', { text: t(`intro.${p}`, { min: QUIET_MS / MIN, days }) })))),
        h('p', { class: 'tidy__why', text: t('intro.trust') }),
      ),
    ),
    h('button', { class: 'textbtn intro__ok', type: 'button', 'data-action': 'intro-ok', text: t('intro.ok') }),
  );
}

/**
 * 台帳の下の「引き継ぎどき N 件」(片付け以外で due / soon のセッションがあるときだけ)。押すたびにカーソルが次の 1 件へ移る。
 * 色も台帳の数も帯も付けない (埋まったセッションは返事待ちのような急ぎではない)。
 * @param {HTMLElement} btn #due-next @param {T} t @param {any} board
 */
export function renderDue(btn, t, board) {
  const n = board ? dueIds(board).length : 0;
  btn.hidden = n === 0;
  const text = n > 0 ? t('ctx.dueCount', { n }) : '';
  if (btn.textContent !== text) btn.textContent = text;
}

/** 一覧の lede は 3 行、キャンバスの帯の lede は 2 行まで (design.md §4、§12) */
const LEDE_LINES = Object.freeze({ list: 3, canvas: 2 });
/** @type {ResizeObserver|null} */
let ledeObserver = null;

/**
 * lede の文を決めた行数に収める: 長い題名だけを (code point で) 縮めて「…」を付け、前後の決まった言葉 (まず … に答える) はいつも見せる。
 * 行の CSS の打ち切りでは末尾の言葉から消えるため。縮めたときは見出しの名前 (aria-label) に元の文を入れる。幅と題名が同じなら何もしない。
 * @param {HTMLElement} el #lede @param {number} lines
 */
export function fitLede(el, lines) {
  const h1 = /** @type {HTMLElement|null} */ (el.querySelector('h1.lede__title'));
  const name = /** @type {HTMLElement|null} */ (h1?.querySelector('.lede__name') ?? null);
  if (!h1 || !name || !h1.clientWidth) return;
  const full = name.dataset.full ?? name.textContent ?? '';
  const key = `${lines}|${h1.clientWidth}|${full}`;
  if (h1.dataset.fit === key) return;
  h1.dataset.fit = key;
  name.dataset.full = full;
  name.textContent = full;
  h1.removeAttribute('aria-label');
  const lh = parseFloat(getComputedStyle(h1).lineHeight);
  const fits = () => !(lh > 0) || h1.scrollHeight <= lh * (lines + 0.5);
  if (fits()) return;
  const sentence = h1.textContent ?? '';
  const cps = [...full];
  let [lo, hi] = [0, cps.length - 1];
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    name.textContent = `${cps.slice(0, mid).join('').trimEnd()}…`;
    if (fits()) lo = mid;
    else hi = mid - 1;
  }
  name.textContent = `${cps.slice(0, lo).join('').trimEnd()}…`;
  h1.setAttribute('aria-label', sentence);
}

/**
 * lede と台帳をまとめて描く (render から呼ぶ入口)。
 * @param {{lede: HTMLElement, ledger: HTMLElement, toggle: HTMLElement, due: HTMLElement}} els
 * @param {{t: T, now: number, board: any, loading: boolean, fail: any, calmSince: string|null, visible: any, view?: 'list'|'canvas', keysOn?: boolean}} o
 */
export function renderFront(els, o) {
  renderLede(els.lede, o);
  renderLedger(els.ledger, els.toggle, o);
  renderDue(els.due, o.t, o.board && (Number(o.board.counts?.active) || 0) > 0 ? o.board : null);
  const lede = els.lede;
  lede.dataset.lines = String(LEDE_LINES[o.view === 'canvas' ? 'canvas' : 'list']);
  fitLede(lede, Number(lede.dataset.lines));
  // 幅が変わったら (表示枠・横の欄の大きさ) 収め直す
  if (!ledeObserver && typeof ResizeObserver !== 'undefined') {
    ledeObserver = new ResizeObserver(() => fitLede(lede, Number(lede.dataset.lines) || LEDE_LINES.list));
    ledeObserver.observe(lede);
  }
}
