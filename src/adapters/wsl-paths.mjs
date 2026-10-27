// Pure path helpers for an explicitly configured Windows WSL filesystem share.
import path from 'node:path';

const SHARE = /^(\\\\wsl(?:\.localhost|\$)\\([^\\]+))(?:\\.*)?$/i;

/** Return only the local WSL distro share root; arbitrary network shares fail closed. @param {unknown} value */
export function wslShareRoot(value) {
  if (typeof value !== 'string' || value.length > 1024) return '';
  const normalized = value.replaceAll('/', '\\').trim();
  const match = SHARE.exec(normalized);
  const distro = match?.[2];
  if (!match?.[1] || !distro || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/u.test(distro) || /[. ]$/u.test(distro)) return '';
  return match[1];
}

/** True only for a path below the exact configured distro share. @param {unknown} value @param {unknown} shareRoot */
export function isWslPathInShare(value, shareRoot) {
  const root = wslShareRoot(shareRoot).replace(/\\+$/, '').toLowerCase();
  if (!root || typeof value !== 'string' || value.length > 2048) return false;
  const candidate = value.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
  return candidate.startsWith(`${root}\\`);
}

/** Map a POSIX cwd from a WSL rollout into its configured local WSL share without accepting traversal. @param {unknown} cwd @param {unknown} shareRoot */
export function wslCwdToUnc(cwd, shareRoot) {
  const root = wslShareRoot(shareRoot);
  if (!root || typeof cwd !== 'string' || cwd.length > 2048 || !cwd.startsWith('/') || cwd.startsWith('//') || cwd.includes('\\') || /[\u0000-\u001f\u007f]/u.test(cwd)) return null;
  const segments = cwd.slice(1).split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.length > 255 || /[<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment))) return null;
  const mapped = path.win32.join(root, ...segments.filter(Boolean));
  const prefix = `${root}\\`.toLowerCase();
  return mapped.toLowerCase() === root.toLowerCase() || mapped.toLowerCase().startsWith(prefix) ? mapped : null;
}

/** Map a path inside the one explicitly configured WSL share back to a distro and POSIX path. */
export function wslUncToCwd(value, shareRoot) {
  const root = wslShareRoot(shareRoot).replaceAll('/', '\\').replace(/\\+$/, '');
  if (!root || typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const normalized = value.replaceAll('/', '\\');
  if (normalized.toLowerCase() !== root.toLowerCase() && !normalized.toLowerCase().startsWith(`${root.toLowerCase()}\\`)) return null;
  const suffix = normalized.slice(root.length).replace(/^\\+/, '');
  const parts = suffix ? suffix.split('\\') : [];
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) return null;
  const distro = root.split('\\').at(-1);
  if (!distro) return null;
  return { distro, cwd: `/${parts.join('/')}` };
}
