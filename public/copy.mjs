// @ts-check
// 画面: クリップボードへ書く。navigator.clipboard → 選択した textarea + execCommand → 手でコピーしてもらう dialog の順。
// 確かにコピーできたときだけ true (dialog では「コピーした」を押したときだけ)。

import { COPIED_LABEL_MS } from '../src/shared/constants.mjs';
import { h, fill } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */

// ---------- 「コピーした ✓」の文字 (toast は出さない) ----------

/** 「コピーした ✓」を出している部品 (data-action|data-id → 戻す時刻、手元の時計)。行が作り直されても残りの時間だけ続ける。 @type {Map<string, number>} */
const copiedUntil = new Map();
/** @type {WeakMap<HTMLElement, ReturnType<typeof setTimeout>>} */
const timers = new WeakMap();
/** @param {HTMLElement} btn */
const labelKey = (btn) => `${btn.dataset.action ?? ''}|${btn.dataset.id ?? ''}`;

/** @param {HTMLElement} btn @param {string} copied @param {string} back @param {number} ms */
function showCopied(btn, copied, back, ms) {
  clearTimeout(timers.get(btn));
  btn.textContent = copied;
  btn.dataset.state = 'copied';
  timers.set(
    btn,
    setTimeout(() => {
      btn.textContent = back;
      delete btn.dataset.state;
    }, ms),
  );
}

/**
 * ボタンの文字を COPIED_LABEL_MS だけ copied にする。戻す文字 back はいつも辞書から作る (続けて押しても固まらない)。
 * @param {HTMLElement} btn @param {string} copied @param {string} back
 */
export function swapLabel(btn, copied, back) {
  copiedUntil.set(labelKey(btn), Date.now() + COPIED_LABEL_MS);
  showCopied(btn, copied, back, COPIED_LABEL_MS);
}

/**
 * コピーのボタン (data-action と data-id で見分ける)。同じボタンが少し前にコピーしていれば、残りの時間だけ copied の文字で作る。
 * @param {T} t @param {{action: string, id: string, key: string, cls?: string}} o key: いつもの文字の辞書のキー
 */
export function copyButton(t, o) {
  const btn = h('button', { class: o.cls ?? 'textbtn', type: 'button', 'data-action': o.action, 'data-id': o.id, text: t(o.key) });
  const left = (copiedUntil.get(labelKey(btn)) ?? 0) - Date.now();
  if (left > 0) showCopied(btn, t('detail.copied'), t(o.key), left);
  else copiedUntil.delete(labelKey(btn));
  return btn;
}

/** 選んだ textarea + execCommand。フォーカスは textarea へ動くので、終わったら元の部品へ戻す。 @param {string} text */
function execCopy(text) {
  const before = document.activeElement;
  const ta = /** @type {HTMLTextAreaElement} */ (h('textarea', { class: 'vh', readonly: true, 'aria-hidden': 'true' }));
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  if (before instanceof HTMLElement && before !== document.body && before.isConnected) before.focus({ preventScroll: true });
  return ok;
}

/** macOS なら ⌘C、それ以外は Ctrl+C。 */
function copyKey() {
  const nav = /** @type {any} */ (navigator);
  const platform = String(nav.userAgentData?.platform ?? nav.platform ?? '');
  return /mac/i.test(platform) ? '⌘C' : 'Ctrl+C';
}

/**
 * 手でコピーしてもらう dialog。
 * @param {T} t @param {string} text @param {HTMLElement|null} opener
 * @returns {Promise<boolean>}
 */
function fallbackDialog(t, text, opener) {
  const dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('fallback'));
  if (!dlg || typeof dlg.showModal !== 'function') return Promise.resolve(false);
  return new Promise((resolve) => {
    let result = false;
    const ta = /** @type {HTMLTextAreaElement} */ (h('textarea', { class: 'fallback__text', readonly: true, rows: 8, 'aria-labelledby': 'fallback-title' }));
    ta.value = text;
    const ok = h('button', { class: 'btn btn--ink', type: 'button', text: t('fallback.confirm') });
    const no = h('button', { class: 'btn btn--line', type: 'button', text: t('fallback.close') });
    ok.addEventListener('click', () => {
      result = true;
      dlg.close();
    });
    no.addEventListener('click', () => dlg.close());
    fill(dlg, h('p', { class: 'fallback__title', id: 'fallback-title', text: t('fallback.title', { key: copyKey() }) }), ta, h('p', { class: 'help__acts' }, ok, no));
    dlg.onclose = () => {
      opener?.focus();
      resolve(result);
    };
    dlg.showModal();
    ta.focus();
    ta.select();
  });
}

/**
 * @param {T} t
 * @param {string} text
 * @param {HTMLElement|null} opener 閉じたあとにフォーカスを戻す先
 * @returns {Promise<boolean>}
 */
export async function copyText(t, text, opener) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 権限が無い・http 以外などで失敗したら次の手へ
  }
  if (execCopy(text)) {
    opener?.focus();
    return true;
  }
  return fallbackDialog(t, text, opener);
}
