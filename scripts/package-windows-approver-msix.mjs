#!/usr/bin/env node
// Packs the published approver (npm run build:approver) into an MSIX so its Windows Hello key is scoped to the package family name (issue #101).
//   node scripts/package-windows-approver-msix.mjs [--sign-thumbprint <40 hex SHA-1 of a code-signing certificate in CurrentUser\My>]
// Without --sign-thumbprint it only PACKS: build tools (pinned, hash-checked, Authenticode-checked; scripts/windows-sdk-buildtools.mjs) go into a temp folder of ours, the publish
// folder is copied into a layout there, and makeappx writes `AlberaApprover.unsigned.msix` next to the build output. No certificate store is read or written, nothing is installed.
// With --sign-thumbprint it also runs `signtool sign /sha1 <thumbprint> /s My /fd SHA256` on the package (named `AlberaApprover.msix`). The certificate and its store are made and removed by
// scripts/approver-msix-install.ps1, which calls this script; this script never creates one. A package signed with a self-signed certificate installs only on a PC that trusts that certificate.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { LOGOS, belongsInPackage, buildManifest, loadIdentity, packageFamilyName, solidPng } from './approver-msix.mjs';
import { ownedTempFolder, prepareBuildTools } from './windows-sdk-buildtools.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLISH_FOLDER = path.join(root, 'src', 'runtime', 'windows-approver', 'bin', 'Release', 'net10.0-windows10.0.19041.0', 'win-x64', 'publish');
export const OUTPUT_FOLDER = path.join(root, 'src', 'runtime', 'windows-approver', 'bin', 'msix');
const THUMBPRINT = /^[0-9A-Fa-f]{40}$/u;

/** @returns {{ signThumbprint: string|null }} the parsed command line; throws `usage: ...` for anything else. */
export function parseArguments(args) {
  if (args.length === 0) return { signThumbprint: null };
  if (args.length === 2 && args[0] === '--sign-thumbprint' && THUMBPRINT.test(args[1])) return { signThumbprint: args[1].toUpperCase() };
  throw new Error('usage: node scripts/package-windows-approver-msix.mjs [--sign-thumbprint <40 hex characters>]');
}

/** Copies the publish folder into `layout`, skipping what does not belong in the package; refuses any link (the layout must be exactly the files that were published). */
export function copyLayout(from, layout) {
  const walk = (relative) => {
    const source = path.join(from, relative);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error(`layout_link: ${relative} is a link; refusing to package it`);
    if (stat.isDirectory()) {
      fs.mkdirSync(path.join(layout, relative), { recursive: true });
      for (const entry of fs.readdirSync(source)) walk(path.join(relative, entry));
    } else if (stat.isFile() && belongsInPackage(relative)) {
      fs.copyFileSync(source, path.join(layout, relative));
    }
  };
  fs.mkdirSync(layout, { recursive: true });
  for (const entry of fs.readdirSync(from)) walk(entry);
}

function runTool(tools, label, executable, args) {
  const result = spawnSync(executable, args, { env: tools.env, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    process.stderr.write(`${label} failed\n${result.error?.message ?? ''}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    process.exit(result.status || 1);
  }
}

async function main() {
  if (process.platform !== 'win32') { console.log('Windows approver MSIX packaging skipped on non-Windows host'); return; }
  const { signThumbprint } = parseArguments(process.argv.slice(2));
  const identity = loadIdentity();
  if (!fs.existsSync(path.join(PUBLISH_FOLDER, identity.executable))) {
    console.error(`missing_build: ${path.join(PUBLISH_FOLDER, identity.executable)} does not exist; run npm run build:approver first`);
    process.exit(1);
  }
  const tools = await prepareBuildTools();
  const work = ownedTempFolder('albera-msix-layout-');
  const layout = path.join(work, 'layout');
  copyLayout(PUBLISH_FOLDER, layout);
  fs.mkdirSync(path.join(layout, 'Assets'), { recursive: true });
  for (const logo of LOGOS) fs.writeFileSync(path.join(layout, 'Assets', logo.file), solidPng(logo.size));
  fs.writeFileSync(path.join(layout, 'AppxManifest.xml'), buildManifest(identity), 'utf8');

  fs.mkdirSync(OUTPUT_FOLDER, { recursive: true });
  const output = path.join(OUTPUT_FOLDER, signThumbprint ? 'AlberaApprover.msix' : 'AlberaApprover.unsigned.msix');
  runTool(tools, 'makeappx pack', tools.makeappx, ['pack', '/d', layout, '/p', output, '/o']);
  if (signThumbprint) runTool(tools, 'signtool sign', tools.signtool, ['sign', '/fd', 'SHA256', '/sha1', signThumbprint, '/s', 'My', output]);
  const sha256 = createHash('sha256').update(fs.readFileSync(output)).digest('hex');
  console.log(`package ${path.relative(root, output).replaceAll('\\', '/')} ${fs.statSync(output).size} bytes ${signThumbprint ? `signed with certificate ${signThumbprint}` : 'UNSIGNED (not installable)'}`);
  console.log(`sha256 ${sha256}`);
  console.log(`package family name ${packageFamilyName(identity)}`);
  console.log('packed only: no certificate store touched by this script, nothing installed, no key created, no Windows Hello touched');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
