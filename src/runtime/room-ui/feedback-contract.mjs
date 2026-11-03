// Node-side stand-in only. In the browser the page asks for ./feedback-contract.mjs and room-host.mjs answers with the real src/runtime/feedback-contract.mjs (its fixed UI table),
// so this file is never served. Node tools and tests that import room-ui modules (api.mjs, feedback.mjs) resolve here, to the same module. Keep it one line: do not add names.
export * from '../feedback-contract.mjs'; // arch-allow: Node-side stand-in for the file the host serves at this URL (see the comment above)
