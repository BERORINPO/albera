// @ts-check
// 画面: クリップボードへ書く。navigator.clipboard → 選択した textarea + execCommand → 手でコピーしてもらう dialog の順。
// 確かにコピーできたときだけ true (dialog では「コピーした」を押したときだけ)。

import { h, fill } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */

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
