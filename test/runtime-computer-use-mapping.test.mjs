import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HOLD_MS } from '../src/runtime/desktop-control.mjs';
import { mapComputerToolUse } from '../src/runtime/computer-use-mapping.mjs';
import { fakeToolUse } from '../src/runtime/fake-computer-use-client.mjs';

const screen = Object.freeze({ width: 64, height: 48 });
const m = (name, input) => mapComputerToolUse(fakeToolUse(name, input), screen);

test('mapping: triple and middle clicks map, with or without a coordinate', () => {
  assert.deepEqual(m('triple_click', { coordinate: [3, 4] }).action, { action: 'triple_click', coordinate: [3, 4] });
  assert.deepEqual(m('middle_click', {}).action, { action: 'middle_click' });
  assert.ok(m('triple_click', { coordinate: [64, 4] }).unsupported);
});

test('mapping: left_click_drag maps start_coordinate -> coordinate', () => {
  assert.deepEqual(m('left_click_drag', { start_coordinate: [1, 2], coordinate: [30.6, 40.2] }).action,
    { action: 'left_click_drag', startCoordinate: [1, 2], coordinate: [31, 40] });
  assert.equal(m('left_click_drag', { coordinate: [1, 2] }).unsupported, 'left_click_drag_invalid_arguments');
  assert.equal(m('left_click_drag', { start_coordinate: [1, 2] }).unsupported, 'left_click_drag_invalid_arguments');
  assert.equal(m('left_click_drag', { start_coordinate: [-1, 2], coordinate: [3, 3] }).unsupported, 'left_click_drag_invalid_arguments');
  assert.equal(m('left_click_drag', { start_coordinate: [1, 2], coordinate: [3, 48] }).unsupported, 'left_click_drag_invalid_arguments');
});

test('mapping: hold_key takes seconds, is bounded and refuses too long holds', () => {
  assert.deepEqual(m('hold_key', { text: 'shift', duration: 1.5 }).action, { action: 'hold_key', key: 'shift', durationMs: 1500 });
  assert.deepEqual(m('hold_key', { text: 'Right', duration: 0.25 }).action, { action: 'hold_key', key: 'right', durationMs: 250 });
  assert.equal(m('hold_key', { text: 'shift', duration: MAX_HOLD_MS / 1000 + 0.1 }).unsupported, 'hold_key_too_long');
  assert.equal(m('hold_key', { text: 'shift', duration: 600 }).unsupported, 'hold_key_too_long');
  assert.equal(m('hold_key', { text: 'shift' }).unsupported, 'hold_key_invalid_arguments');
  assert.equal(m('hold_key', { text: 'shift', duration: -1 }).unsupported, 'hold_key_invalid_arguments');
  assert.equal(m('hold_key', { text: 'shift', duration: Infinity }).unsupported, 'hold_key_invalid_arguments');
  assert.equal(m('hold_key', { text: 'printscreen', duration: 1 }).unsupported, 'hold_key_invalid_arguments');
  assert.equal(m('hold_key', { duration: 1 }).unsupported, 'hold_key_invalid_arguments');
});

test('mapping: clicks, drags and scrolls carry held modifiers from `text`', () => {
  assert.deepEqual(m('left_click', { coordinate: [1, 1], text: 'shift' }).action, { action: 'left_click', coordinate: [1, 1], modifiers: 'shift' });
  assert.equal(m('right_click', { text: 'Control+Shift' }).action.modifiers, 'ctrl+shift');
  assert.equal(m('triple_click', { text: 'alt' }).action.modifiers, 'alt');
  assert.equal(m('left_click_drag', { start_coordinate: [0, 0], coordinate: [5, 5], text: 'ctrl' }).action.modifiers, 'ctrl');
  assert.equal(m('scroll', { scroll_direction: 'up', text: 'ctrl' }).action.modifiers, 'ctrl');
});

test('mapping: unknown or malformed modifiers are refused by name, never executed', () => {
  for (const text of ['hyper', 'cmd', 'meta', 'shift+a', 'shift+shift', 'ctrl+alt+shift+super', '', 'x'.repeat(40)]) {
    assert.equal(m('left_click', { coordinate: [1, 1], text }).unsupported?.startsWith('left_click_'), true, text);
  }
  assert.equal(m('left_click', { text: 'hyper' }).unsupported, 'left_click_unknown_modifier');
  assert.equal(m('left_click', { text: 42 }).unsupported, 'left_click_unknown_modifier');
  assert.equal(m('left_click_drag', { start_coordinate: [0, 0], coordinate: [5, 5], text: 'fn' }).unsupported, 'left_click_drag_unknown_modifier');
  assert.equal(m('scroll', { scroll_direction: 'down', text: 'win' }).unsupported, 'scroll_unknown_modifier');
  assert.equal(m('left_click', { text: 'shift+shift' }).unsupported, 'left_click_invalid_arguments');
});
