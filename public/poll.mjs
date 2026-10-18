// @ts-check
// 画面: 5 秒ごとの盤面の取得。通信の失敗 (繋がらない・サーバー・版) と描画の失敗を分けて扱う。spec/ui.md §16
// 読み取り専用 (サーバーへは GET しかしない)。304 では盤面を作り直さない。

import { FETCH_TIMEOUT_MS, FIRST_FETCH_TIMEOUT_MS, HIDDEN_POLL_MS, POLL_MS } from '../src/shared/constants.mjs';
import { BoardHttpError, BoardVersionError, fetchBoard } from './api.mjs';
import { bucketTitle, titleOf } from './format.mjs';
import { arrivals, notifyArrivals } from './notify.mjs';
import { jumpTo, render, renderPulse, view } from './render.mjs';
import { now, restore, setBoard, snapshot, state } from './state.mjs';
import { announce } from './view.mjs';

/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;
let inflight = false;

/** 次の取得を予約する (タブが隠れている間は止める。通知 ON なら間を空けて続ける)。 */
export function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (state.fail === 'version') return;
  if (document.hidden) {
    if (state.prefs.notify) timer = setTimeout(poll, HIDDEN_POLL_MS);
    return;
  }
  timer = setTimeout(poll, POLL_MS);
}

/** 取得・描画の失敗の種類ごとの、帯の最初の一文 (失敗の種類が変わったときに 1 回だけ読み上げる)。 */
const FAIL_LEAD = Object.freeze({ offline: 'banner.offline.lead', server: 'banner.server.lead', version: 'banner.version.lead', render: 'banner.render.lead' });

/** 盤面を 1 回取る。 */
export async function poll() {
  if (inflight || state.fail === 'version') return;
  inflight = true;
  const failBefore = state.fail;
  try {
    /** @type {Awaited<ReturnType<typeof fetchBoard>>} */
    let r;
    try {
      r = await fetchBoard(state.etag, state.board ? FETCH_TIMEOUT_MS : FIRST_FETCH_TIMEOUT_MS);
    } catch (e) {
      // ここで受けるのは通信の失敗だけ (描画の失敗は showBoard が別に受ける)
      state.fail = e instanceof BoardVersionError ? 'version' : e instanceof BoardHttpError ? 'server' : 'offline';
      render();
      return;
    }
    if (r.status === 304) {
      state.lastOk = now();
      state.fail = null;
      // 盤面は同じ。失敗の帯を消すときだけ全体を描き、それ以外は見出しの日付だけ (spec/ui.md §16)
      if (failBefore) render();
      else renderPulse();
      return;
    }
    showBoard(r);
  } finally {
    const fail = /** @type {keyof typeof FAIL_LEAD|null} */ (state.fail);
    if (fail && fail !== failBefore) announce(state.t(FAIL_LEAD[fail]));
    inflight = false;
    schedule();
  }
}

/**
 * 200 の盤面を受け取って描く。描けなかったら状態を前に戻し、etag も進めない (次の取得でもう一度試す)。
 * 理由はコンソールに出し、帯で「描けなかった」と伝える (繋がらないとは言わない)。
 * @param {any} r fetchBoard の 200 の結果
 */
function showBoard(r) {
  const t = state.t;
  const kept = { s: snapshot(), offset: state.offset, lastOk: state.lastOk };
  const prev = state.board;
  const before = state.batch ? state.batch.ids.filter((id) => view.present.has(id)).length : 0;
  try {
    state.offset = (Number(r.data.serverNow) || Date.now()) - Date.now();
    state.lastOk = now();
    state.fail = null;
    const { moved } = setBoard(r.data, now());
    render();
    state.etag = r.etag;
    if (moved) announce(t('live.moved', { title: titleOf(t, view.index.get(moved.id)?.card.title), pile: bucketTitle(t, moved.to) }));
  } catch (e) {
    console.error('Pigeonholes: could not draw the board', e);
    restore(kept.s);
    state.offset = kept.offset;
    state.lastOk = kept.lastOk;
    state.fail = 'render';
    try {
      render();
    } catch (e2) {
      console.error('Pigeonholes: could not draw the previous board either', e2);
    }
    return;
  }
  if (state.batch && before > 0 && state.batch.ids.every((id) => !view.present.has(id))) announce(t('sel.done', { n: state.batch.ids.length }));
  if (prev && state.prefs.notify && (document.hidden || !document.hasFocus())) notifyArrivals(t, arrivals(prev, r.data), jumpTo);
}
