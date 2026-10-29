import { isEnvironmentId } from './environment-provider.mjs';

/**
 * Provider-neutral contract for desktop screen capture and mouse/keyboard input (ADR-009).
 * Pure validators: no process, filesystem, clock or network access. The caller passes `now`.
 * Validation here never grants authority; it only rejects malformed or stale requests.
 */

export const DESKTOP_ACTIONS = Object.freeze([
  'screenshot', 'left_click', 'right_click', 'double_click', 'mouse_move',
  'left_mouse_down', 'left_mouse_up', 'type', 'key', 'scroll', 'wait',
]);
export const DESKTOP_OWNER_TYPES = Object.freeze(['AI', 'HUMAN']);

export const MAX_TYPE_LENGTH = 512;
export const MAX_KEY_REPEAT = 10;
export const MAX_SCROLL_AMOUNT = 10;
export const DEFAULT_SCROLL_AMOUNT = 3;
export const MAX_WAIT_MS = 10_000;
export const MAX_KEY_MODIFIERS = 3;
export const MAX_SCREEN_DIMENSION = 4096;

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
const ACTION_FIELDS = Object.freeze({
  screenshot: [[], []],
  left_click: [[], ['coordinate']],
  right_click: [[], ['coordinate']],
  double_click: [[], ['coordinate']],
  mouse_move: [['coordinate'], []],
  left_mouse_down: [[], []],
  left_mouse_up: [[], []],
  type: [['text'], []],
  key: [['key'], ['repeat']],
  scroll: [['direction'], ['amount', 'coordinate']],
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
  if (Object.hasOwn(action, 'coordinate')) out.coordinate = normalizeCoordinate(action.coordinate, size);
  if (action.action === 'type') out.text = normalizeText(action.text);
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
