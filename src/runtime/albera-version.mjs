// The ALBERA version the runtime reports (the feedback panel sends it with a report: not a secret, and needed to reproduce a bug).
// The Control Plane app tree is src/runtime only and its package.json is generated without a version, so the runtime keeps its own copy here.
// test/runtime-albera-version.test.mjs fails when it differs from the repository's package.json: change both together.
export const ALBERA_VERSION = '0.2.0';
