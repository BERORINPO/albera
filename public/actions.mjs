// @ts-check
// 画面: コピーする操作 (片付けの指示文・ID とリンク・引き継ぎの案内) と、h キー・「引き継ぎどき N 件」。app.mjs のクリックとキーから呼ぶ。
// どれも確かにコピーできたときだけ先へ進む。ボードはセッションに何も送らない (コピーと、開くリンクだけ)。

import { COPIED_LABEL_MS, COPY_CHUNK, SKIP_EXPLAIN_MS } from '../src/shared/constants.mjs';
import { copyText, swapLabel } from './copy.mjs';
import { archiveInstruction, deepLink } from './format.mjs';
import { dueIds, handoffPlan, runHandoffCopy } from './handoff.mjs';
import { backToRow, jumpTo, openSession, render, rowEl, setCursorRow, view } from './render.mjs';
import { now, startBatch, state, storeHandoff } from './state.mjs';
import { nextUp, planCopy } from './ui-state.mjs';
import { announce } from './view.mjs';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 次の 50 件の片付けの指示文をコピーする。確かにコピーできたときだけ batch に足す。 @param {HTMLElement|null} opener */
export async function copyChunk(opener) {
  const t = state.t;
  const sel = [...state.selected];
  if (!sel.length) return announce(t('live.nothingPicked'));
  const plan = planCopy(sel, state.copied, COPY_CHUNK);
  const text = archiveInstruction(t, plan.chunk);
  const ok = await copyText(t, text, opener);
  // 手でコピーする dialog の間に、戻し先の部品が作り直されていたらカーソルの行へ戻す
  if (document.activeElement === document.body && opener && !opener.isConnected) backToRow();
  if (!ok) return;
  // 「コピーした ✓」と 2 分の説明は手元の時計で数える (サーバー時計は取得のたびに合わせ直すので)
  startBatch(plan, text, Date.now());
  state.copiedUntil = Date.now() + COPIED_LABEL_MS;
  announce(t('live.copied', { n: plan.chunk.length }));
  render();
  setTimeout(render, COPIED_LABEL_MS + 50);
  setTimeout(render, SKIP_EXPLAIN_MS + 50);
}

/** 「詳しく」の ID / リンクのコピー。ボタンの文字を 2.5 秒だけ「コピーした ✓」にして、読み上げにも一言出す。 @param {HTMLElement} btn */
export async function copySmall(btn) {
  const link = btn.dataset.action === 'copy-link';
  const id = btn.dataset.id ?? '';
  if (!(await copyText(state.t, link ? deepLink(id) ?? '' : id, btn))) return;
  swapLabel(btn, state.t('detail.copied'), state.t(link ? 'detail.copyLink' : 'detail.copyId'));
  announce(state.t(link ? 'live.copiedLink' : 'live.copiedId'));
}

/**
 * その行の引き継ぎの案内を開き、主のボタン (コピーして開く / 救出のコピー) へフォーカスする (h キーと「引き継ぐ」)。
 * 案内が無ければ理由を読み上げるだけ。
 * @param {string} id
 */
export function openHandoff(id) {
  const t = state.t;
  const e = view.index.get(id);
  if (!e) return false;
  const plan = handoffPlan(e.card, state.prefs.handoff[e.card.id], now());
  if (!plan.guide) {
    announce(t('live.handoffNo', { why: t(plan.why ?? 'handoff.whyUnknown') }));
    return true;
  }
  state.open.add(e.card.id);
  render();
  const row = rowEl(e.card.id);
  if (row && !row.closest('[hidden], [inert]')) setCursorRow(row);
  const btn = /** @type {HTMLElement|null} */ (row?.querySelector('.handoff [data-action="handoff-copy-open"], .handoff [data-action="handoff-rescue"]') ?? null);
  if (!btn) return true;
  btn.focus({ preventScroll: true });
  btn.scrollIntoView({ block: 'nearest' });
  // 「詳しく」は開く途中 (grid 0fr → 1fr) なので、開き終えたところでもう一度見える位置へ
  if (!reduced()) setTimeout(() => btn.isConnected && btn.scrollIntoView({ block: 'nearest' }), 400);
  return true;
}

/** h キー: カーソルの行 (無ければ lede の 1 件) の引き継ぎ。 */
export function handoffKey() {
  const id = state.cursor?.id ?? nextUp(state.board)?.card.id;
  return id ? openHandoff(id) : false;
}

/** 案内のボタン (コピーして開く・指示文だけコピー・救出のコピー)。 @param {HTMLElement} btn */
export async function runGuide(btn) {
  const e = view.index.get(btn.dataset.id ?? '');
  if (!e) return;
  const action = btn.dataset.action;
  const mode = action === 'handoff-rescue' ? 'rescue' : action === 'handoff-copy' ? 'copy' : 'copy-open';
  const ok = await runHandoffCopy({
    t: state.t, card: e.card, mode, button: btn, opener: btn, store: storeHandoff, open: openSession, announce, now: now(), demo: !!state.board?.stats?.demo,
  });
  // 行の「引き継ぐ」を「コピー済み」に替える (作り直したボタンも残りの時間は「コピーした ✓」のまま)
  if (ok && mode !== 'rescue') render();
}

/** 「引き継ぎどき N 件」: 割合の高い順に、カーソルを次の 1 件へ (端まで行ったら最初へ)。開くものは無い。 */
export function dueNext() {
  const ids = dueIds(state.board);
  if (!ids.length) return false;
  const i = state.cursor ? ids.indexOf(state.cursor.id) : -1;
  jumpTo(ids[(i + 1) % ids.length]);
  return true;
}
