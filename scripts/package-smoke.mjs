#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli || !path.isAbsolute(npmCli)) throw new Error('package_smoke_requires_npm_script');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'albera-package-smoke-'));

function runNode(args) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
    windowsHide: true,
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  if (result.error || result.status !== 0) throw new Error('package_smoke_command_failed');
  return result.stdout;
}

try {
  const packed = JSON.parse(runNode(['pack', '--json', '--ignore-scripts', '--pack-destination', temporaryRoot]));
  assert.equal(packed.length, 1);
  assert.equal(packed[0].name, 'albera');
  const tarball = path.join(temporaryRoot, packed[0].filename);
  const installRoot = path.join(temporaryRoot, 'installed');
  runNode(['install', '--prefix', installRoot, '--ignore-scripts', '--no-audit', '--no-fund', '--offline', '--no-save', tarball]);

  const installedRoot = path.join(installRoot, 'node_modules', 'albera');
  for (const asset of ['index.html', 'approval.mjs', 'approval.css']) {
    await access(path.join(installedRoot, 'src', 'runtime', 'approval-ui', asset));
  }
  const manifest = JSON.parse(await readFile(path.join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.bin?.albera, 'src/entry/server.mjs');
  assert.equal(manifest.bin?.['albera-runtime'], 'src/runtime/entry.mjs');
  const help = runNode(['exec', '--prefix', installRoot, '--offline', '--', 'albera-runtime', '--help']);
  assert.match(help, /ALBERA Runtime/);
  assert.match(help, /read-only session dashboard/);
  console.log('package smoke: packed and installed ALBERA locally; Runtime CLI help and approval UI assets verified (no publish, no provider launch)');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
