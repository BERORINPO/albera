#!/usr/bin/env node
// Builds the app tree of the Control Plane service (docs/architecture/control-plane-service.md section 2, Proposed / NOT VERIFIED): the node side of ALBERA that
// the service host runs as `node <app>\src\runtime\entry.mjs room-service`. It copies the files listed by scripts/control-plane-app-tree.mjs into the `app` folder of
// the host's publish folder (the future `bin\control-plane`), so the installed component is the host build plus `app\`. It only copies: nothing here installs,
// registers, elevates or starts anything, and it needs no dotnet, so it runs on any OS. Output is git-ignored.
// It also writes the per-file hash list of the tree (the `app/...` entries of the `control-plane` component) beside the publish folder, NOT inside it, so the list
// is not part of what it describes.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appTreeFingerprint, appTreeHashList, buildAppTree } from './control-plane-app-tree.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostFolder = path.join(root, 'src', 'runtime', 'windows-control-plane-host');
const framework = path.join(hostFolder, 'bin', 'Release', 'net10.0-windows', 'win-x64');
const output = path.join(framework, 'publish', 'app');

const hashes = buildAppTree({ root, output });
mkdirSync(framework, { recursive: true });
const list = path.join(framework, 'control-plane-app-hashes.json');
writeFileSync(list, `${JSON.stringify({ component: 'control-plane', files: appTreeHashList(hashes) }, null, 2)}\n`, 'utf8');
console.log(`app tree: ${hashes.size} files`);
console.log(`sha256 ${appTreeFingerprint(hashes)} app-tree`);
console.log(`Control Plane app tree built: ${path.relative(root, output)} (build output is ignored by Git; not installed, not started)`);
