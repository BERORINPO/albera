import { MAX_WAIT_MS, validateDesktopAction } from './desktop-control.mjs';

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

const CLICKS = new Set(['left_click', 'right_click', 'double_click']);
const UNSUPPORTED_NAMES = new Set(['triple_click', 'middle_click', 'left_click_drag', 'hold_key']);

export function mapComputerToolUse(block, screen) {
  const name = block?.name;
  const input = isPlain(block?.input) ? block.input : {};
  if (typeof name !== 'string') return { unsupported: 'unknown_tool' };
  if (name === 'cursor_position') return { cursorQuery: true };
  if (UNSUPPORTED_NAMES.has(name)) return { unsupported: `${name}_not_supported` };
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
    if (CLICKS.has(name) && input.text !== undefined) return { unsupported: `${name}_modifier_not_supported` };
    const action = { action: name };
    if (input.coordinate !== undefined) action.coordinate = toCoordinate(input.coordinate);
    return { action };
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
    const seconds = input.duration;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return { unsupported: 'wait_invalid_arguments' };
    return { action: { action: 'wait', durationMs: Math.min(MAX_WAIT_MS, Math.max(1, Math.round(seconds * 1000))) } };
  }
  return { unsupported: 'unknown_tool' };
}

function draftScroll(input) {
  if (input.scroll_direction !== 'up' && input.scroll_direction !== 'down') return { unsupported: 'scroll_direction_not_supported' };
  if (input.text !== undefined) return { unsupported: 'scroll_modifier_not_supported' };
  const action = { action: 'scroll', direction: input.scroll_direction };
  if (input.scroll_amount !== undefined) action.amount = input.scroll_amount;
  if (input.coordinate !== undefined) action.coordinate = toCoordinate(input.coordinate);
  return { action };
}

// Non-integer pixels are rounded; anything else is passed through so validation rejects it.
function toCoordinate(value) {
  if (!Array.isArray(value)) return value;
  return value.map((n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : n));
}

function isPlain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
