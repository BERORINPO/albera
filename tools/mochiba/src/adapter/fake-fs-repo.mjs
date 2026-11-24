// In-memory stand-in for fs-repo.mjs. Paths are compared after turning "\" into "/".
const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * @param {Record<string,string>} files absolute path -> text
 * @param {{links?: Record<string,string>}} [opts] links: absolute path prefix -> where it really points (like a junction)
 * @returns fs-repo interface plus `writes` (Map of what was written)
 */
export function createFakeFsRepo(files = {}, { links = {} } = {}) {
  const store = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  const linkList = Object.entries(links).map(([from, to]) => [norm(from), norm(to)]);
  const writes = new Map();
  return {
    writes,
    readText(abs) { return store.has(norm(abs)) ? store.get(norm(abs)) : null; },
    isDir(abs) {
      const prefix = `${norm(abs)}/`;
      return [...store.keys()].some((k) => k.startsWith(prefix));
    },
    listFiles(absDir, exts) {
      const prefix = `${norm(absDir)}/`;
      return [...store.keys()]
        .filter((k) => k.startsWith(prefix) && exts.some((x) => k.endsWith(x)))
        .map((k) => k.slice(prefix.length))
        .filter((rel) => !rel.split('/').some((part) => part === 'node_modules' || part === '.git'))
        .sort();
    },
    realPath(abs) {
      const p = norm(abs);
      for (const [from, to] of linkList) {
        if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length);
      }
      return p;
    },
    writeText(abs, text) { writes.set(norm(abs), text); },
  };
}
