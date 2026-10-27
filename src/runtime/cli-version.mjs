// Bounded version-only probe used after the host has approved a Runtime start.
import { spawn } from 'node:child_process';
import os from 'node:os';
import process from 'node:process';

const PROBE_TIMEOUT_MS = 3000;
const MAX_OUTPUT_BYTES = 4096;

/** Probe a CLI's reported version without passing Runtime credentials or project configuration. */
export function probeCliVersion(executable, { platform = process.platform, spawnImpl = spawn, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (typeof executable !== 'string' || executable.length === 0 || typeof spawnImpl !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    return Promise.reject(new TypeError('invalid_version_probe_options'));
  }
  const env = minimalProbeEnvironment(process.env, platform);
  return new Promise((resolve, reject) => {
    let child;
    let output = '';
    let settled = false;
    const finish = (error, version) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(version);
    };
    const stop = () => {
      if (Number.isInteger(child?.pid) && child.pid > 0 && platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* fall through to child.kill */ }
      }
      try { child?.kill('SIGKILL'); } catch { /* child may already have exited */ }
    };
    const timer = setTimeout(() => { stop(); finish(new Error('cli_version_probe_timeout')); }, timeoutMs);
    timer.unref?.();
    try {
      child = spawnImpl(executable, ['--version'], {
        cwd: os.tmpdir(), env, shell: false, detached: platform !== 'win32', windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      finish(new Error('cli_version_probe_failed'));
      return;
    }
    child.stdout?.on('data', (chunk) => {
      if (settled) return;
      output += String(chunk);
      if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
        stop(); finish(new Error('cli_version_probe_output_too_large'));
      }
    });
    child.once('error', () => finish(new Error('cli_version_probe_failed')));
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) return finish(new Error('cli_version_probe_failed'));
      const match = output.match(/(?:^|\b)v?(\d+\.\d+\.\d+)(?:\b|$)/m);
      if (!match) return finish(new Error('cli_version_unrecognized'));
      finish(null, match[1]);
    });
  });
}

function minimalProbeEnvironment(source, platform) {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']);
  const env = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (allowed.has(key.toUpperCase()) && typeof value === 'string') env[key] = value;
  }
  if (platform === 'win32' && !Object.keys(env).some((key) => key.toUpperCase() === 'SYSTEMROOT')) {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (systemRoot) env.SystemRoot = systemRoot;
  }
  return env;
}
