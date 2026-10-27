// Project only the GPT-Live caption deltas that are safe to display.
const ALLOWED = new Map([
  ['session.input_transcript.delta', 'user'],
  ['session.output_transcript.delta', 'assistant'],
]);

/** @param {unknown} event */
export function projectVoiceDelta(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const item = /** @type {Record<string, unknown>} */ (event);
  const role = ALLOWED.get(String(item.type ?? ''));
  if (!role || typeof item.delta !== 'string' || !item.delta || item.delta.length > 4096) return null;
  return { role, delta: item.delta };
}
