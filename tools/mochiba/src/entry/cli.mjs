#!/usr/bin/env node
// mochiba CLI: `map <folder>` writes one HTML map. Arguments, exit codes and the single wiring point live here.
// exit 0 = written / 1 = input problem (one line on how to fix it) / 2 = unexpected failure
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { InputError } from '../shared/map-shape.mjs';
import { parseArchitecture } from '../core/arch-tables.mjs';
import { resolveSince } from '../core/git-log.mjs';
import { buildMap, collectChanges, mappedFiles } from '../core/build-map.mjs';
import { GitUnavailable } from '../adapter/git.mjs';
import { assemblePage, PAGE_SCRIPTS, renderHtml, TEMPLATE_PATH } from './render.mjs';

export const USAGE = '使い方: node src/entry/cli.mjs map <repoの中の対象フォルダ> [--since <日数 or YYYY-MM-DD>] [--arch <md>] [--labels <json>] [--story <json>] [--out <file.html>]';
const PR_MAX = 60;
const SOURCE_EXTS = ['.mjs', '.js', '.html'];
const GH_PARALLEL = 4;

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: { since: { type: 'string' }, arch: { type: 'string' }, labels: { type: 'string' }, story: { type: 'string' }, out: { type: 'string' } },
    });
  } catch (err) {
    throw new InputError(`${err.message.split('\n')[0]} / ${USAGE}`);
  }
  const [command, target, ...extra] = parsed.positionals;
  if (command !== 'map' || !target || extra.length) throw new InputError(USAGE);
  return { target, ...parsed.values };
}

/** Local time as ISO 8601 with the UTC offset, e.g. 2026-11-24T01:38:00+09:00. */
export function localIso(now) {
  const p = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${localDate(now)}T${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}${sign}${p(off / 60)}:${p(off % 60)}`;
}

/** Today's local date as YYYY-MM-DD (the clock stays in the entry). */
export function localDate(now) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export const isInside = (parent, child) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Read a JSON file named by an option (--labels / --story). A BOM (Notepad, PowerShell 5) is allowed. */
function readJsonOption(fs, cwd, file, option) {
  if (!file) return null;
  const abs = resolve(cwd, file);
  const text = fs.readText(abs);
  if (text === null) throw new InputError(`${option} のファイルが無い: ${abs}`);
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch (err) {
    throw new InputError(`${option} の JSON が読めない: ${abs} (${err.message.split('\n')[0]})`);
  }
}

async function fetchPrs(gh, dir, numbers) {
  const results = new Map();
  let next = 0;
  const worker = async () => {
    while (next < numbers.length) {
      const n = numbers[next++];
      results.set(n, await gh.prView(dir, n));
    }
  };
  await Promise.all(Array.from({ length: Math.min(GH_PARALLEL, numbers.length) }, worker));
  return results;
}

/** Run a git adapter call; git problems become input errors. */
function withGit(fn) {
  try { return fn(); } catch (err) {
    if (err instanceof GitUnavailable) throw new InputError(err.message);
    throw err;
  }
}

function readGit(git, targetAbs, sinceArg, now) {
  return withGit(() => {
    const lastCommit = git.lastCommit(targetAbs);
    const since = resolveSince(sinceArg, localDate(now), lastCommit ? lastCommit.date : null);
    const logText = git.log(targetAbs, `${since}T00:00:00`);
    return { lastCommit, since, logText };
  });
}

/**
 * The output must stay outside the whole target repo (spec: nothing is written to the target repo).
 * Both sides go through realpath so a junction or symlink cannot lead back into the repo.
 */
function checkOut(fs, git, targetAbs, outAbs) {
  const top = withGit(() => git.topLevel(targetAbs));
  const repoReal = fs.realPath(resolve(top || targetAbs));
  const outReal = fs.realPath(outAbs);
  for (const inside of [resolve(targetAbs), repoReal, fs.realPath(targetAbs)]) {
    if (isInside(inside, outAbs) || isInside(inside, outReal)) {
      throw new InputError(`--out が対象の repo の中を指している。対象の repo には何も書かないので、外を指す: ${outAbs}`);
    }
  }
}

/**
 * Turn folder entries of table 1 into the source files under them, and drop entries that leave the folder.
 * @returns {{ arch: object, notices: string[] }} a new arch; the input is not changed
 */
function expandRoles(fs, targetAbs, arch) {
  const notices = [];
  const expand = (p) => {
    const abs = join(targetAbs, p);
    if (!isInside(targetAbs, abs)) { notices.push(`表 1 の ${p} はフォルダの外なので読まなかった`); return []; }
    if (!p.endsWith('/') && !fs.isDir(abs)) return [p];
    const dir = p.replace(/\/+$/, '');
    const found = fs.listFiles(abs, SOURCE_EXTS).map((f) => `${dir}/${f}`);
    if (!found.length) notices.push(`表 1 の ${dir}/ に .mjs / .js / .html が無い`);
    return found;
  };
  const roles = Object.fromEntries(Object.entries(arch.roles).map(([role, paths]) => [role, [...new Set(paths.flatMap(expand))]]));
  return { arch: { ...arch, roles }, notices };
}

function readSources(fs, targetAbs, files) {
  const sources = new Map();
  const missing = [];
  for (const p of files) {
    const text = fs.readText(join(targetAbs, p));
    if (text === null) missing.push(p); else sources.set(p, text);
  }
  return { sources, missing };
}

/** template.html with the page scripts put in (the HTML is one file with nothing loaded from outside). */
function readPage(fs) {
  const read = (path) => {
    const text = fs.readText(path);
    if (text === null) throw new Error(`page file not found: ${path}`);
    return text;
  };
  return assemblePage(read(TEMPLATE_PATH), PAGE_SCRIPTS.map(read));
}

/**
 * Run the CLI with injected adapters.
 * @param {string[]} argv arguments after the script name
 * @param {{fs, git, gh, cwd: string, now: Date, log: Function, error: Function, template?: string}} deps
 * @returns {Promise<number>} exit code
 */
export async function run(argv, deps) {
  try {
    const args = parseCli(argv);
    const { fs, git, gh, cwd, now } = deps;
    const targetAbs = resolve(cwd, args.target);
    if (!fs.isDir(targetAbs)) throw new InputError(`対象フォルダが無い: ${targetAbs}`);
    // The tables may live outside the target (--arch), so a repo that is not ours needs no new file.
    const archPath = args.arch ? resolve(cwd, args.arch) : join(targetAbs, 'spec', 'architecture.md');
    const archMd = fs.readText(archPath);
    if (archMd === null) {
      throw new InputError(args.arch
        ? `--arch のファイルが無い: ${archPath}`
        : `spec/architecture.md が無い: ${archPath} (spec/ を持つフォルダを指すか、対象の外に置いた表を --arch で渡す)`);
    }
    const archName = args.arch ? archPath : 'spec/architecture.md';
    // A file saved as UTF-16 (PowerShell 5.1 "> file") reads as text full of NUL characters.
    if (archMd.includes('\u0000') || archMd.startsWith('\uFFFD\uFFFD')) throw new InputError(`${archName} が UTF-8 でない (UTF-16 など)。VS Code かメモ帳で UTF-8 として保存し直す`);
    const parsed = parseArchitecture(archMd, args.arch ? archPath : undefined);
    const labels = readJsonOption(fs, cwd, args.labels, '--labels');
    const story = readJsonOption(fs, cwd, args.story, '--story');
    const outAbs = resolve(cwd, args.out || join('out', `${basename(targetAbs)}-map.html`));
    checkOut(fs, git, targetAbs, outAbs);

    const { arch, notices: pathNotices } = expandRoles(fs, targetAbs, parsed);
    const files = mappedFiles(arch);
    const { sources, missing } = readSources(fs, targetAbs, files);
    if (sources.size === 0) throw new InputError(`${archName} の役割対応表のパスにファイルが 1 つも無い (対象フォルダからの相対パスで書く): ${targetAbs}`);
    const { lastCommit, since, logText } = readGit(git, targetAbs, args.since, now);
    const changeSet = collectChanges(logText, new Set(files));
    const asked = changeSet.prNumbers.slice(0, PR_MAX);
    const prNotice = changeSet.prNumbers.length > PR_MAX ? [`PR が ${changeSet.prNumbers.length} 件あり、新しい ${PR_MAX} 件だけ説明を取った`] : [];
    const notices = [...parsed.notices, ...pathNotices, ...prNotice];
    const prResults = await fetchPrs(gh, targetAbs, asked);

    const map = buildMap({
      title: basename(targetAbs),
      root: targetAbs.replace(/\\/g, '/'),
      since,
      generatedAt: localIso(now),
      arch, sources, missing, changeSet, prResults, labels, story,
      lastCommit: lastCommit || null,
      notices,
    });
    const template = deps.template ?? readPage(fs);
    fs.writeText(outAbs, renderHtml(template, map));
    const lit = map.boxes.filter((b) => b.status).length;
    deps.log(`書いた: ${outAbs}`);
    deps.log(`箱 ${map.boxes.length} ・ 線 ${map.edges.length} ・ 光る箱 ${lit} ・ commit ${map.changes.length} ・ PR ${changeSet.prNumbers.length} ・ 紙芝居 ${map.stories.length} (${since} から)`);
    for (const n of map.notices) deps.log(`注意: ${n}`);
    return 0;
  } catch (err) {
    if (err instanceof InputError) { deps.error(err.message); return 1; }
    deps.error(`予期しない失敗: ${err && err.stack ? err.stack : err}`);
    return 2;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const { createFsRepo } = await import('../adapter/fs-repo.mjs');
  const { createGit } = await import('../adapter/git.mjs');
  const { createGh } = await import('../adapter/gh.mjs');
  process.exitCode = await run(process.argv.slice(2), {
    fs: createFsRepo(), git: createGit(), gh: createGh(),
    cwd: process.cwd(), now: new Date(), log: (m) => console.log(m), error: (m) => console.error(m),
  });
}
