// A just-enough DOM for the room page's panels (room-ui/*.mjs run `boot()` when a `document` exists). There is no browser and no jsdom in the test run, so this is the smallest thing that
// lets a panel build its elements, receive events and be read back: nodes with children, text, attributes, a class list, hidden / disabled / value, and event listeners.
// It is not a model of the web platform: layout, focus, scrolling and styling are not here (the screens are checked by eye).

class FakeText {
  constructor(text) { this.text = String(text); }
  get textContent() { return this.text; }
}

export class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.className = '';
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.own = '';
    const node = this;
    this.classList = {
      names: new Set(),
      toggle(name, on) { if (on) this.names.add(name); else this.names.delete(name); },
      has: (name) => node.classList.names.has(name) || node.className.split(/\s+/u).includes(name),
    };
  }

  set textContent(value) { this.children = []; this.own = String(value); }
  get textContent() { return this.own + this.children.map((child) => child.textContent).join(''); }
  append(...items) { for (const item of items) this.children.push(typeof item === 'string' ? new FakeText(item) : item); }
  replaceChildren(...items) { this.children = []; this.own = ''; this.append(...items); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); }
  focus() {}

  /** Run the listeners of `type` like the browser would (they are not awaited: a handler that starts async work leaves it running). */
  fire(type, event = {}) { for (const handler of this.listeners[type] ?? []) handler({ preventDefault() {}, target: this, ...event }); }

  /** Every descendant (depth first), for the tests to find an element by tag or class. */
  *descendants() {
    for (const child of this.children) { if (child instanceof FakeNode) { yield child; yield* child.descendants(); } }
  }

  byClass(name) { return [...this.descendants()].find((node) => node.classList.has(name)); }
  byTag(tag) { return [...this.descendants()].find((node) => node.tag === tag); }
}

/** @param {string[]} ids the elements `getElementById` knows: id -> a FakeNode of the tag in `tags`. @returns {{ document: object, byId: Record<string, FakeNode>, body: FakeNode }} */
export function makeFakeDocument(tags) {
  const byId = Object.fromEntries(Object.entries(tags).map(([id, tag]) => [id, new FakeNode(tag)]));
  const body = new FakeNode('body');
  const document = {
    getElementById: (id) => byId[id] ?? null,
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => new FakeText(text),
    body,
  };
  return { document, byId, body };
}
