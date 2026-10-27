// @ts-check
// 画面: 安全なプロジェクトラベルから、全ビュー共通の選択肢を作る。

import { projectLabel } from './format.mjs';
import { allCards } from './ui-state.mjs';
import { fill, h } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */

/** プロジェクト名だけを選択肢にし、パスや内部キーは表示しない。 @param {HTMLSelectElement} select @param {any} board @param {T} t @param {string} current */
export function renderProjectFilter(select, board, t, current) {
  const names = new Map();
  for (const { card } of allCards(board)) {
    const key = String(card.project?.key ?? '');
    if (!key || names.has(key)) continue;
    names.set(key, projectLabel(t, card.project));
  }
  const projects = [...names].sort((a, b) => a[1].localeCompare(b[1], t.lang) || a[0].localeCompare(b[0]));
  const selected = projects.some(([key]) => key === current) ? current : 'all';
  const sig = `${t.lang}|${projects.map(([key, label]) => `${key}:${label}`).join('|')}`;
  if (select.dataset.sig !== sig) {
    select.dataset.sig = sig;
    fill(select,
      h('option', { value: 'all', text: t('filter.projectAll') }),
      ...projects.map(([key, label]) => h('option', { value: key, text: label })),
    );
  }
  select.value = selected;
  return selected;
}
