// Fake of the main AI adapter (main-ai-claude.mjs): the same `turn({ words, state })`, `stop()` and `close()`, with the model's answers written by the test. Nothing here starts a process, reads a
// credential or talks to Anthropic. It plays the replies in order; a reply is
//   - a string: the model's text, as the real adapter returns it (so a test can feed garbage, a fenced reply or a very long one),
//   - a result object `{ ok: false, code }` or `{ ok: true, text }`, returned as is (a test can make the adapter fail, or lie),
//   - a function `(input) => string | object`, called with a copy of what `turn` was given.
// When the replies run out it answers `{ ok: false, code: 'no_reply' }`. `hold` (a promise) keeps every turn in flight until it settles, to try `busy`. `calls` has a copy of every input.

/** The text a well-behaved model returns for a reply object. */
export const fakeReply = (reply) => JSON.stringify(reply);

export function createFakeMainAi({ replies = [], hold = null } = {}) {
  const calls = [];
  const state = { next: 0, stops: 0, closed: false };
  const asResult = (reply) => (typeof reply === 'string' ? { ok: true, text: reply } : reply);

  return {
    calls,
    get stops() { return state.stops; },
    get closed() { return state.closed; },
    async turn(input) {
      calls.push(structuredClone(input));
      if (hold) await hold;
      const reply = replies[state.next];
      state.next += 1;
      if (reply === undefined) return { ok: false, code: 'no_reply' };
      return asResult(typeof reply === 'function' ? reply(structuredClone(input)) : reply);
    },
    stop() { state.stops += 1; },
    async close() { state.closed = true; },
  };
}
