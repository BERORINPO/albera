// @ts-check
// 画面: DOM の小さな道具。中身は textContent と DOM API だけで入れる (HTML 文字列も style 属性も使わない)。

/** @typedef {Node|string|number|null|undefined|false} Child */

/**
 * 要素を作る。props: class / text / lang / data-* / aria-* / href などの属性、hidden・checked・disabled などのプロパティ。
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {...(Child|Child[])} children
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'hidden' || k === 'checked' || k === 'disabled' || k === 'readOnly' || k === 'indeterminate' || k === 'open') /** @type {any} */ (el)[k] = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

/** @param {Element} el @param {Array<Child|Child[]>} children */
function append(el, children) {
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/**
 * fillParts の結果 (文字列と DOM ノードの並び) をノードにする。
 * @param {Array<unknown>} parts
 * @returns {Node[]}
 */
export function partsToNodes(parts) {
  return parts.map((p) => (p instanceof Node ? p : document.createTextNode(String(p ?? ''))));
}

/** 中身を差し替える。 @param {Element} el @param {...(Child|Child[])} children */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

/** 文字が変わったときだけ書く (画面の読み上げとレイアウトの揺れを減らす)。 @param {Element|null} el @param {string} text */
export function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

/** 読み上げの欄 (#live) に一言だけ出す。同じ文でも読み上げ直すよう、一度空にしてから書く。 @param {string} text */
export function announce(text) {
  const live = document.getElementById('live');
  if (!live) return;
  live.textContent = '';
  requestAnimationFrame(() => {
    live.textContent = text;
  });
}

/** 3 状態のチェックボックスを合わせる。 @param {HTMLInputElement} input @param {'on'|'mixed'|'off'} state */
export function setCheck(input, state) {
  input.checked = state === 'on';
  input.indeterminate = state === 'mixed';
  input.setAttribute('aria-checked', state === 'mixed' ? 'mixed' : state === 'on' ? 'true' : 'false');
}

/**
 * 親の子要素を items の順にそろえる。data-key が同じ要素は使い回し、署名 (data-sig) が変わったものだけ作り直す。
 * 消える要素は leave(el) が true を返せば呼び出し側に任せ (片付けのフェードアウト)、それ以外はすぐ外す。
 * 片付け中 (data-leaving) の要素は並べ替えの対象にしない。
 * @template T
 * @param {Element} parent
 * @param {T[]} items
 * @param {(item: T) => string} keyOf
 * @param {(item: T) => string} sigOf
 * @param {(item: T, old: HTMLElement|null) => HTMLElement} build
 * @param {(el: HTMLElement) => boolean} [leave]
 */
export function reconcile(parent, items, keyOf, sigOf, build, leave) {
  /** @type {Map<string, HTMLElement>} */
  const existing = new Map();
  for (const el of Array.from(parent.children)) {
    const he = /** @type {HTMLElement} */ (el);
    if (he.dataset.leaving != null) continue;
    const k = he.dataset.key;
    // 鍵の無いもの (読み込み中の空の行など) と、同じ鍵の 2 つ目は使い回さない
    if (k == null || existing.has(k)) he.remove();
    else existing.set(k, he);
  }
  let ref = parent.firstElementChild;
  for (const item of items) {
    while (ref && /** @type {HTMLElement} */ (ref).dataset.leaving != null) ref = ref.nextElementSibling;
    const key = keyOf(item);
    const sig = sigOf(item);
    const old = existing.get(key) ?? null;
    existing.delete(key);
    let el = old;
    if (!el || el.dataset.sig !== sig) {
      el = build(item, old);
      el.dataset.key = key;
      el.dataset.sig = sig;
      if (old && old !== el) {
        if (ref === old) ref = el;
        old.replaceWith(el);
      }
    }
    if (el === ref) ref = ref.nextElementSibling;
    else parent.insertBefore(el, ref);
  }
  for (const el of existing.values()) {
    if (leave && leave(el)) continue;
    el.remove();
  }
}

/**
 * 片付けで消える行を、フェードしてから外す (transitionend が来なくても 450ms で外す)。
 * @param {HTMLElement} el
 */
export function leaveAndRemove(el) {
  el.dataset.leaving = '';
  el.classList.add('is-leaving');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.remove();
  };
  el.addEventListener('transitionend', (ev) => {
    if (ev.target === el && ev.propertyName === 'grid-template-rows') finish();
  });
  setTimeout(finish, 450);
}

/** 開閉の器 (grid-template-rows 0fr → 1fr)。閉じている間は inert。 @param {HTMLElement} wrap @param {boolean} open */
export function setDisclosed(wrap, open) {
  wrap.classList.toggle('is-open', open);
  /** @type {any} */ (wrap).inert = !open;
  if (open) wrap.removeAttribute('inert');
  else wrap.setAttribute('inert', '');
}
