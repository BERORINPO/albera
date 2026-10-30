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
    env: {
      ...process.env,
      npm_config_cache: path.join(temporaryRoot, 'npm-cache'),
      npm_config_update_notifier: 'false',
    },
  });
  if (result.error || result.status !== 0) throw new Error('package_smoke_command_failed');
  return result.stdout;
}

try {
  const dryRun = JSON.parse(runNode(['pack', '--dry-run', '--json', '--ignore-scripts']));
  assert.equal(dryRun.length, 1);
  assert.equal(dryRun[0].name, 'albera');
  const packedFiles = dryRun[0].files;
  assert.ok(Array.isArray(packedFiles) && packedFiles.length > 0, 'npm pack dry-run must report packed files');
  assert.ok(packedFiles.some(({ path: filePath }) => filePath === 'src/entry/server.mjs'), 'packed files must include the Observer entry');
  assert.ok(
    packedFiles.every(({ path: filePath }) => filePath !== 'src/runtime' && !filePath.startsWith('src/runtime/')),
    'packed files must exclude src/runtime',
  );
  assert.ok(
    packedFiles.every(({ path: filePath }) => !/windows-broker/iu.test(filePath)),
    'packed files must exclude the Windows Broker source and build output',
  );
  const sourceManifest =JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(sourceManifest.bin?.albera, 'src/entry/server.mjs');
  assert.equal(Object.hasOwn(sourceManifest.bin ?? {}, 'albera-runtime'), false, 'published manifest must not define albera-runtime');

  const packed = JSON.parse(runNode(['pack', '--json', '--ignore-scripts', '--pack-destination', temporaryRoot]));
  assert.equal(packed.length, 1);
  assert.equal(packed[0].name, 'albera');
  const tarball = path.join(temporaryRoot, packed[0].filename);
  const installRoot = path.join(temporaryRoot, 'installed');
  runNode(['install', '--prefix', installRoot, '--ignore-scripts', '--no-audit', '--no-fund', '--offline', '--no-save', tarball]);

  const installedRoot = path.join(installRoot, 'node_modules', 'albera');
  const manifest = JSON.parse(await readFile(path.join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.bin?.albera, 'src/entry/server.mjs');
  assert.equal(Object.hasOwn(manifest.bin ?? {}, 'albera-runtime'), false, 'installed manifest must not define albera-runtime');
  await access(path.join(installedRoot, manifest.bin.albera));
  await assert.rejects(access(path.join(installedRoot, 'src', 'runtime', 'windows-broker')), 'installed package must not contain the Windows Broker');
  const child = spawnSync(process.execPath, [path.join(installedRoot, manifest.bin.albera), '--help'], {
    cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, shell: false, windowsHide: true,
  });
  if (child.error || child.status !== 0) throw new Error('package_smoke_observer_help_failed');
  const help = child.stdout;
  assert.match(help, /ALBERA/);
  assert.match(help, /読み取り専用|read-only/i);
  console.log('package smoke: dry-run excludes Runtime and retains Observer; local package install and Observer CLI help verified (no publish, no provider launch)');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
