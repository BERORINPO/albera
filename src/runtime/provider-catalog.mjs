// Static provider readiness metadata for trusted Runtime API clients. It never probes or launches a CLI.
const PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'claude',
    status: 'profile-only',
    profiles: Object.freeze(['read-only', 'read-only-streaming']),
    profileMinimumVersions: Object.freeze({ 'read-only': '2.1.248', 'read-only-streaming': '2.1.259' }),
    runtimeValidation: 'synthetic-transport-only',
    inputTransport: true,
    eventTransport: 'lifecycle-only',
    unavailableReason: null,
  }),
  Object.freeze({
    id: 'codex',
    status: 'unavailable',
    profiles: Object.freeze([]),
    runtimeValidation: 'not-tested',
    inputTransport: false,
    eventTransport: 'none',
    unavailableReason: 'profile_unavailable',
  }),
  Object.freeze({
    id: 'opencode',
    status: 'unavailable',
    profiles: Object.freeze([]),
    runtimeValidation: 'not-tested',
    inputTransport: false,
    eventTransport: 'none',
    unavailableReason: 'profile_unavailable',
  }),
]);

/** Return fresh JSON-safe projections; this catalog does not inspect machine configuration or run providers. */
export function listRuntimeProviderCapabilities() {
  return PROVIDERS.map((provider) => ({
    ...provider,
    profiles: [...provider.profiles],
    profileMinimumVersions: { ...(provider.profileMinimumVersions ?? {}) },
  }));
}
