// Read the two tables of spec/architecture.md: the role table and the outside boundary table.
import { InputError, ROLES } from '../shared/map-shape.mjs';

const ROLE_TABLE_TITLE = '役割対応表';
const BOUNDARY_TABLE_TITLE = '外部境界表';
const FILE_IN_CELL = /[A-Za-z0-9_.\-/]+\.(?:mjs|js|html)(?![A-Za-z0-9])/;

/** Split one markdown table row into trimmed cells. */
export function splitRow(line) {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  const inner = t.endsWith('|') ? t.slice(1, -1) : t.slice(1);
  return inner.split('|').map((c) => c.trim());
}

const isSeparator = (cells) => cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '');

/** Rows of the table right after line `at`, or null when a new section starts first. */
function tableFrom(lines, at) {
  let i = at + 1;
  while (i < lines.length && !lines[i].trim().startsWith('|')) {
    if (/^#{1,6}\s/.test(lines[i])) return null; // next section started, no table
    i++;
  }
  const rows = [];
  for (; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(splitRow(lines[i]));
  if (rows.length < 2) return null;
  return rows.slice(1).filter((cells) => !isSeparator(cells)); // drop header and separator
}

/**
 * Rows (cells) of the first table that follows a line containing `title`. Null when not found.
 * Every such line is tried, so a lead-in sentence that names the table (common in an AI reply) does not hide it.
 */
export function tableAfter(md, title) {
  const lines = md.split(/\r?\n/);
  for (let at = 0; at < lines.length; at++) {
    if (!lines[at].includes(title)) continue;
    const rows = tableFrom(lines, at);
    if (rows) return rows;
  }
  return null;
}

const stripTicks = (s) => s.replace(/`/g, '');
/** Table cells are read with "/" separators: git and imports use "/", an AI on Windows may write "\". */
const slashes = (s) => s.replace(/\\/g, '/');

/** A table path that could leave the folder: a ".." segment, a leading "/" or "\", or a drive letter. */
export function isUnsafePath(p) {
  return /^[\\/]/.test(p) || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes('..');
}

/** The first source file path (.mjs / .js / .html) that appears in a cell, or null. */
export function firstFileIn(cell) {
  const m = stripTicks(cell).match(FILE_IN_CELL);
  return m ? m[0].replace(/^\.\//, '') : null;
}

/**
 * Parse architecture.md.
 * Paths that could leave the folder are dropped and reported in `notices`.
 * @returns {{ roles: Record<string, string[]>, boundaries: {file: string, partnerCell: string, adapterCell: string}[], notices: string[] }}
 * @param {string} md
 * @param {string} [name] how the file is named in error messages (the --arch path when one was given)
 * @throws InputError when the role table is missing or has no usable row.
 */
export function parseArchitecture(md, name = 'spec/architecture.md') {
  const roleRows = tableAfter(md, ROLE_TABLE_TITLE);
  if (!roleRows) throw new InputError(`${name} に ${ROLE_TABLE_TITLE} が無い (「| 役割 | パス |」の表を足す)`);
  const roles = Object.fromEntries(ROLES.map((r) => [r, []]));
  const unsafe = [];
  for (const cells of roleRows) {
    const role = (cells[0] || '').toLowerCase();
    if (!ROLES.includes(role)) continue;
    const paths = slashes(stripTicks(cells[1] || '')).split(/[\s,、]+/).filter(Boolean).map((p) => p.replace(/^\.\//, ''));
    unsafe.push(...paths.filter(isUnsafePath));
    const safe = paths.filter((p) => !isUnsafePath(p));
    roles[role] = [...roles[role], ...safe.filter((p) => !roles[role].includes(p))];
  }
  if (ROLES.every((r) => roles[r].length === 0)) {
    throw new InputError(`${name} の ${ROLE_TABLE_TITLE} に shared / core / adapter / entry の行が無い`);
  }
  const boundaryRows = tableAfter(md, BOUNDARY_TABLE_TITLE) || [];
  const boundaries = [];
  for (const cells of boundaryRows) {
    const file = firstFileIn(slashes(cells[0] || ''));
    if (!file || !cells[1]) continue;
    if (isUnsafePath(file)) { unsafe.push(file); continue; }
    boundaries.push({ file, adapterCell: cells[0], partnerCell: cells[1] });
  }
  const notices = unsafe.length
    ? [`フォルダの外を指すパスは読まなかった (${unsafe.length} 件): ${unsafe.slice(0, 5).join(' ')}${unsafe.length > 5 ? ' ほか' : ''}`]
    : [];
  return { roles, boundaries, notices };
}
