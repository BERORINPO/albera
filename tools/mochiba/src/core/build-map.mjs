// Put the pieces together: tables + imports + git changes + PR notes -> one map.
import { MAP_VERSION, ROLES, STATUS } from '../shared/map-shape.mjs';
import { buildBoxes, normaliseLabels } from './grouping.mjs';
import { countImportEdges } from './imports.mjs';
import { assignPrs, parseGitLog } from './git-log.mjs';
import { summarisePr } from './pr-info.mjs';
import { layout, layoutByFeature } from './layout.mjs';
import { autoStories, mergeStoryFile } from './story.mjs';
import { attachQuestions } from './quiz.mjs';

const TODAY_MAX = 3;

/** All files listed in the role table, in table order. */
export const mappedFiles = (arch) => ROLES.flatMap((r) => arch.roles[r]);

/**
 * Commits in the period that touch a mapped file, with their PR numbers.
 * @returns {{ changes: object[], prNumbers: number[] }} changes newest first
 */
export function collectChanges(logText, mapped) {
  const all = parseGitLog(logText);
  const prOf = assignPrs(all);
  const changes = [];
  for (const c of all) {
    const files = c.files.filter((f) => mapped.has(f.path));
    if (!files.length) continue;
    changes.push({
      hash: c.hash,
      short: c.hash.slice(0, 7),
      date: c.date,
      subject: c.subject,
      pr: prOf.get(c.hash) ?? null,
      files: files.map((f) => ({ path: f.path, lines: f.added + f.deleted, added: f.added, deleted: f.deleted })),
      created: c.created.filter((p) => mapped.has(p)),
    });
  }
  const prNumbers = [...new Set(changes.map((c) => c.pr).filter((n) => n !== null))].sort((a, b) => b - a);
  return { changes, prNumbers };
}

/** Notices and PR entries from the gh results. results: Map number -> {ok:true,data} | {ok:false,reason} */
export function collectPrs(prNumbers, results) {
  const prs = {};
  const failed = [];
  for (const n of prNumbers) {
    const r = results.get(n);
    if (r && r.ok) prs[n] = summarisePr(n, r.data);
    else {
      const reason = (r && r.reason) || 'gh 失敗';
      prs[n] = { number: n, missing: true, reason };
      failed.push({ n, reason });
    }
  }
  const notices = [];
  if (failed.length && failed.every((f) => f.reason === 'gh 無し')) notices.push('PR の説明は取れなかった (gh 無し)');
  else if (failed.length) {
    const list = failed.slice(0, 6).map((f) => `#${f.n}`).join('・') + (failed.length > 6 ? ` ほか ${failed.length - 6} 件` : '');
    notices.push(`PR の説明は取れなかった (${failed[0].reason}): ${list}`);
  }
  return { prs, notices };
}

/** Per-file status and lines over the period. */
function fileStats(changes) {
  const stats = new Map();
  for (const c of changes) {
    for (const f of c.files) {
      const s = stats.get(f.path) || { lines: 0, status: STATUS.CHANGED };
      stats.set(f.path, { ...s, lines: s.lines + f.lines });
    }
    for (const p of c.created) stats.set(p, { ...(stats.get(p) || { lines: 0 }), status: STATUS.NEW });
  }
  return stats;
}

function decorateBox(box, stats) {
  const files = box.files.map((path) => {
    const s = stats.get(path);
    return { path, status: s ? s.status : null, lines: s ? s.lines : 0 };
  });
  const touched = files.filter((f) => f.status);
  const status = touched.some((f) => f.status === STATUS.NEW) ? STATUS.NEW : touched.length ? STATUS.CHANGED : null;
  return { ...box, files, status, lines: touched.reduce((n, f) => n + f.lines, 0) };
}

/**
 * Build the whole map.
 * @param {object} input
 * @param {string} input.title folder name
 * @param {string} input.root absolute folder path (forward slashes)
 * @param {string} input.since first day of the period
 * @param {string} input.generatedAt ISO time given by the entry
 * @param {{roles, boundaries}} input.arch parsed tables
 * @param {Map<string,string>} input.sources path -> text of files that exist
 * @param {string[]} input.missing table-1 files that do not exist
 * @param {{changes, prNumbers}} input.changeSet from collectChanges
 * @param {Map<number,object>} input.prResults from the gh adapter
 * @param {object|null} input.labels raw --labels JSON
 * @param {{hash,date,subject}|null} input.lastCommit
 * @param {string[]} [input.notices] extra notices from the entry
 * @param {object|null} [input.story] raw --story JSON (null = only the automatic stories)
 */
export function buildMap(input) {
  const labels = normaliseLabels(input.labels);
  const grouped = buildBoxes(input.arch.roles, input.arch.boundaries, labels);
  const importEdges = countImportEdges(input.sources, grouped.fileToBox);
  const edges = [...importEdges, ...grouped.outsideEdges]
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .map((e, i) => ({ ...e, id: `e${i}` }));
  const stats = fileStats(input.changeSet.changes);
  const decorated = grouped.boxes.map((b) => decorateBox(b, stats));
  const placed = layout(decorated, edges);
  const feature = layoutByFeature(placed.boxes, edges);
  const rolePos = Object.fromEntries(placed.boxes.map((b) => [b.id, { x: b.x, y: b.y }]));
  const { prs, notices: prNotices } = collectPrs(input.changeSet.prNumbers, input.prResults);
  const today = placed.boxes
    .filter((b) => b.status)
    .sort((a, b) => b.lines - a.lines || a.label.localeCompare(b.label, 'ja'))
    .slice(0, TODAY_MAX)
    .map((b) => b.id);
  const auto = autoStories({ boxes: placed.boxes, edges, changes: input.changeSet.changes, prs });
  const merged = mergeStoryFile(input.story ?? null, { boxes: placed.boxes, edges, changes: input.changeSet.changes }, auto);
  const { stories, notices: quizNotices } = attachQuestions(merged.stories, { boxes: placed.boxes, edges, changes: input.changeSet.changes });
  const storyNotices = [...merged.notices, ...quizNotices];
  const missingNotice = input.missing.length
    ? [`表 1 にあるが見つからないファイル ${input.missing.length} 件: ${input.missing.slice(0, 5).join(' ')}${input.missing.length > 5 ? ' ほか' : ''}`]
    : [];
  return {
    version: MAP_VERSION,
    title: input.title,
    root: input.root,
    since: input.since,
    generatedAt: input.generatedAt,
    lastCommit: input.lastCommit || null,
    world: placed.world,
    columns: placed.columns,
    boxes: placed.boxes,
    // Two ways to arrange the same boxes; the page starts with feature rows and can switch.
    layouts: {
      feature: feature,
      role: { pos: rolePos, columns: placed.columns, rows: [], world: placed.world },
    },
    edges,
    changes: input.changeSet.changes.map(({ created, ...c }) => c),
    prs,
    stories,
    today,
    notices: [...(input.notices || []), ...prNotices, ...storyNotices, ...grouped.notices, ...missingNotice],
  };
}
