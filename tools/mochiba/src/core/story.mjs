// The story mode ("紙芝居"): scenes that walk through one PR on the map.
// Two sources: made here from git and the tables (no AI), or a --story JSON written by any AI and checked here.
import { COLUMN_NAMES, InputError, ROLES } from '../shared/map-shape.mjs';

export const STORY_LIMITS = Object.freeze({ boxSteps: 8, steps: 30, title: 40, say: 200, note: 200, names: 12, name: 60, files: 12, lines: 12, lineSay: 60 });
const NO_PR = 'nopr';

export const cut = (s, n) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const delta = (a, d) => `+${a} −${d}`;

/** Which map edge a scene line rides on: same direction, or the reverse one with the light running back. */
export function lineOnMap(edges, from, to) {
  const same = edges.find((e) => e.from === from && e.to === to);
  if (same) return { edge: same.id, back: false };
  const rev = edges.find((e) => e.from === to && e.to === from);
  if (rev) return { edge: rev.id, back: true };
  return { edge: null, back: false };
}

const edgeSay = (e) => cut((e.names || []).slice(0, 3).join('・') + ((e.names || []).length > 3 || e.more ? ' ほか' : ''), STORY_LIMITS.lineSay);

/** Commits grouped by PR number (null -> "nopr"), newest PR first, the no-PR group last. */
function groupByPr(changes) {
  const groups = new Map();
  for (const c of changes) {
    const key = c.pr === null || c.pr === undefined ? NO_PR : String(c.pr);
    groups.set(key, [...(groups.get(key) || []), c]);
  }
  return [...groups].sort(([a], [b]) => (a === NO_PR) - (b === NO_PR) || Number(b) - Number(a));
}

/** Per file: lines added / deleted over the commits, and whether one of them created it. */
export function fileDelta(commits) {
  const out = new Map();
  for (const c of commits) {
    for (const f of c.files) {
      const d = out.get(f.path) || { added: 0, deleted: 0, created: false };
      out.set(f.path, { ...d, added: d.added + f.added, deleted: d.deleted + f.deleted });
    }
    for (const p of c.created || []) if (out.has(p)) out.set(p, { ...out.get(p), created: true });
  }
  return out;
}

function boxStep(box, changedIds, edges, files, commits) {
  const mine = box.files.map((f) => f.path).filter((p) => files.has(p));
  const added = mine.reduce((n, p) => n + files.get(p).added, 0);
  const deleted = mine.reduce((n, p) => n + files.get(p).deleted, 0);
  const created = mine.filter((p) => files.get(p).created).length;
  // Lines to the other boxes this PR changed, and to the outside partners of this box.
  const wires = edges.filter((e) => (e.from === box.id && (changedIds.has(e.to) || e.kind === 'outside')) || (e.to === box.id && changedIds.has(e.from)));
  const subjects = [...new Set(commits.filter((c) => c.files.some((f) => mine.includes(f.path))).map((c) => c.subject))];
  const col = COLUMN_NAMES[box.column] || box.column;
  const what = created ? `${mine.length} ファイル変わった (うち新しいファイル ${created})` : `${mine.length} ファイル変わった`;
  return {
    kind: 'box',
    title: cut(box.label, STORY_LIMITS.title),
    say: cut(`${col}の「${box.label}」で ${what} ${delta(added, deleted)}`, STORY_LIMITS.say),
    boxes: [box.id, ...new Set(wires.map((e) => (e.from === box.id ? e.to : e.from)))],
    lead: box.id,
    lines: wires.slice(0, STORY_LIMITS.lines).map((e) => ({ from: e.from, to: e.to, say: edgeSay(e), edge: e.id, back: false })),
    names: [],
    files: mine.map((p) => ({ path: p, added: files.get(p).added, deleted: files.get(p).deleted, changed: true })),
    note: subjects.length ? cut(`commit: ${subjects.slice(0, 2).join(' / ')}${subjects.length > 2 ? ` ほか ${subjects.length - 2}` : ''}`, STORY_LIMITS.note) : null,
  };
}

function autoStory(key, commits, boxes, edges, prs) {
  const files = fileDelta(commits);
  const order = (b) => ROLES.indexOf(b.column);
  const changed = boxes
    .filter((b) => b.column !== 'outside' && b.files.some((f) => files.has(f.path)))
    .map((b) => ({ b, lines: b.files.reduce((n, f) => n + (files.has(f.path) ? files.get(f.path).added + files.get(f.path).deleted : 0), 0) }));
  if (!changed.length) return null;
  const shown = [...changed].sort((x, y) => y.lines - x.lines || x.b.label.localeCompare(y.b.label, 'ja')).slice(0, STORY_LIMITS.boxSteps)
    .sort((x, y) => order(x.b) - order(y.b) || y.lines - x.lines || x.b.label.localeCompare(y.b.label, 'ja'))
    .map((x) => x.b);
  const changedIds = new Set(changed.map((x) => x.b.id));
  const pr = key === NO_PR ? null : Number(key);
  const info = pr === null ? null : prs[pr];
  const all = [...files].filter(([p]) => boxes.some((b) => b.files.some((f) => f.path === p)));
  const left = changed.length - shown.length;
  const overview = {
    kind: 'overview',
    title: '変わった箱',
    say: pr === null ? `PR を通っていない変更。変わった箱は ${changed.length} 個、入口の側から順に見る` : `この PR で変わった箱は ${changed.length} 個。入口の側から順に見る`,
    boxes: [...changedIds],
    lead: null,
    lines: [],
    names: [],
    files: all.slice(0, STORY_LIMITS.files).map(([path, d]) => ({ path, added: d.added, deleted: d.deleted, changed: true })),
    note: left > 0 ? `ほか ${left} 箱は一覧で (コマにしたのは行数の多い ${shown.length} 箱)` : null,
  };
  const steps = [overview, ...shown.map((b) => boxStep(b, changedIds, edges, files, commits))];
  if (info && !info.missing) {
    steps.push({
      kind: 'evidence', title: '証拠', say: cut(info.reason ? `理由: ${info.reason}` : `${info.title} (PR の本文は空)`, STORY_LIMITS.say),
      boxes: [...changedIds], lead: null, lines: [], names: [], files: [], note: info.ci.text,
    });
  }
  const title = pr === null ? 'PR なしの変更' : info && !info.missing ? `#${pr} ${info.title}` : `#${pr}`;
  return { key, pr, title: cut(title, 80), source: 'auto', steps };
}

/**
 * Stories made without AI: one per PR in the period (newest first), plus one for commits outside any PR.
 * @param {{boxes, edges, changes, prs}} map parts; changes still carry `created`
 */
export function autoStories({ boxes, edges, changes, prs }) {
  return groupByPr(changes).map(([key, commits]) => autoStory(key, commits, boxes, edges, prs)).filter(Boolean);
}

// ---------- --story JSON ----------
const SHAPE_HINT = '{ "pr": 183, "title": "...", "steps": [ { "say": "...", "boxes": ["entry:..."] } ] } の形にする';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strOr = (v, d) => (typeof v === 'string' && v.trim() ? v : d);

/** A path the page may open: relative, inside the folder, no drive, no control characters. */
export function safeRelPath(p) {
  if (typeof p !== 'string') return null;
  const s = p.trim().replace(/\\/g, '/');
  if (!s || /[\u0000-\u001f]/.test(s) || s.startsWith('/') || /^[A-Za-z]:/.test(s) || /^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
  const parts = s.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}

function readStep(raw, i, ctx) {
  const where = `${ctx.where} の ${i + 1} コマ目`;
  if (!isObj(raw) || !strOr(raw.say, null)) { ctx.drop(`${where} (say が無い)`); return null; }
  const wanted = Array.isArray(raw.boxes) ? raw.boxes.filter((b) => typeof b === 'string') : [];
  const boxes = [...new Set(wanted.filter((b) => ctx.ids.has(b)))];
  for (const b of wanted) if (!ctx.ids.has(b)) ctx.unknown.add(b);
  const lines = [];
  for (const l of Array.isArray(raw.lines) ? raw.lines.slice(0, STORY_LIMITS.lines) : []) {
    if (!isObj(l) || !ctx.ids.has(l.from) || !ctx.ids.has(l.to) || l.from === l.to) { ctx.drop(`${where} の線 (無い箱を指す)`); continue; }
    for (const b of [l.from, l.to]) if (!boxes.includes(b)) boxes.push(b);
    lines.push({ from: l.from, to: l.to, say: cut(strOr(l.say, ''), STORY_LIMITS.lineSay), ...lineOnMap(ctx.edges, l.from, l.to) });
  }
  // The main box counts as lit even when the AI left it out of boxes.
  if (typeof raw.lead === 'string' && raw.lead) {
    if (!ctx.ids.has(raw.lead)) ctx.unknown.add(raw.lead);
    else if (!boxes.includes(raw.lead)) boxes.push(raw.lead);
  }
  if (!boxes.length) { ctx.drop(`${where} (地図にある箱が 1 つも無い)`); return null; }
  const files = [];
  for (const f of Array.isArray(raw.files) ? raw.files.slice(0, STORY_LIMITS.files) : []) {
    const path = safeRelPath(f);
    if (!path) { ctx.drop(`${where} のファイル (フォルダの外を指す)`); continue; }
    if (!ctx.mapFiles.has(path)) { ctx.drop(`${where} のファイル (地図に無い: ${path})`); continue; }
    if (files.some((x) => x.path === path)) continue;
    const d = ctx.delta.get(path);
    files.push({ path, added: d ? d.added : 0, deleted: d ? d.deleted : 0, changed: !!d });
  }
  return {
    kind: 'scene',
    title: cut(strOr(raw.title, raw.say), STORY_LIMITS.title),
    say: cut(raw.say, STORY_LIMITS.say),
    boxes,
    lead: boxes.includes(raw.lead) ? raw.lead : null,
    lines,
    names: (Array.isArray(raw.names) ? raw.names : []).filter((n) => typeof n === 'string' && n.trim()).slice(0, STORY_LIMITS.names).map((n) => cut(n, STORY_LIMITS.name)),
    files,
    note: strOr(raw.note, null) && cut(raw.note, STORY_LIMITS.note),
  };
}

/** A PR number written as 183, "183" or "#183"; anything else is null. */
function prNumber(v) {
  const n = typeof v === 'string' && /^#?\d{1,9}$/.test(v.trim()) ? Number(v.trim().replace('#', '')) : v;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function readStory(raw, i, ctx) {
  if (!isObj(raw) || !Array.isArray(raw.steps) || !raw.steps.length) throw new InputError(`--story の ${i + 1} 本目に steps が無い: ${SHAPE_HINT}`);
  const pr = prNumber(raw.pr);
  const where = `--story の ${pr ? `#${pr}` : `${i + 1} 本目`}`;
  if (pr === null && raw.pr != null) ctx.notices.push(`${where} の pr「${cut(String(raw.pr), 20)}」は PR 番号として読めないので、PR なしの紙芝居にした`);
  // Line counts on file badges come from this PR's own commits, like the automatic story it replaces.
  const delta = fileDelta(pr === null ? ctx.changes : ctx.changes.filter((c) => c.pr === pr));
  if (raw.steps.length > STORY_LIMITS.steps) ctx.notices.push(`${where} は ${raw.steps.length} コマあり、最初の ${STORY_LIMITS.steps} コマだけ使った`);
  const steps = raw.steps.slice(0, STORY_LIMITS.steps).map((s, k) => readStep(s, k, { ...ctx, where, delta })).filter(Boolean);
  if (!steps.length) { ctx.notices.push(`${where} は使えるコマが無いので飛ばした`); return null; }
  const title = strOr(raw.title, pr ? `#${pr}` : '紙芝居');
  if (raw.questions != null && !Array.isArray(raw.questions)) ctx.notices.push(`${where} の questions は配列でないので使わなかった`);
  // Questions are checked later by quiz.mjs (it needs the PR's changed boxes); keep them raw until then.
  return { key: pr ? String(pr) : `file-${i + 1}`, pr, title: cut(pr && !title.includes(`#${pr}`) ? `#${pr} ${title}` : title, 80), source: 'file', steps, rawQuestions: Array.isArray(raw.questions) ? raw.questions : [] };
}

/**
 * Check a --story JSON against the map and merge it with the automatic stories.
 * A story for a PR replaces that PR's automatic story; stories without a PR come first.
 * Parts that do not fit the map are dropped and named in the notices; a wrong overall shape is an InputError.
 * @returns {{ stories: object[], notices: string[] }}
 */
export function mergeStoryFile(raw, { boxes, edges, changes }, auto) {
  if (raw == null) return { stories: auto, notices: [] };
  const list = isObj(raw) && Array.isArray(raw.stories) ? raw.stories : isObj(raw) && Array.isArray(raw.steps) ? [raw] : null;
  if (!list || !list.length) throw new InputError(`--story の JSON の形が違う: ${SHAPE_HINT}`);
  const notices = [], dropped = [], unknown = new Set();
  const mapFiles = new Set(boxes.flatMap((b) => b.files.map((f) => f.path)));
  const ctx = { ids: new Set(boxes.map((b) => b.id)), edges, changes, mapFiles, notices, unknown, drop: (m) => dropped.push(m) };
  const fromFile = list.map((s, i) => readStory(s, i, ctx)).filter(Boolean);
  if (unknown.size) notices.push(`--story に地図に無い箱 ${unknown.size} 個 (${[...unknown].slice(0, 3).join(' ・ ')}${unknown.size > 3 ? ' ほか' : ''})。その箱は飛ばした`);
  if (dropped.length) notices.push(`--story の一部を飛ばした ${dropped.length} 件: ${dropped.slice(0, 3).join(' ・ ')}${dropped.length > 3 ? ' ほか' : ''}`);
  const seen = new Set();
  for (const s of fromFile) {
    if (seen.has(s.key)) notices.push(`--story に #${s.pr} が 2 本以上ある。最初の 1 本だけ使った`);
    seen.add(s.key);
  }
  const byPr = new Set(fromFile.filter((s) => s.pr !== null).map((s) => s.pr));
  const keys = new Set();
  const stories = [...fromFile, ...auto.filter((s) => s.pr === null || !byPr.has(s.pr))].filter((s) => (keys.has(s.key) ? false : keys.add(s.key)));
  return { stories, notices };
}
