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

/** @param {Array<{role:'user'|'assistant',text:string}>} rows @param {{role:'user'|'assistant',delta:string}} caption */
export function appendVoiceCaption(rows, caption) {
  if (!Array.isArray(rows) || !caption || !['user', 'assistant'].includes(caption.role) || typeof caption.delta !== 'string' || !caption.delta || caption.delta.length > 4096) return rows;
  const last = rows.at(-1);
  if (last?.role === caption.role && last.text.length + caption.delta.length <= 100_000) return [...rows.slice(0, -1), { role: last.role, text: last.text + caption.delta }];
  return [...rows, { role: caption.role, text: caption.delta }];
}
