import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventsEl, eventSummaryEl } from '../public/events.mjs';

function withDocument(fn) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      return {
        tag, attrs: {}, children: [], className: '',
        setAttribute(name, value) { this.attrs[name] = String(value); },
        append(child) { this.children.push(child); },
        set textContent(value) { this._text = String(value); },
        get textContent() { return this._text ?? this.children.map((child) => child.textContent ?? '').join(''); },
      };
    },
    createTextNode(text) { return { textContent: String(text) }; },
  };
  try { return fn(); } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

const t = (key) => ({
  'detail.events': 'Recent events',
  'detail.eventsUnavailable': 'No safe event summaries are available.',
  'event.turnStarted': 'Turn started',
}[key] ?? key);

test('event detail renders an empty state without provider payloads', () => {
  withDocument(() => {
    const section = eventsEl(t, { source: 'opencode', events: [{ type: 'unknown_secret', at: 2000, prompt: 'PRIVATE-PROMPT' }] });
    assert.equal(section.tag, 'section');
    assert.equal(section.className, 'detail__events');
    assert.deepEqual(section.children.map((child) => child.textContent), ['Recent events', 'No safe event summaries are available.']);
    assert.equal(section.textContent.includes('PRIVATE-'), false);
  });
});

test('event detail timeline emits only the allowlisted label and timestamp', () => {
  withDocument(() => {
    const section = eventsEl(t, { source: 'codex', events: [{ type: 'turn_started', at: 1_700_000_000_000, input: 'PRIVATE-TOOL-INPUT' }] });
    assert.equal(section.tag, 'section');
    const list = section.children[1];
    assert.equal(list.tag, 'ol');
    const row = list.children[0];
    assert.equal(row.tag, 'li');
    assert.equal(row.textContent.includes('PRIVATE-'), false);
    assert.equal(row.children[0].tag, 'time');
    assert.equal(row.children[0].attrs.datetime, '2023-11-14T22:13:20.000Z');
    assert.match(row.children[0].textContent, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(row.textContent.includes('Turn started'), true);
  });
});

test('canvas event summary includes its display timestamp', () => {
  withDocument(() => {
    const summary = eventSummaryEl(t, { source: 'codex', events: [{ type: 'turn_started', at: 1_700_000_000_000 }] });
    assert.equal(summary.tag, 'span');
    assert.match(summary.children[0].textContent, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(summary.textContent.includes('Turn started'), true);
  });
});
