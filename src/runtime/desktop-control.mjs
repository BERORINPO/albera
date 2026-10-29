import { isEnvironmentId } from './environment-provider.mjs';

/**
 * Provider-neutral contract for desktop screen capture and mouse/keyboard input (ADR-009).
 * Pure validators: no process, filesystem, clock or network access. The caller passes `now`.
 * Validation here never grants authority; it only rejects malformed or stale requests.
 */

export const DESKTOP_ACTIONS = Object.freeze([
  'screenshot', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'mouse_move',
  'left_mouse_down', 'left_mouse_up', 'left_click_drag', 'type', 'key', 'hold_key', 'scroll', 'wait',
]);
export const DESKTOP_OWNER_TYPES = Object.freeze(['AI', 'HUMAN']);

export const MAX_TYPE_LENGTH = 512;
export const MAX_KEY_REPEAT = 10;
export const MAX_SCROLL_AMOUNT = 10;
export const DEFAULT_SCROLL_AMOUNT = 3;
export const MAX_WAIT_MS = 10_000;
export const MAX_KEY_MODIFIERS = 3;
export const MAX_SCREEN_DIMENSION = 4096;
export const MAX_HOLD_MS = 5_000;

const MODIFIERS = new Set(['ctrl', 'alt', 'shift', 'super']);
const NAMED_KEYS = new Set([
  'return', 'enter', 'escape', 'esc', 'tab', 'backspace', 'delete', 'space',
  'up', 'down', 'left', 'right', 'home', 'end', 'page_up', 'page_down', 'insert',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);
const SINGLE_KEY_RE = /^[a-z0-9\-=,./;'[\]\\`]$/;
const ACTION_SET = new Set(DESKTOP_ACTIONS);
const OWNER_TYPE_SET = new Set(DESKTOP_OWNER_TYPES);
const LEASE_KEYS = new Set(['desktopSessionId', 'ownerType', 'ownerId', 'generation', 'expiresAt']);
const SCREEN_KEYS = new Set(['width', 'height']);
// Allowed fields per action: [required, optional].
// `modifiers` ("shift", "ctrl+shift") are held for the click, drag or scroll and always released.
const ACTION_FIELDS = Object.freeze({
  screenshot: [[], []],
  left_click: [[], ['coordinate', 'modifiers']],
  right_click: [[], ['coordinate', 'modifiers']],
  middle_click: [[], ['coordinate', 'modifiers']],
  double_click: [[], ['coordinate', 'modifiers']],
  triple_click: [[], ['coordinate', 'modifiers']],
  mouse_move: [['coordinate'], []],
  left_mouse_down: [[], []],
  left_mouse_up: [[], []],
  left_click_drag: [['startCoordinate', 'coordinate'], ['modifiers']],
  type: [['text'], []],
  key: [['key'], ['repeat']],
  hold_key: [['key', 'durationMs'], []],
  scroll: [['direction'], ['amount', 'coordinate', 'modifiers']],
  wait: [['durationMs'], []],
});

export class DesktopControlError extends Error {
  constructor(code, { outcome = 'unknown' } = {}) {
    super(code);
    this.name = 'DesktopControlError';
    this.code = code;
    this.outcome = outcome === 'not_applied' ? 'not_applied' : 'unknown';
  }
}

export function validateDesktopScreen(screen) {
  if (!isRecord(screen) || Object.keys(screen).some((key) => !SCREEN_KEYS.has(key))
    || !isDimension(screen.width) || !isDimension(screen.height)) {
    throw new TypeError('invalid_desktop_screen');
  }
  return Object.freeze({ width: screen.width, height: screen.height });
}

/** Normalize one desktop action against the screen size. Throws TypeError('invalid_desktop_action'). */
export function validateDesktopAction(action, screen) {
  const size = validateDesktopScreen(screen);
  if (!isRecord(action) || typeof action.action !== 'string' || !ACTION_SET.has(action.action)) {
    throw new TypeError('invalid_desktop_action');
  }
  const [required, optional] = ACTION_FIELDS[action.action];
  const allowed = new Set(['action', ...required, ...optional]);
  if (Object.keys(action).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(action, key))) {
    throw new TypeError('invalid_desktop_action');
  }
  const out = { action: action.action };
  if (Object.hasOwn(action, 'startCoordinate')) out.startCoordinate = normalizeCoordinate(action.startCoordinate, size);
  if (Object.hasOwn(action, 'coordinate')) out.coordinate = normalizeCoordinate(action.coordinate, size);
  if (Object.hasOwn(action, 'modifiers')) out.modifiers = normalizeModifiers(action.modifiers);
  if (action.action === 'type') out.text = normalizeText(action.text);
  if (action.action === 'hold_key') {
    out.key = normalizeHeldKey(action.key);
    out.durationMs = boundedInt(action.durationMs, 1, MAX_HOLD_MS);
  }
  if (action.action === 'key') {
    out.key = normalizeKey(action.key);
    if (Object.hasOwn(action, 'repeat')) out.repeat = boundedInt(action.repeat, 1, MAX_KEY_REPEAT);
  }
  if (action.action === 'scroll') {
    if (action.direction !== 'up' && action.direction !== 'down') throw new TypeError('invalid_desktop_action');
    out.direction = action.direction;
    if (Object.hasOwn(action, 'amount')) out.amount = boundedInt(action.amount, 1, MAX_SCROLL_AMOUNT);
  }
  if (action.action === 'wait') out.durationMs = boundedInt(action.durationMs, 1, MAX_WAIT_MS);
  return Object.freeze(out);
}

// ---- input plan: one validated action -> a bounded list of primitive device steps ----
// The Broker executes only these fixed primitives; it never sees key names or action names it would
// have to interpret. A Broker must release every key and button a plan pressed if any step fails.
export const DESKTOP_INPUT_OPS = Object.freeze(['move', 'down', 'up', 'press', 'release', 'tap', 'text', 'wheel', 'sleep']);
export const MAX_PLAN_STEPS = 256;
export const MAX_PLAN_SLEEP_MS = 12_000;
export const MAX_DRAG_STEPS = 48;
const DRAG_PX_PER_STEP = 16;
const MIN_DRAG_STEPS = 4;
const DRAG_PAUSE_MS = 12;
const MOVE_SETTLE_MS = 80;
const BUTTON_MS = 60;
const MODIFIER_SETTLE_MS = 30;
const WHEEL_NOTCH = 120;
const BUTTONS = Object.freeze({ left: 1, right: 2, middle: 3 });
const CLICK_PLANS = Object.freeze({
  left_click: [BUTTONS.left, 1], right_click: [BUTTONS.right, 1], middle_click: [BUTTONS.middle, 1],
  double_click: [BUTTONS.left, 2], triple_click: [BUTTONS.left, 3],
});
const VK = Object.freeze({
  return: 0x0d, enter: 0x0d, escape: 0x1b, esc: 0x1b, tab: 0x09, backspace: 0x08, delete: 0x2e, space: 0x20,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, page_up: 0x21, page_down: 0x22, insert: 0x2d,
  ctrl: 0x11, alt: 0x12, shift: 0x10, super: 0x5b,
  '-': 0xbd, '=': 0xbb, ',': 0xbc, '.': 0xbe, '/': 0xbf, ';': 0xba, "'": 0xde, '[': 0xdb, ']': 0xdd, '\\': 0xdc, '`': 0xc0,
});

/** Validate `action` against `screen`, then return its frozen primitive steps. Throws TypeError('invalid_desktop_action'). */
export function planDesktopInput(action, screen) {
  const a = validateDesktopAction(action, screen);
  const steps = [];
  const sleep = (ms) => steps.push({ op: 'sleep', ms });
  const moveTo = ([x, y]) => steps.push({ op: 'move', x, y });
  const mods = a.modifiers ? a.modifiers.split('+').map(vkOf) : [];
  const withModifiers = (body) => {
    for (const vk of mods) steps.push({ op: 'press', vk });
    if (mods.length) sleep(MODIFIER_SETTLE_MS);
    body();
    for (const vk of [...mods].reverse()) steps.push({ op: 'release', vk });
  };
  if (Object.hasOwn(CLICK_PLANS, a.action)) {
    const [button, times] = CLICK_PLANS[a.action];
    if (a.coordinate) { moveTo(a.coordinate); sleep(MOVE_SETTLE_MS); }
    withModifiers(() => {
      for (let i = 0; i < times; i++) {
        steps.push({ op: 'down', button }); sleep(BUTTON_MS);
        steps.push({ op: 'up', button }); sleep(BUTTON_MS);
      }
    });
  }
  else if (a.action === 'left_click_drag') {
    moveTo(a.startCoordinate); sleep(MOVE_SETTLE_MS);
    withModifiers(() => {
      steps.push({ op: 'down', button: BUTTONS.left }); sleep(BUTTON_MS);
      for (const point of dragPath(a.startCoordinate, a.coordinate)) { moveTo(point); sleep(DRAG_PAUSE_MS); }
      sleep(BUTTON_MS);
      steps.push({ op: 'up', button: BUTTONS.left });
    });
  }
  else if (a.action === 'mouse_move') moveTo(a.coordinate);
  else if (a.action === 'left_mouse_down') steps.push({ op: 'down', button: BUTTONS.left });
  else if (a.action === 'left_mouse_up') steps.push({ op: 'up', button: BUTTONS.left });
  else if (a.action === 'type') steps.push({ op: 'text', text: a.text });
  else if (a.action === 'key') {
    const codes = a.key.split('+').map(vkOf);
    const main = codes.pop();
    for (let i = 0; i < (a.repeat ?? 1); i++) {
      for (const vk of codes) steps.push({ op: 'press', vk });
      steps.push({ op: 'tap', vk: main });
      for (const vk of [...codes].reverse()) steps.push({ op: 'release', vk });
    }
  }
  else if (a.action === 'hold_key') {
    const codes = a.key.split('+').map(vkOf);
    for (const vk of codes) steps.push({ op: 'press', vk });
    sleep(a.durationMs);
    for (const vk of [...codes].reverse()) steps.push({ op: 'release', vk });
  }
  else if (a.action === 'scroll') {
    if (a.coordinate) moveTo(a.coordinate);
    const notches = a.amount ?? DEFAULT_SCROLL_AMOUNT;
    withModifiers(() => steps.push({ op: 'wheel', delta: (a.direction === 'up' ? 1 : -1) * WHEEL_NOTCH * notches }));
  }
  else if (a.action === 'wait') sleep(a.durationMs);
  else throw new TypeError('invalid_desktop_action'); // screenshot is a capture, not input
  if (steps.length > MAX_PLAN_STEPS || steps.reduce((ms, step) => ms + (step.ms ?? 0), 0) > MAX_PLAN_SLEEP_MS) {
    throw new TypeError('invalid_desktop_action');
  }
  return Object.freeze(steps.map((step) => Object.freeze(step)));
}

/** Evenly spaced integer points after `from`, ending exactly on `to`; 4..MAX_DRAG_STEPS of them. */
export function dragPath(from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const n = Math.min(MAX_DRAG_STEPS, Math.max(MIN_DRAG_STEPS, Math.ceil(Math.hypot(dx, dy) / DRAG_PX_PER_STEP)));
  return Array.from({ length: n }, (_, i) => [Math.round(from[0] + (dx * (i + 1)) / n), Math.round(from[1] + (dy * (i + 1)) / n)]);
}

function vkOf(name) {
  if (Object.hasOwn(VK, name)) return VK[name];
  const fn = name.match(/^f([1-9]|1[0-2])$/);
  if (fn) return 0x6f + Number(fn[1]);
  if (/^[a-z0-9]$/.test(name)) return name.toUpperCase().charCodeAt(0);
  throw new TypeError('invalid_desktop_action');
}

/** Validate the shape of a desktop-control lease. Throws TypeError('invalid_desktop_lease'). */
export function validateDesktopLease(lease) {
  if (!isRecord(lease)
    || Object.keys(lease).length !== LEASE_KEYS.size
    || Object.keys(lease).some((key) => !LEASE_KEYS.has(key))
    || !isEnvironmentId(lease.desktopSessionId)
    || !OWNER_TYPE_SET.has(lease.ownerType)
    || !isEnvironmentId(lease.ownerId)
    || !Number.isSafeInteger(lease.generation) || lease.generation < 1
    || typeof lease.expiresAt !== 'string' || !Number.isFinite(Date.parse(lease.expiresAt))) {
    throw new TypeError('invalid_desktop_lease');
  }
  return Object.freeze({
    desktopSessionId: lease.desktopSessionId,
    ownerType: lease.ownerType,
    ownerId: lease.ownerId,
    generation: lease.generation,
    expiresAt: lease.expiresAt,
  });
}

/**
 * ADR-009: input from an old generation, a different owner or an expired lease must never pass.
 * `current` is the trusted host record; `now` is epoch milliseconds supplied by the caller.
 */
export function assertLeaseCurrent(lease, current, now) {
  let held;
  let live;
  try {
    held = validateDesktopLease(lease);
    live = validateDesktopLease(current);
  }
  catch {
    throw new DesktopControlError('invalid_desktop_lease', { outcome: 'not_applied' });
  }
  if (!Number.isFinite(now)) throw new DesktopControlError('invalid_desktop_clock', { outcome: 'not_applied' });
  if (held.desktopSessionId !== live.desktopSessionId) throw new DesktopControlError('desktop_lease_session_mismatch', { outcome: 'not_applied' });
  if (held.generation !== live.generation) throw new DesktopControlError('desktop_lease_stale', { outcome: 'not_applied' });
  if (held.ownerType !== live.ownerType || held.ownerId !== live.ownerId) {
    throw new DesktopControlError('desktop_lease_owner_mismatch', { outcome: 'not_applied' });
  }
  if (now >= Date.parse(held.expiresAt) || now >= Date.parse(live.expiresAt)) {
    throw new DesktopControlError('desktop_lease_expired', { outcome: 'not_applied' });
  }
  return held;
}

function normalizeCoordinate(value, size) {
  if (!Array.isArray(value) || value.length !== 2
    || !Number.isSafeInteger(value[0]) || value[0] < 0 || value[0] >= size.width
    || !Number.isSafeInteger(value[1]) || value[1] < 0 || value[1] >= size.height) {
    throw new TypeError('invalid_desktop_action');
  }
  return Object.freeze([value[0], value[1]]);
}

function normalizeText(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_TYPE_LENGTH || !/^[\x20-\x7e]+$/.test(value)) {
    throw new TypeError('invalid_desktop_action');
  }
  return value;
}

function normalizeKey(value) {
  if (typeof value !== 'string' || value.length > 64) throw new TypeError('invalid_desktop_action');
  const parts = value.toLowerCase().split('+');
  const main = parts.pop();
  if (!NAMED_KEYS.has(main) && !SINGLE_KEY_RE.test(main)) throw new TypeError('invalid_desktop_action');
  if (parts.length > MAX_KEY_MODIFIERS || new Set(parts).size !== parts.length || parts.some((part) => !MODIFIERS.has(part))) {
    throw new TypeError('invalid_desktop_action');
  }
  return [...parts, main].join('+');
}

/** hold_key may hold modifiers alone ("shift") as well as a normal key combination. */
function normalizeHeldKey(value) {
  if (typeof value === 'string' && value.toLowerCase().split('+').every((part) => MODIFIERS.has(part))) return normalizeModifiers(value);
  return normalizeKey(value);
}

/** "Shift+CTRL" -> "shift+ctrl": 1-3 distinct modifier names, order kept. */
function normalizeModifiers(value) {
  if (typeof value !== 'string' || value.length > 32) throw new TypeError('invalid_desktop_action');
  const parts = value.toLowerCase().split('+');
  if (parts.length > MAX_KEY_MODIFIERS || new Set(parts).size !== parts.length || parts.some((part) => !MODIFIERS.has(part))) {
    throw new TypeError('invalid_desktop_action');
  }
  return parts.join('+');
}

function boundedInt(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError('invalid_desktop_action');
  return value;
}

function isDimension(value) { return Number.isSafeInteger(value) && value >= 1 && value <= MAX_SCREEN_DIMENSION; }

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => Object.hasOwn(descriptor, 'value'));
}
