// Data shapes shared by every layer: the map (boxes / edges / changes) and its validator.
// No imports. Everything here is plain data or plain functions over plain data.

/** Role columns from left to right, then the outside column. */
export const ROLES = Object.freeze(['entry', 'adapter', 'core', 'shared']);
export const COLUMNS = Object.freeze([...ROLES, 'outside']);

/** Japanese column names shown on the map. */
export const COLUMN_NAMES = Object.freeze({
  entry: '入口',
  adapter: '外とのつなぎ',
  core: '中身の決まり',
  shared: 'データの形',
  outside: '外',
});

/** Change status of a file or a box within the period. */
export const STATUS = Object.freeze({ NEW: 'new', CHANGED: 'changed' });

export const MAP_VERSION = 1;

/** An error caused by the user's input. The CLI prints `message` (one line, with how to fix it) and exits 1. */
export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Check a finished map. Returns a list of problems (empty = valid).
 * The HTML trusts this shape, so render refuses a map with problems.
 */
export function validateMap(map) {
  const errors = [];
  if (!isObj(map)) return ['map is not an object'];
  if (map.version !== MAP_VERSION) errors.push(`version must be ${MAP_VERSION}`);
  for (const k of ['title', 'root', 'since', 'generatedAt']) if (!isStr(map[k])) errors.push(`${k} must be a string`);
  if (!Array.isArray(map.boxes)) return errors.concat('boxes must be an array');
  if (!Array.isArray(map.edges)) return errors.concat('edges must be an array');
  if (!Array.isArray(map.changes)) errors.push('changes must be an array');
  if (!Array.isArray(map.notices)) errors.push('notices must be an array');
  if (!Array.isArray(map.today)) errors.push('today must be an array');
  if (!isObj(map.prs)) errors.push('prs must be an object');

  const ids = new Set();
  for (const b of map.boxes) {
    if (!isObj(b) || !isStr(b.id)) { errors.push('box without id'); continue; }
    if (ids.has(b.id)) errors.push(`duplicate box id ${b.id}`);
    ids.add(b.id);
    if (!COLUMNS.includes(b.column)) errors.push(`box ${b.id} has unknown column ${b.column}`);
    if (!isStr(b.label)) errors.push(`box ${b.id} has no label`);
    if (!Array.isArray(b.files)) errors.push(`box ${b.id} files must be an array`);
    for (const k of ['x', 'y', 'w', 'h', 'lines']) if (!isNum(b[k])) errors.push(`box ${b.id} ${k} must be a number`);
    if (b.status !== null && !Object.values(STATUS).includes(b.status)) errors.push(`box ${b.id} has bad status`);
  }
  for (const e of map.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) errors.push(`edge ${e.from} -> ${e.to} points to a missing box`);
    if (!isNum(e.count) || e.count < 1) errors.push(`edge ${e.from} -> ${e.to} has bad count`);
    if (e.kind !== 'import' && e.kind !== 'outside') errors.push(`edge ${e.from} -> ${e.to} has bad kind`);
  }
  for (const id of map.today || []) if (!ids.has(id)) errors.push(`today points to missing box ${id}`);
  const edgeIds = new Set(map.edges.map((e) => e.id));
  if (!Array.isArray(map.stories)) errors.push('stories must be an array');
  else errors.push(...validateStories(map.stories, ids, edgeIds));
  return errors;
}

export const STEP_KINDS = Object.freeze(['overview', 'box', 'evidence', 'scene']);

const badLine = (l, ids, edgeIds) => !isObj(l) || !ids.has(l.from) || !ids.has(l.to) || !isStr(l.say) || (l.edge !== null && !edgeIds.has(l.edge)) || typeof l.back !== 'boolean';
const badFile = (f) => !isObj(f) || !isStr(f.path) || f.path.startsWith('/') || f.path.split('/').includes('..') || /^[A-Za-z]:/.test(f.path);

/** Practice questions: the answer boxes must exist, a path has no box twice, keys are unique in a story. */
function validateQuestions(s, ids, edgeIds) {
  const errors = [];
  if (!Array.isArray(s.questions)) return [`story ${s.key} questions must be an array`];
  const keys = new Set();
  s.questions.forEach((q, i) => {
    const at = `story ${s.key} question ${i + 1}`;
    if (!isObj(q) || !isStr(q.key) || !isStr(q.ask) || !isStr(q.how) || (q.kind !== 'path' && q.kind !== 'set') || (q.source !== 'auto' && q.source !== 'file')) { errors.push(`${at} is malformed`); return; }
    if (keys.has(q.key)) errors.push(`${at} duplicate key ${q.key}`);
    keys.add(q.key);
    if (!Array.isArray(q.boxes) || !q.boxes.length || q.boxes.some((b) => !ids.has(b)) || new Set(q.boxes).size !== q.boxes.length) errors.push(`${at} has bad answer boxes`);
    if (q.kind === 'path' && (!Array.isArray(q.boxes) || q.boxes.length < 2)) errors.push(`${at} path needs 2 boxes`);
    if (!Array.isArray(q.side) || q.side.some((b) => !ids.has(b))) errors.push(`${at} has a bad side box`);
    if (q.target !== null && !ids.has(q.target)) errors.push(`${at} target is missing`);
    if (!Array.isArray(q.lines) || q.lines.some((l) => badLine(l, ids, edgeIds))) errors.push(`${at} has a bad line`);
    for (const k of ['answer', 'names']) if (!Array.isArray(q[k]) || q[k].some((x) => !isStr(x))) errors.push(`${at} ${k} must be strings`);
    if (!Array.isArray(q.files) || q.files.some(badFile)) errors.push(`${at} has a bad file`);
    if (q.note !== null && !isStr(q.note)) errors.push(`${at} note must be a string or null`);
  });
  return errors;
}

/** The page trusts these: every box, line and edge a scene names must exist on the map. */
function validateStories(stories, ids, edgeIds) {
  const errors = [];
  const keys = new Set();
  for (const s of stories) {
    if (!isObj(s) || !isStr(s.key) || !isStr(s.title) || !Array.isArray(s.steps) || !s.steps.length) { errors.push('story without key, title or steps'); continue; }
    if (keys.has(s.key)) errors.push(`duplicate story key ${s.key}`);
    keys.add(s.key);
    if (s.pr !== null && !Number.isInteger(s.pr)) errors.push(`story ${s.key} has bad pr`);
    if (s.source !== 'auto' && s.source !== 'file') errors.push(`story ${s.key} has bad source`);
    errors.push(...validateQuestions(s, ids, edgeIds));
    s.steps.forEach((t, i) => {
      const at = `story ${s.key} step ${i + 1}`;
      if (!isObj(t) || !STEP_KINDS.includes(t.kind) || !isStr(t.title) || !isStr(t.say)) { errors.push(`${at} is malformed`); return; }
      if (!Array.isArray(t.boxes) || !t.boxes.length || t.boxes.some((b) => !ids.has(b))) errors.push(`${at} points to a missing box`);
      if (t.lead !== null && !ids.has(t.lead)) errors.push(`${at} lead is missing`);
      if (!Array.isArray(t.lines) || t.lines.some((l) => !isObj(l) || !ids.has(l.from) || !ids.has(l.to) || !isStr(l.say) || (l.edge !== null && !edgeIds.has(l.edge)) || typeof l.back !== 'boolean')) errors.push(`${at} has a bad line`);
      if (!Array.isArray(t.names) || t.names.some((n) => !isStr(n))) errors.push(`${at} names must be strings`);
      if (!Array.isArray(t.files) || t.files.some((f) => !isObj(f) || !isStr(f.path) || f.path.startsWith('/') || f.path.split('/').includes('..') || /^[A-Za-z]:/.test(f.path))) errors.push(`${at} has a bad file`);
      if (t.note !== null && !isStr(t.note)) errors.push(`${at} note must be a string or null`);
    });
  }
  return errors;
}
