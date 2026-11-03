// The app tree of the Control Plane service (docs/architecture/control-plane-service.md section 2): the node side of ALBERA that the service host starts
// as `node <appPath>\src\runtime\entry.mjs room-service`, copied into `bin\control-plane\app` of the installed layout. This module is the ONE definition of
// which files that is and of the per-file hash list that goes into the `control-plane` component of the tree hash (scripts/host Get-CanonicalTreeHash).
// Pure node: no dotnet, no Windows API, so it runs (and is tested) on every OS. Nothing here installs or starts anything.
//
// Rule: every file under src/runtime whose extension is in APP_TREE_EXTENSIONS, except build output, package lock files and test vectors, at the same
// relative path, plus a generated package.json that only says `"type": "module"` (the repository's own package.json lists scripts and the package files, which
// have nothing to do with the service). A link anywhere in the source is refused. The files are copied byte for byte, so a hash of the copy is a hash of the
// source. src/runtime has no import that leaves the folder (the self-containment test checks that), so no other folder is needed.
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const APP_TREE_SOURCE = 'src/runtime';
export const APP_TREE_EXTENSIONS = Object.freeze(['.mjs', '.html', '.css', '.ps1', '.json']);
// Build output is skipped only where a .NET project puts it (src/runtime/windows-*/bin and obj). A folder of that name anywhere else is source and is copied, so it is never dropped silently
// (scripts/arch-check.mjs rule 12e fails when a tracked file sits in a bin/ or obj/ folder). node_modules is skipped anywhere: the tree has no packages.
const BUILD_OUTPUT = /^src\/runtime\/windows-[^/]+\/(?:bin|obj)$/u;
const EXCLUDED_DIRECTORIES = Object.freeze(['node_modules']);
const EXCLUDED_FILE = /^packages\.lock\.json$|vectors[^/]*\.json$/u;
/** The component folder the app tree sits in (`bin\control-plane\app`): the relative paths in the hash list start with it. */
export const APP_TREE_PREFIX = 'app/';
/** The one file that is generated, not copied. Fixed text, so its hash never changes by accident. */
export const APP_TREE_PACKAGE_JSON = `${JSON.stringify({ name: 'albera-control-plane-app', private: true, type: 'module' }, null, 2)}\n`;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** @returns {{ rel: string, source: string }[]} the files to copy, `rel` relative to the app tree ('src/runtime/entry.mjs'), sorted by ordinal comparison. Throws on a link. */
export function listAppTreeFiles(root) {
  const base = path.join(root, ...APP_TREE_SOURCE.split('/'));
  const found = [];
  const walk = (directory, rel) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      const entryRel = `${rel}/${entry.name}`;
      if (lstatSync(source).isSymbolicLink()) throw new Error(`app_tree_link: ${entryRel} is a link`);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.includes(entry.name) && !BUILD_OUTPUT.test(entryRel)) walk(source, entryRel);
      } else if (entry.isFile() && APP_TREE_EXTENSIONS.includes(path.extname(entry.name)) && !EXCLUDED_FILE.test(entry.name)) {
        found.push({ rel: entryRel, source });
      }
    }
  };
  walk(base, APP_TREE_SOURCE);
  return found.sort((a, b) => ordinal(a.rel, b.rel));
}

/** Copies the app tree into `output` (which is emptied first) and returns the hash of every file in it. @returns {Map<string, string>} relative path -> SHA-256 (lowercase hex), package.json included. */
export function buildAppTree({ root, output }) {
  const files = listAppTreeFiles(root);
  if (files.length === 0) throw new Error('app_tree_empty');
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const hashes = new Map();
  for (const { rel, source } of files) {
    const target = path.join(output, ...rel.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
    hashes.set(rel, sha256(readFileSync(target)));
  }
  writeFileSync(path.join(output, 'package.json'), APP_TREE_PACKAGE_JSON, 'utf8');
  hashes.set('package.json', sha256(Buffer.from(APP_TREE_PACKAGE_JSON, 'utf8')));
  return hashes;
}

/** The entries this tree contributes to the `control-plane` component: 'app/<relative path>' -> SHA-256. The host's own files (publish folder root) are listed by the installer beside them. */
export function appTreeHashList(hashes) {
  return Object.fromEntries([...hashes.entries()].sort(([a], [b]) => ordinal(a, b)).map(([rel, hash]) => [`${APP_TREE_PREFIX}${rel}`, hash]));
}

/** One SHA-256 over the sorted 'app/<rel>\t<hash>\n' lines, for comparing two builds at a glance. Not the installer's tree hash (that one also covers the other components). */
export function appTreeFingerprint(hashes) {
  const lines = Object.entries(appTreeHashList(hashes)).map(([rel, hash]) => `${rel}\t${hash}\n`);
  return sha256(Buffer.from(lines.join(''), 'utf8'));
}
