import { MAX_HOLD_MS, MAX_WAIT_MS, validateDesktopAction } from './desktop-control.mjs';

/**
 * Pure mapping from an Anthropic computer-toolset `tool_use` block to an ALBERA desktop action.
 * No process, network, clock or filesystem access. The model's output is untrusted input:
 * every mapped action is passed through `validateDesktopAction` before it is returned.
 *
 * Result is one of:
 *   { action }              an action validated against the screen
 *   { cursorQuery: true }   cursor_position: the loop answers from the last commanded coordinate
 *   { unsupported: reason } reported back to the model as an error; never executed
 */

const CLICKS = new Set(['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click']);
const MODIFIER_NAMES = new Set(['ctrl', 'alt', 'shift', 'super']);
const MODIFIER_ALIASES = Object.freeze({ control: 'ctrl' });

export function mapComputerToolUse(block, screen) {
  const name = block?.name;
  const input = isPlain(block?.input) ? block.input : {};
  if (typeof name !== 'string') return { unsupported: 'unknown_tool' };
  if (name === 'cursor_position') return { cursorQuery: true };
  const draft = draftAction(name, input);
  if (draft.unsupported) return draft;
  try {
    return { action: validateDesktopAction(draft.action, screen) };
  }
  catch {
    return { unsupported: `${name}_invalid_arguments` };
  }
}

function draftAction(name, input) {
  if (name === 'screenshot') return { action: { action: 'screenshot' } };
  if (CLICKS.has(name) || name === 'mouse_move') {
    const action = { action: name };
    if (input.coordinate !== undefined) action.coordinate = toCoordinate(input.coordinate);
    return CLICKS.has(name) ? withModifiers(name, action, input.text) : { action };
  }
  if (name === 'left_click_drag') {
    if (input.start_coordinate === undefined || input.coordinate === undefined) return { unsupported: 'left_click_drag_invalid_arguments' };
    const action = { action: name, startCoordinate: toCoordinate(input.start_coordinate), coordinate: toCoordinate(input.coordinate) };
    return withModifiers(name, action, input.text);
  }
  if (name === 'hold_key') {
    const ms = toMs(input.duration);
    if (ms === null) return { unsupported: 'hold_key_invalid_arguments' };
    if (ms > MAX_HOLD_MS) return { unsupported: 'hold_key_too_long' };
    return { action: { action: name, key: input.text, durationMs: ms } };
  }
  if (name === 'left_mouse_down' || name === 'left_mouse_up') return { action: { action: name } };
  if (name === 'type') return { action: { action: 'type', text: input.text } };
  if (name === 'key') {
    const action = { action: 'key', key: input.text };
    if (input.repeat !== undefined) action.repeat = input.repeat;
    return { action };
  }
  if (name === 'scroll') return draftScroll(input);
  if (name === 'wait') {
    const ms = toMs(input.duration);
    if (ms === null) return { unsupported: 'wait_invalid_arguments' };
    return { action: { action: 'wait', durationMs: Math.min(MAX_WAIT_MS, ms) } };
  }
  return { unsupported: 'unknown_tool' };
}

function draftScroll(input) {
  if (input.scroll_direction !== 'up' && input.scroll_direction !== 'down') return { unsupported: 'scroll_direction_not_supported' };
  const action = { action: 'scroll', direction: input.scroll_direction };
  if (input.scroll_amount !== undefined) action.amount = input.scroll_amount;
  if (input.coordinate !== undefined) action.coordinate = toCoordinate(input.coordinate);
  return withModifiers('scroll', action, input.text);
}

// The model names held modifiers in `text` ("shift", "ctrl+shift"); anything else is refused by name.
function withModifiers(name, action, text) {
  if (text === undefined) return { action };
  if (typeof text !== 'string' || text.length === 0 || text.length > 32) return { unsupported: `${name}_unknown_modifier` };
  const parts = text.toLowerCase().split('+').map((part) => MODIFIER_ALIASES[part.trim()] ?? part.trim());
  if (parts.some((part) => !MODIFIER_NAMES.has(part))) return { unsupported: `${name}_unknown_modifier` };
  return { action: { ...action, modifiers: parts.join('+') } };
}

// Seconds from the model -> whole milliseconds (at least 1); null when not a positive finite number.
function toMs(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(1, Math.round(seconds * 1000));
}

// Non-integer pixels are rounded; anything else is passed through so validation rejects it.
function toCoordinate(value) {
  if (!Array.isArray(value)) return value;
  return value.map((n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : n));
}

function isPlain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
