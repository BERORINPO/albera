// Real file system access. Reads anywhere; writes only where the entry tells it to.
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git']);

/** Files under absDir whose extension is in exts, as sorted forward-slash paths relative to absDir. */
function listFiles(absDir, exts) {
  const found = [];
  const walk = (dir, prefix) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return;
      throw err;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), rel); }
      else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) found.push(rel);
    }
  };
  walk(absDir, '');
  return found.sort();
}

/** realpath that also works for a path that does not exist yet (resolves the nearest existing parent). */
function realPath(abs) {
  try { return realpathSync.native(abs); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const parent = dirname(abs);
    return parent === abs ? abs : join(realPath(parent), basename(abs));
  }
}

/** @returns {{readText(abs):string|null, isDir(abs):boolean, listFiles(absDir, exts):string[], realPath(abs):string, writeText(abs,text):void}} */
export function createFsRepo() {
  return {
    readText(abs) {
      try { return readFileSync(abs, 'utf8'); } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR') return null;
        throw err;
      }
    },
    isDir(abs) {
      try { return statSync(abs).isDirectory(); } catch { return false; }
    },
    listFiles,
    realPath,
    writeText(abs, text) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text, 'utf8');
    },
  };
}
