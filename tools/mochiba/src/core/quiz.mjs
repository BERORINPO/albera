// Practice ("説明の練習"): questions answered by pointing at boxes on the map, checked against the map data.
// Questions come from the map itself (no AI), and from the "questions" of a --story JSON written by any AI.
import { COLUMN_NAMES } from '../shared/map-shape.mjs';
import { cut, fileDelta, lineOnMap, safeRelPath } from './story.mjs';

export const QUIZ_LIMITS = Object.freeze({ side: 8, perStory: 8, auto: 3, ask: 120, how: 80, answer: 120, answerLines: 2, names: 12, name: 60, files: 12, note: 200, say: 60, path: 8, set: 12, toolUsersMin: 3, toolUsersMax: 6, usesMin: 2, usesMax: 6 });
// Words the import scanner writes when it cannot name what is taken; they are not tools a person can point at.
const NOT_A_NAME = /^(画面で読み込む|丸ごと読み込む|そのまま外へ渡す|必要な時に読み込む)$|\(全部\)$/;
const isConst = (n) => /^[A-Z0-9_]+$/.test(n);
const label = (box) => `「${box.label}」`;
// The same feature name sits in several layers (名簿 in core and in shared), so a list names the layer too.
const named = (box) => `${box.label} (${COLUMN_NAMES[box.column] || box.column})`;

// ---------- questions made from the map (no AI) ----------
function changedQuestion(changed, pr) {
  if (changed.length < 2) return null;
  return {
    key: 'changed', kind: 'set', source: 'auto', target: null,
    ask: pr === null ? 'この変更で変わった箱はどれ？ 全部押して' : 'この PR で変わった箱はどれ？ 全部押して',
    how: `順番は自由 ・ 答えは ${changed.length} 箱`,
    boxes: changed.map((b) => b.id), side: [], lines: [],
    answer: [cut(`変わった箱は ${changed.length} 個: ${changed.map(named).join('・')}`, QUIZ_LIMITS.answer), '紙芝居の 1 コマ目で光る箱と同じ (地図で光るのは期間の全部の変更)'],
    names: [], files: [], note: '作り方: この PR の commit が触ったファイルを含む箱 (AI は使っていない)',
  };
}

/** A tool in a changed shared box that 3-6 boxes use. Only names every line into the box is sure about. */
function toolQuestion(changed, edges, boxById) {
  const changedIds = new Set(changed.map((b) => b.id));
  for (const target of changed.filter((b) => b.column === 'shared')) {
    const into = edges.filter((e) => e.to === target.id && e.kind === 'import');
    const users = new Map();
    for (const e of into) for (const n of e.names || []) if (!NOT_A_NAME.test(n)) users.set(n, new Map([...(users.get(n) || []), [e.from, e]]));
    // A line whose name list was cut (more > 0) or never says what it takes (partial: a namespace import, a whole
    // file, a global place used without a name) may use a name without listing it; such names are not certain.
    const unsure = into.filter((e) => e.more > 0 || e.partial);
    const cands = [...users]
      .filter(([n, m]) => m.size >= QUIZ_LIMITS.toolUsersMin && m.size <= QUIZ_LIMITS.toolUsersMax && unsure.every((e) => m.has(e.from)))
      .map(([name, m]) => ({ name, users: [...m.values()], inChanged: [...m.keys()].filter((id) => changedIds.has(id)).length }))
      .sort((p, q) => q.inChanged - p.inChanged || isConst(p.name) - isConst(q.name) || q.users.length - p.users.length || p.name.localeCompare(q.name));
    if (!cands.length) continue;
    const c = cands[0];
    return {
      key: `tool:${c.name}`, kind: 'set', source: 'auto', target: target.id,
      ask: cut(`「データの形」の${label(target)}にある ${c.name}。これを使っている箱はどれ？ 全部押して`, QUIZ_LIMITS.ask),
      how: `順番は自由 ・ 答えは ${c.users.length} 箱`,
      boxes: c.users.map((e) => e.from), side: [],
      lines: c.users.map((e) => ({ from: e.from, to: target.id, say: c.name, edge: e.id, back: false })),
      answer: [`${c.name} を使う箱は ${c.users.length} つ`, cut(`だから${label(target)}の ${c.name} を変えると、この ${c.users.length} 箱に響きうる`, QUIZ_LIMITS.answer)],
      names: [c.name], files: [], note: `作り方: ${label(target)}へ入る線の名前から自動で選んだ (候補 ${cands.length} 個、AI は使っていない)`,
    };
  }
  return null;
}

function usesQuestion(changed, edges, boxById) {
  for (const box of changed) {
    const out = edges.filter((e) => e.from === box.id);
    if (out.length < QUIZ_LIMITS.usesMin || out.length > QUIZ_LIMITS.usesMax) continue;
    return {
      key: `uses:${box.id}`, kind: 'set', source: 'auto', target: box.id,
      ask: cut(`${COLUMN_NAMES[box.column] || box.column}の${label(box)}が使っている箱はどれ？ 全部押して`, QUIZ_LIMITS.ask),
      how: `順番は自由 ・ 答えは ${out.length} 箱`,
      boxes: out.map((e) => e.to), side: [],
      lines: out.map((e) => ({ from: e.from, to: e.to, say: cut((e.names || []).slice(0, 2).join('・'), QUIZ_LIMITS.say), edge: e.id, back: false })),
      answer: [cut(`${label(box)}が使うのは ${out.map((e) => named(boxById.get(e.to))).join('・')}`, QUIZ_LIMITS.answer), '線の向きは「使う側 → 使われる側」。光の粒が流れる向き'],
      names: [], files: [], note: '作り方: この箱から出る線を数えた (AI は使っていない)',
    };
  }
  return null;
}

/**
 * Up to 3 questions from the map alone, for the boxes one change touched.
 * @param {object[]} changed changed boxes (not outside), biggest change first
 */
export function autoQuestions(changed, pr, { edges, boxes }) {
  const boxById = new Map(boxes.map((b) => [b.id, b]));
  return [changedQuestion(changed, pr), toolQuestion(changed, edges, boxById), usesQuestion(changed, edges, boxById)].filter(Boolean).slice(0, QUIZ_LIMITS.auto);
}

// ---------- questions from a --story JSON ----------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);

function readQuestion(raw, i, ctx) {
  const where = `${ctx.where} の問い ${i + 1}`;
  if (!isObj(raw) || typeof raw.ask !== 'string' || !raw.ask.trim()) { ctx.drop(`${where} (ask が無い)`); return null; }
  const isPath = Array.isArray(raw.path);
  const list = isPath ? raw.path : raw.set;
  if (!Array.isArray(list) || isPath === Array.isArray(raw.set)) { ctx.drop(`${where} (path か set のどちらか 1 つが要る)`); return null; }
  const max = isPath ? QUIZ_LIMITS.path : QUIZ_LIMITS.set;
  if (list.length < (isPath ? 2 : 1) || list.length > max) { ctx.drop(`${where} (箱の数が ${isPath ? `2〜${max}` : `1〜${max}`} でない)`); return null; }
  const missing = list.filter((id) => typeof id !== 'string' || !ctx.ids.has(id));
  if (missing.length) { ctx.drop(`${where} (地図に無い箱: ${missing.slice(0, 2).map(String).join(' ・ ')})`); return null; }
  if (new Set(list).size !== list.length) { ctx.drop(`${where} (同じ箱が 2 回)`); return null; }
  // says[k] belongs to the gap after box k: keep the positions, an empty or missing one is just no words.
  const says = Array.isArray(raw.says) ? raw.says : [];
  const lines = isPath ? list.slice(1).map((to, k) => ({ from: list[k], to, say: typeof says[k] === 'string' ? cut(says[k], QUIZ_LIMITS.say) : '', ...lineOnMap(ctx.edges, list[k], to) })) : [];
  const wantSide = [...new Set(strs(raw.side))].filter((id) => !list.includes(id));
  for (const id of wantSide) if (!ctx.ids.has(id)) ctx.drop(`${where} の寄り道 (地図に無い箱: ${id})`);
  const side = wantSide.filter((id) => ctx.ids.has(id)).slice(0, QUIZ_LIMITS.side);
  const files = [];
  for (const f of Array.isArray(raw.files) ? raw.files.slice(0, QUIZ_LIMITS.files) : []) {
    const path = safeRelPath(f);
    if (!path || !ctx.mapFiles.has(path)) { ctx.drop(`${where} のファイル (地図に無い)`); continue; }
    if (files.some((x) => x.path === path)) continue;
    const d = ctx.delta.get(path);
    files.push({ path, added: d ? d.added : 0, deleted: d ? d.deleted : 0, changed: !!d });
  }
  return {
    // Keyed by content, so a rewritten JSON does not hand one question's past answers to another.
    key: `f:${isPath ? 'path' : 'set'}:${list.join('>')}`, kind: isPath ? 'path' : 'set', source: 'file', target: null,
    ask: cut(raw.ask, QUIZ_LIMITS.ask),
    how: cut(typeof raw.how === 'string' && raw.how.trim() ? raw.how : isPath ? '順に押す' : `順番は自由 ・ 答えは ${list.length} 箱`, QUIZ_LIMITS.how),
    boxes: [...list], side, lines,
    answer: strs(raw.answer).slice(0, QUIZ_LIMITS.answerLines).map((a) => cut(a, QUIZ_LIMITS.answer)),
    names: strs(raw.names).slice(0, QUIZ_LIMITS.names).map((n) => cut(n, QUIZ_LIMITS.name)),
    files,
    note: typeof raw.note === 'string' && raw.note.trim() ? cut(raw.note, QUIZ_LIMITS.note) : null,
  };
}

/** Changed boxes of one story, biggest change first (outside partners are never "changed"). */
function changedBoxes(story, boxes, changes) {
  const commits = story.pr !== null ? changes.filter((c) => c.pr === story.pr) : story.key === 'nopr' ? changes.filter((c) => c.pr === null) : [];
  const delta = fileDelta(commits);
  return boxes
    .filter((b) => b.column !== 'outside')
    .map((b) => ({ b, lines: b.files.reduce((n, f) => n + (delta.has(f.path) ? delta.get(f.path).added + delta.get(f.path).deleted : 0), 0), hit: b.files.some((f) => delta.has(f.path)) }))
    .filter((x) => x.hit)
    .sort((x, y) => y.lines - x.lines || x.b.label.localeCompare(y.b.label, 'ja'))
    .map((x) => x.b);
}

/**
 * Give every story its questions: those written in the --story JSON first, then the ones made from the map.
 * Questions that name a box the map does not have are dropped whole (their answer would be wrong) and named.
 * @returns {{ stories: object[], notices: string[] }} stories without the raw questions
 */
export function attachQuestions(stories, { boxes, edges, changes }) {
  const ids = new Set(boxes.map((b) => b.id));
  const mapFiles = new Set(boxes.flatMap((b) => b.files.map((f) => f.path)));
  const dropped = [], overflow = [];
  const out = stories.map(({ rawQuestions, ...story }) => {
    const ctx = {
      ids, edges, mapFiles, drop: (m) => dropped.push(m),
      where: `--story の ${story.pr !== null ? `#${story.pr}` : story.title}`,
      delta: fileDelta(story.pr !== null ? changes.filter((c) => c.pr === story.pr) : changes),
    };
    const read = (rawQuestions || []).map((q, i) => readQuestion(q, i, ctx)).filter(Boolean);
    // Two questions with the same answer boxes share a key; keep the first.
    const seen = new Set();
    const fromFile = read.filter((q) => (seen.has(q.key) ? (dropped.push(`${ctx.where} の問い「${cut(q.ask, 20)}」(同じ答えの問いが前にある)`), false) : seen.add(q.key)));
    if (fromFile.length > QUIZ_LIMITS.perStory) overflow.push(`${ctx.where} の問いは ${fromFile.length} 個あり、最初の ${QUIZ_LIMITS.perStory} 個だけ使った`);
    const auto = autoQuestions(changedBoxes(story, boxes, changes), story.pr, { edges, boxes });
    return { ...story, questions: [...fromFile, ...auto].slice(0, QUIZ_LIMITS.perStory) };
  });
  const notices = [...overflow, ...(dropped.length ? [`--story の問いの一部を捨てた ${dropped.length} 件: ${dropped.slice(0, 3).join(' ・ ')}${dropped.length > 3 ? ' ほか' : ''}`] : [])];
  return { stories: out, notices };
}
