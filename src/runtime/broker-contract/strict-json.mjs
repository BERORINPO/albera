// Strict JSON reader shared by the receipt v2 and action DTO contract (the C# twin is StrictJson.cs; test-vectors.json pins both).
// Accepts only: objects, strings, booleans and safe integers (|n| <= 2^53-1). Rejects null, arrays, fractions, exponents, "-0",
// leading zeros, duplicate keys, lone surrogates (raw or \u-escaped), raw control characters, comments, trailing commas, trailing data
// and nesting deeper than maxDepth. Pure: no I/O, no clock.

export class StrictJsonError extends Error {
  constructor() { super('malformed_json'); this.name = 'StrictJsonError'; this.code = 'malformed_json'; }
}

const NUMBER_RE = /-?(?:0|[1-9][0-9]*)/y;
const ESCAPES = Object.freeze({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' });

/** @param {string} text @param {number} [maxDepth] @returns {Record<string, unknown>} a root object with null prototype */
export function parseStrictJson(text, maxDepth = 3) {
  if (typeof text !== 'string') throw new StrictJsonError();
  let i = 0;
  const fail = () => { throw new StrictJsonError(); };
  const skip = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++; };

  function string() {
    i++; // opening quote
    let out = '';
    for (;;) {
      if (i >= text.length) fail();
      const c = text[i++];
      if (c === '"') break;
      if (c.charCodeAt(0) < 0x20) fail();
      if (c !== '\\') { out += c; continue; }
      const e = text[i++];
      if (e === undefined) fail();
      if (e === 'u') {
        const hex = text.slice(i, i + 4);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail();
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
      } else if (Object.hasOwn(ESCAPES, e)) out += ESCAPES[e];
      else fail();
    }
    if (!out.isWellFormed()) fail();
    return out;
  }

  function number() {
    NUMBER_RE.lastIndex = i;
    if (!NUMBER_RE.test(text)) fail();
    const token = text.slice(i, NUMBER_RE.lastIndex);
    i = NUMBER_RE.lastIndex;
    if (token === '-0' || /[.eE0-9]/.test(text[i] ?? '')) fail();
    const n = Number(token);
    if (!Number.isSafeInteger(n)) fail();
    return n;
  }

  function literal(word, result) {
    if (text.slice(i, i + word.length) !== word) fail();
    i += word.length;
    return result;
  }

  function object(depth) {
    if (depth > maxDepth) fail();
    i++; // {
    const obj = Object.create(null);
    skip();
    if (text[i] === '}') { i++; return obj; }
    for (;;) {
      skip();
      if (text[i] !== '"') fail();
      const key = string();
      skip();
      if (text[i++] !== ':') fail();
      const v = value(depth);
      if (Object.hasOwn(obj, key)) fail(); // duplicate key
      obj[key] = v;
      skip();
      const c = text[i++];
      if (c === '}') return obj;
      if (c !== ',') fail();
    }
  }

  function value(depth) {
    skip();
    const c = text[i];
    if (c === '{') return object(depth + 1);
    if (c === '"') return string();
    if (c === 't') return literal('true', true);
    if (c === 'f') return literal('false', false);
    return number();
  }

  skip();
  if (text[i] !== '{') fail();
  const root = object(1);
  skip();
  if (i !== text.length) fail();
  return root;
}
