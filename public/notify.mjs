// @ts-check
// 画面: 自分で ON にする通知。返事待ちと止まったかもに新しく来たものだけ (終わった知らせはアプリが出す)。

import { askText, reasonLine, titleOf } from './format.mjs';

/** @typedef {import('./i18n.mjs').T} T */
/** @typedef {Record<string, any>} Card */

const NOTIFY_PILES = Object.freeze(['needs_you', 'trouble']);

/**
 * 前の盤面に無かった返事待ち・止まったかものカード。最初の盤面では何も返さない。未読は対象外。
 * @param {any} prev
 * @param {any} board
 * @returns {Array<{pile: string, card: Card}>}
 */
export function arrivals(prev, board) {
  if (!prev || !board) return [];
  const out = [];
  for (const pile of NOTIFY_PILES) {
    const before = new Set((prev.buckets?.[pile] ?? []).map((/** @type {Card} */ c) => c.id));
    for (const card of board.buckets?.[pile] ?? []) if (!before.has(card.id)) out.push({ pile, card });
  }
  return out;
}

/**
 * この環境の通知: ok = ボタンを出す、blocked = このページの通知がブラウザで止められている (理由を 1 行出す)、none = 通知が無い。
 * @returns {'ok'|'blocked'|'none'}
 */
export function notifyState() {
  if (typeof Notification === 'undefined') return 'none';
  return Notification.permission === 'denied' ? 'blocked' : 'ok';
}

/**
 * 通知の中身。1〜2 件は 1 件ずつ、3 件以上は 1 つにまとめる。
 * @param {T} t
 * @param {Array<{pile: string, card: Card}>} list
 * @returns {Array<{title: string, body: string, tag: string, id: string}>}
 */
export function notificationsFor(t, list) {
  if (list.length >= 3) return [{ title: t('notify.many', { n: list.length }), body: '', tag: 'pigeonholes-many', id: list[0].card.id }];
  return list.map(({ pile, card }) => {
    const title = t(pile === 'needs_you' ? 'notify.needs_you' : 'notify.trouble', { title: titleOf(t, card.title) });
    const body = pile === 'needs_you' ? card.body || askText(t, card) : reasonLine(t, card);
    return { title, body: String(body ?? ''), tag: card.id, id: card.id };
  });
}

/**
 * 通知を出す。押されたらこのタブに戻って、その行へ移る。
 * @param {T} t
 * @param {Array<{pile: string, card: Card}>} list
 * @param {(id: string) => void} onClick
 */
export function notifyArrivals(t, list, onClick) {
  if (!list.length || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  for (const n of notificationsFor(t, list)) {
    try {
      const note = new Notification(n.title, { body: n.body, tag: n.tag, silent: true });
      note.onclick = () => {
        window.focus();
        note.close();
        onClick(n.id);
      };
    } catch {
      // 出せない環境 (権限が変わった等) では何もしない
    }
  }
}
