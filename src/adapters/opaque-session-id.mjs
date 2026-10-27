// adapter helper: keep provider-native session IDs out of public board identifiers.
import { createHash } from 'node:crypto';

/** Produce a stable, provider-scoped UUID-shaped key without retaining the provider ID in the key. @param {'codex'|'copilot'} source @param {string} providerId */
export function opaqueProviderSessionId(source, providerId) {
  const hex = createHash('sha256').update(`${source}\0${providerId}`).digest('hex').slice(0, 32);
  return `${source}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
