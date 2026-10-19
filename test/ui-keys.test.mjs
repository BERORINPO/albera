import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeStep, keyAction } from '../public/keys.mjs';

const on = { keysOn: true, target: /** @type {const} */ ('none') };
/** @param {string} key @param {Record<string, any>} [o] */
const k = (key, o = {}) => ({ key, ...o });

test('keyAction: 表のキーを動作にする', () => {
  assert.equal(keyAction(k('j'), on), 'next');
  assert.equal(keyAction(k('ArrowDown'), on), 'next');
  assert.equal(keyAction(k('k'), on), 'prev');
  assert.equal(keyAction(k('ArrowUp'), on), 'prev');
  assert.equal(keyAction(k('Enter'), on), 'open');
  assert.equal(keyAction(k('o'), on), 'open');
  assert.equal(keyAction(k(' '), on), 'peek');
  assert.equal(keyAction(k('x'), on), 'pick');
  assert.equal(keyAction(k('a'), on), 'all');
  assert.equal(keyAction(k('c'), on), 'copy');
  assert.equal(keyAction(k('/'), on), 'filter');
  assert.equal(keyAction(k('?', { shiftKey: true }), on), 'help');
  assert.equal(keyAction(k('v'), on), 'view');
  assert.equal(keyAction(k('z'), on), 'canvas-fit');
  assert.equal(keyAction(k('h'), on), 'handoff');
  assert.equal(keyAction(k('1'), on), 'jump:needs_you');
  assert.equal(keyAction(k('6'), on), 'jump:cleanup');
  assert.equal(keyAction(k('7'), on), null);
  assert.equal(keyAction(k('Escape'), on), 'escape');
});

test('keyAction: 日本語入力中・修飾キー・Shift (? 以外) は無視する', () => {
  assert.equal(keyAction(k('j', { isComposing: true }), on), null);
  assert.equal(keyAction(k('Process', { keyCode: 229 }), on), null);
  assert.equal(keyAction(k('j', { keyCode: 229 }), on), null);
  assert.equal(keyAction(k('c', { ctrlKey: true }), on), null);
  assert.equal(keyAction(k('c', { metaKey: true }), on), null);
  assert.equal(keyAction(k('a', { altKey: true }), on), null);
  assert.equal(keyAction(k('J', { shiftKey: true }), on), null);
});

test('keyAction: 入力欄と dialog の中では何もしない (絞り込み欄の Esc だけは受ける)', () => {
  assert.equal(keyAction(k('j'), { keysOn: true, target: 'field' }), null);
  assert.equal(keyAction(k('Escape'), { keysOn: true, target: 'field' }), null);
  assert.equal(keyAction(k('j'), { keysOn: true, target: 'dialog' }), null);
  assert.equal(keyAction(k('Escape'), { keysOn: true, target: 'dialog' }), null, 'dialog の Esc はブラウザに任せる');
  assert.equal(keyAction(k('j'), { keysOn: true, target: 'filter' }), null);
  assert.equal(keyAction(k('Escape'), { keysOn: true, target: 'filter' }), 'escape');
});

test('keyAction: 行の題名の Enter は開く、Space は題名の普段の動き。他の部品の Enter と Space はブラウザのまま', () => {
  const title = { keysOn: true, target: /** @type {const} */ ('title') };
  const control = { keysOn: true, target: /** @type {const} */ ('control') };
  assert.equal(keyAction(k('Enter'), title), 'open');
  assert.equal(keyAction(k(' '), title), null);
  assert.equal(keyAction(k('Enter'), control), null);
  assert.equal(keyAction(k(' '), control), null);
  assert.equal(keyAction(k('j'), control), 'next');
});

test('keyAction: キャンバスの表示の間は canvasKeyAction に渡し、名前に cv: を付ける', () => {
  const cv = { keysOn: true, target: /** @type {const} */ ('none'), view: /** @type {const} */ ('canvas') };
  assert.equal(keyAction(k('v'), cv), 'cv:view');
  assert.equal(keyAction(k('j'), cv), 'cv:next');
  assert.equal(keyAction(k('x'), cv), null, '片付けのキーは一覧だけ');
  assert.equal(keyAction(k('ArrowLeft'), { ...cv, canvasTarget: 'slip' }), 'cv:move-left');
  assert.equal(keyAction(k('ArrowLeft'), { ...cv, canvasTarget: 'viewport' }), 'cv:pan-left');
  assert.equal(keyAction(k('Escape'), { ...cv, canvasTarget: 'filter' }), 'cv:escape');
});

test('keyAction: 1 文字キーを止めても Enter・Space・Esc・矢印は使える (キャンバスと同じ)', () => {
  const off = { keysOn: false, target: /** @type {const} */ ('none') };
  for (const key of ['j', 'k', 'o', 'x', 'a', 'c', 'h', 'v', '/', 'z', '1', '6']) assert.equal(keyAction(k(key), off), null, key);
  assert.equal(keyAction(k('ArrowDown'), off), 'next');
  assert.equal(keyAction(k('ArrowUp'), { keysOn: false, target: 'title' }), 'prev');
  assert.equal(keyAction(k('?', { shiftKey: true }), off), null);
  assert.equal(keyAction(k('Enter'), off), 'open');
  assert.equal(keyAction(k(' '), off), 'peek');
  assert.equal(keyAction(k('Escape'), off), 'escape');
});

test('keyAction: x / a / c / h / v / z の押しっぱなしは 1 回だけ', () => {
  for (const key of ['x', 'a', 'c', 'h', 'v', 'z']) assert.equal(keyAction(k(key, { repeat: true }), on), null, key);
  assert.equal(keyAction(k('j', { repeat: true }), on), 'next');
});

test('escapeStep: 絞り込み欄 → 詳しく → 親子 → 文字。選択は消さない', () => {
  const base = { inFilter: false, filterValue: '', detailOpen: false, family: null, q: '' };
  assert.equal(escapeStep({ ...base, inFilter: true, filterValue: 'x', q: 'x' }), 'filter-clear');
  assert.equal(escapeStep({ ...base, inFilter: true }), 'filter-blur');
  assert.equal(escapeStep({ ...base, detailOpen: true, family: 'r', q: 'x' }), 'detail-close');
  assert.equal(escapeStep({ ...base, family: 'r', q: 'x' }), 'family-clear');
  assert.equal(escapeStep({ ...base, q: 'x' }), 'query-clear');
  assert.equal(escapeStep(base), null);
});
