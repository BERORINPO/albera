/**
 * Fake computer-use client for tests: returns a scripted list of responses and records a deep copy
 * of every message array it was sent (so a later mutation of an earlier request would show up).
 * A script entry is a response `{content, stopReason, usage}`, an Error to throw, or a function
 * `(messages) => response | Error` for tests that need to act while a request is in flight.
 */
export function createFakeComputerUseClient(script = []) {
  const queue = [...script];
  const calls = [];
  return {
    calls,
    get remaining() { return queue.length; },
    async send(messages, system, options = {}) {
      calls.push({ messages: structuredClone(messages), system, signal: options.signal });
      if (queue.length === 0) throw new Error('fake_script_exhausted');
      let entry = queue.shift();
      if (typeof entry === 'function') entry = entry(messages);
      if (entry instanceof Error) throw entry;
      return entry;
    },
  };
}

export function fakeToolUse(name, input = {}, id = `toolu_${name}`) {
  return { type: 'tool_use', id, name, toolset_name: 'computer', input };
}

export function fakeReply(content, { stopReason = 'tool_use', usage = { input_tokens: 100, output_tokens: 10 } } = {}) {
  return { content, stopReason, usage };
}

export function fakeText(text, stopReason = 'end_turn', usage) {
  return fakeReply([{ type: 'text', text }], { stopReason, usage });
}
