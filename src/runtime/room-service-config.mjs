import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { roomBootstrapAcl } from './room-bootstrap-file.mjs';

// Where `albera-runtime room-service --data-root <dataRoot>` finds its files, and what it reads from `AlberaControlPlane.service.json`
// (docs/architecture/control-plane-service.md sections 2, 3 and 6; PR4d). Everything is derived from the data root the .NET host passes (`--data-root`, PR2); nothing comes from the environment.
//
//   <dataRoot>\control-plane-config\AlberaControlPlane.service.json   written by setup, read-only for the Control Plane (the contract's table in section 3)
//   <dataRoot>\control-plane-config\albera.approval.json              the gated room's settings file (room-approval-wiring.mjs)
//   <dataRoot>\secrets\                                               the DPAPI blobs (control-plane-secret-store.mjs); setup makes the folder
//   <dataRoot>\ui\room.json                                           the bootstrap file (room-bootstrap-file.mjs); setup makes the folder
//   <dataRoot>\control-plane\claude-run\                              one new folder per Claude Code run (room-service-hands.mjs)
//
// The service file is shared: the .NET host reads only its top-level key `host` (HostConfig.cs) and the room reads the keys below. PROVISIONAL (the contract names a `claude` block and a credential
// choice but no keys; setup, PR7, must write exactly these):
//   { "host": { ... },                                           not read here
//     "claude": { "executable": "<abs path of the pinned claude.exe, inside the install folder (CLAUDE_INSTALL_DIR)>", "executableSha256": "<64 hex>",
//                 "model": "<optional alias or id>", "maxMinutes": <optional, 1..55, default 15>, "maxToolCalls": <optional, 1..400, default 120> },
//     "ui":     { "controlPlaneSid": "S-1-5-80-...", "approverSid": "S-1-5-21-..." },                the two SIDs of the bootstrap file's ACL (room-bootstrap-file.mjs `roomBootstrapAcl`)
//     "feedback": true,                                            optional, a boolean, default false: the room's feedback panel may send to the intake Worker (feedback-contract.mjs): the route
//                                                                  GET /api/feedback is registered and the CSP gets that one origin. The default stays off until the intake's address is final.
//     "mainAi": true }                                             optional, a boolean, default false: the talk panel runs the real main AI (Claude Code with no tools, main-ai-claude.mjs). Off, the
//                                                                  panel is there and says it is not available. Turn it on only after M6 (control-plane-service.md section 11) has shown `--tools ""` to work.
// Any other top-level key, any other key inside `claude` or `ui`, or a missing required one is refused (fail closed: setup and this reader must agree). The credential is always the secret
// `claude-oauth-token`; the API-key option of the contract (6.7) is not wired by this PR. Errors are fixed codes (`room_service_config_*`); the file's content and paths are never printed.

export const SERVICE_CONFIG_FILE = 'AlberaControlPlane.service.json';
export const APPROVAL_SETTINGS_FILE = 'albera.approval.json';
export const MAX_SERVICE_CONFIG_BYTES = 16 * 1024;
/**
 * The only place `claude.exe` may be started from: the administrator-only install folder of the contract (section 3, the folder bin, then claude). Fixed text, never read from an environment variable
 * (the host gives this process nine variables and none may steer a trust decision), and not resolved through the OS (Node has no SHGetKnownFolderPath): a Windows whose Program Files is not
 * on C: is refused here (fail closed) until setup passes the folder some other trusted way. The folder's ACL is checked before every run (room-service-folder-guard.mjs).
 */
export const CLAUDE_INSTALL_DIR = String.raw`C:\Program Files\Albera\bin\claude`;
/** The limits of the contract's section 6.6: defaults and ceilings of one task. */
export const CLAUDE_LIMITS = Object.freeze({ defaultMinutes: 15, maxMinutes: 55, defaultToolCalls: 120, maxToolCalls: 400 });
const SHA256_RE = /^[a-f0-9]{64}$/u;
const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/u;
const TOP_KEYS = ['host', 'claude', 'ui', 'feedback', 'mainAi'];
const CLAUDE_KEYS = ['executable', 'executableSha256', 'model', 'maxMinutes', 'maxToolCalls'];
const UI_KEYS = ['controlPlaneSid', 'approverSid'];
const fail = (what) => new Error(`room_service_config_${what}`);
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value, keys) => isPlain(value) && Object.keys(value).every((key) => keys.includes(key));
// Absolute, already normalized, not a UNC share: the same file whatever the working directory.
const isAbsolutePath = (value) => typeof value === 'string' && value.length > 0 && path.isAbsolute(value) && path.resolve(value) === value && !/^[\\/]{2}/u.test(value);
const inRange = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

/** The paths of the service, from the data root alone. Pure. */
export function roomServicePaths(dataRoot) {
  if (!isAbsolutePath(dataRoot)) throw fail('data_root');
  const configDir = path.join(dataRoot, 'control-plane-config');
  return Object.freeze({
    dataRoot,
    serviceConfig: path.join(configDir, SERVICE_CONFIG_FILE),
    approvalFile: path.join(configDir, APPROVAL_SETTINGS_FILE),
    secretsDir: path.join(dataRoot, 'secrets'),
    uiFile: path.join(dataRoot, 'ui', 'room.json'),
    runRoot: path.join(dataRoot, 'control-plane', 'claude-run'),
  });
}

// Inside the install folder (any depth, never the folder itself), compared the way Windows does: case-insensitive, after normalization.
function isInsideInstallDir(executable, installDir) {
  const w = path.win32;
  const rel = w.relative(w.resolve(installDir).toLowerCase(), w.resolve(executable).toLowerCase());
  return rel !== '' && !rel.startsWith('..') && !w.isAbsolute(rel);
}

function parseClaude(raw, installDir) {
  if (!hasOnly(raw, CLAUDE_KEYS) || !isAbsolutePath(raw.executable) || !isInsideInstallDir(raw.executable, installDir) || typeof raw.executableSha256 !== 'string' || !SHA256_RE.test(raw.executableSha256)) throw fail('claude');
  if (raw.model !== undefined && !(typeof raw.model === 'string' && MODEL_RE.test(raw.model))) throw fail('claude');
  const minutes = raw.maxMinutes ?? CLAUDE_LIMITS.defaultMinutes;
  const calls = raw.maxToolCalls ?? CLAUDE_LIMITS.defaultToolCalls;
  if (!inRange(minutes, 1, CLAUDE_LIMITS.maxMinutes) || !inRange(calls, 1, CLAUDE_LIMITS.maxToolCalls)) throw fail('claude');
  return Object.freeze({ executable: raw.executable, executableSha256: raw.executableSha256, model: raw.model ?? null, maxMs: minutes * 60_000, maxToolCalls: calls });
}

function parseUi(raw) {
  if (!hasOnly(raw, UI_KEYS) || Object.keys(raw).length !== UI_KEYS.length) throw fail('ui');
  try { return Object.freeze({ acl: roomBootstrapAcl({ cpSid: raw.controlPlaneSid, approverSid: raw.approverSid }) }); } catch { throw fail('ui'); }
}

// Absent = off. Only a real boolean is accepted (a string "false" must not turn it on).
function parseFeedback(raw) {
  if (raw === undefined) return false;
  if (typeof raw !== 'boolean') throw fail('feedback');
  return raw;
}

// Absent = off, and only a real boolean is accepted. This is the switch of the talk panel's REAL main AI (main-ai-claude.mjs), which must stay off until the measurement M6 says that
// `--tools ""` really leaves the child with no tool: the child reaches the same pipes as the Control Plane, so "no tools" is its only boundary. Off, the panel says it is not available.
function parseMainAi(raw) {
  if (raw === undefined) return false;
  if (typeof raw !== 'boolean') throw fail('main_ai');
  return raw;
}

/** Parse the file's text: `claude` and `ui` are required, `feedback` and `mainAi` are optional booleans (default false), `host` is ignored (the .NET host's). Pure. `installDir` is a test seam (default: CLAUDE_INSTALL_DIR). */
export function parseServiceConfig(text, { installDir = CLAUDE_INSTALL_DIR } = {}) {
  if (typeof text !== 'string' || text.length > MAX_SERVICE_CONFIG_BYTES) throw fail('too_big');
  let raw;
  try { raw = JSON.parse(text.replace(/^﻿/u, '')); } catch { throw fail('not_json'); }
  if (!isPlain(raw)) throw fail('invalid');
  if (Object.keys(raw).some((key) => !TOP_KEYS.includes(key))) throw fail('unknown_key');
  return Object.freeze({ claude: parseClaude(raw.claude, installDir), ui: parseUi(raw.ui), feedback: parseFeedback(raw.feedback), mainAi: parseMainAi(raw.mainAi), claudeInstallDir: installDir });
}

/** Read the service file (a regular file, small) and parse it. The error never names the path. */
export function loadServiceConfig(file, io = { statSync, readFileSync }, options) {
  let text;
  try {
    const stat = io.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SERVICE_CONFIG_BYTES) throw new Error('too_big');
    text = io.readFileSync(file, 'utf8');
  } catch { throw fail('unreadable'); }
  return parseServiceConfig(text, options);
}
