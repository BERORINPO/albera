import { FEEDBACK_ENDPOINT } from './feedback-contract.mjs';

// The room's feedback panel (docs/architecture/feedback-intake.md; room-ui/feedback.mjs). One route for room-host.mjs `apiRoutes`; the host checks Sec-Fetch-Site and the session cookie before the handler runs.
//
//   GET /api/feedback -> { ok: true, endpoint, version }
//
// The panel asks it for two things: whether feedback is on in this room (a room with feedback off registers no route, so the answer is 404) and the ALBERA version it puts in the request
// (the one thing about this installation that is sent). Nothing else about the machine or the room is read: no OS, no errors, no journal. The version is checked here before it is sent on: printable
// ASCII, 1 to 64 characters (the contract's rule for it); anything else is reported as 'unknown'. Nothing here reads a file, the clock or the environment (arch rule 5e).

const VERSION_RE = /^[\x20-\x7e]{1,64}$/u;
export const UNKNOWN_VERSION = 'unknown';

/** The version as the request may carry it, or 'unknown'. */
export const projectVersion = (version) => (typeof version === 'string' && VERSION_RE.test(version) ? version : UNKNOWN_VERSION);

/**
 * @param {{ version?: string }} [options] the ALBERA version the room reports (room-service-wiring.mjs); 'unknown' when there is none
 * @returns {readonly object[]} routes for createRoomHost({ apiRoutes })
 */
export function createRoomFeedbackRoutes({ version = UNKNOWN_VERSION } = {}) {
  const body = Object.freeze({ ok: true, endpoint: FEEDBACK_ENDPOINT, version: projectVersion(version) });
  return Object.freeze([Object.freeze({ method: 'GET', path: '/api/feedback', handle: () => ({ status: 200, body }) })]);
}
