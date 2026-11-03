import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { APP_TREE_PACKAGE_JSON, appTreeFingerprint, appTreeHashList, buildAppTree, listAppTreeFiles } from '../scripts/control-plane-app-tree.mjs';

// The app tree of the Control Plane service (scripts/control-plane-app-tree.mjs): which node files the service host runs, and the hash list of the copy.
// Pure node, every OS: nothing here needs dotnet or a service.
const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

describe('Control Plane app tree', () => {
  const temps = [];
  const temp = (prefix) => { const folder = mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(folder); return folder; };
  after(() => { for (const folder of temps) rmSync(folder, { recursive: true, force: true }); });
  const write = (root, rel, text = rel) => { const file = path.join(root, ...rel.split('/')); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };

  describe('which files', () => {
    it('takes the runtime files by extension, sorted, and leaves out build output, lock files, test vectors and C# sources', () => {
      const root = temp('albera-app-rules-');
      for (const rel of ['entry.mjs', 'z.mjs', 'room-ui/index.html', 'room-ui/room.css', 'hyperv-env/env-io.ps1', 'broker-contract/receipt-v2.schema.json', 'A-upper.mjs', 'room-ui/bin/kept.mjs', 'obj/kept-too.mjs', 'windows-notes/readme-source.mjs']) write(root, `src/runtime/${rel}`);
      for (const rel of ['windows-broker/Program.cs', 'windows-broker/X.csproj', 'windows-broker/packages.lock.json', 'windows-broker/bin/Release/x.mjs', 'windows-approver/obj/y.mjs', 'x/node_modules/z.mjs',
        'broker-contract/test-vectors.json', 'broker-contract/match-code-vectors.json', 'notes.md', 'img.png']) write(root, `src/runtime/${rel}`);
      write(root, 'src/core/other.mjs'); // outside src/runtime
      write(root, 'package.json');
      assert.deepEqual(listAppTreeFiles(root).map((file) => file.rel), [
        'src/runtime/A-upper.mjs', 'src/runtime/broker-contract/receipt-v2.schema.json', 'src/runtime/entry.mjs', 'src/runtime/hyperv-env/env-io.ps1', 'src/runtime/obj/kept-too.mjs', 'src/runtime/room-ui/bin/kept.mjs',
        'src/runtime/room-ui/index.html', 'src/runtime/room-ui/room.css', 'src/runtime/windows-notes/readme-source.mjs', 'src/runtime/z.mjs',
      ]);
    });

    it('refuses a link anywhere in the source', (t) => {
      const root = temp('albera-app-link-');
      write(root, 'src/runtime/entry.mjs');
      write(root, 'elsewhere/secret.mjs');
      try { symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'src', 'runtime', 'linked'), 'junction'); } catch { t.skip('this account cannot create a junction'); return; }
      assert.throws(() => listAppTreeFiles(root), /app_tree_link: src\/runtime\/linked is a link/u);
    });

    it('is self-contained for the real repository: every relative import of every module resolves to a file of the tree, and nothing else is imported but node: built-ins', () => {
      const files = listAppTreeFiles(repository);
      assert.ok(files.length > 50, `the runtime has more than 50 files, found ${files.length}`);
      const inTree = new Set(files.map((file) => file.rel));
      assert.ok(inTree.has('src/runtime/entry.mjs'), 'the entry the host runs is in the tree');
      // Four shapes: `import|export ... from 'x'`, the closing line `} from 'x'` of a multi-line import, `import 'x'`, and `import('x')` (code and JSDoc types).
      const specifiers = [
        /^\s*(?:import|export)\b[^\n]*?\bfrom\s*(['"])([^'"\n]+)\1/gmu, /^\s*\}\s*from\s*(['"])([^'"\n]+)\1/gmu,
        /^\s*import\s*(['"])([^'"\n]+)\1/gmu, /\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/gu,
      ];
      const problems = [];
      let checked = 0;
      for (const { rel, source } of files.filter((file) => file.rel.endsWith('.mjs'))) {
        const text = readFileSync(source, 'utf8');
        for (const match of specifiers.flatMap((pattern) => [...text.matchAll(pattern)])) {
          const spec = match[2];
          checked += 1;
          if (spec.startsWith('node:')) continue;
          if (!spec.startsWith('.')) { problems.push(`${rel}: ${spec} is neither relative nor a node: built-in`); continue; }
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
          if (!inTree.has(target)) problems.push(`${rel}: ${spec} -> ${target} is not in the tree`);
        }
      }
      assert.ok(checked > 200, `checked ${checked} imports`);
      assert.deepEqual(problems, []);
    });
  });

  describe('the copy and its hash list', () => {
    it('copies the bytes unchanged, adds the fixed package.json, and lists one SHA-256 per file under app/', () => {
      const root = temp('albera-app-copy-');
      write(root, 'src/runtime/entry.mjs', 'console.log(1);\r\n'); // CRLF stays CRLF: a copy, not a rewrite
      write(root, 'src/runtime/room-ui/index.html', '<html></html>');
      const output = path.join(temp('albera-app-out-'), 'app');
      const hashes = buildAppTree({ root, output });
      assert.equal(readFileSync(path.join(output, 'src', 'runtime', 'entry.mjs'), 'utf8'), 'console.log(1);\r\n');
      assert.equal(readFileSync(path.join(output, 'package.json'), 'utf8'), APP_TREE_PACKAGE_JSON);
      assert.deepEqual(JSON.parse(APP_TREE_PACKAGE_JSON), { name: 'albera-control-plane-app', private: true, type: 'module' });
      assert.deepEqual(appTreeHashList(hashes), {
        'app/package.json': sha256(APP_TREE_PACKAGE_JSON),
        'app/src/runtime/entry.mjs': sha256('console.log(1);\r\n'),
        'app/src/runtime/room-ui/index.html': sha256('<html></html>'),
      });
    });

    it('rebuilds from scratch: a file that left the source is gone from the copy, and the fingerprint follows the content only', () => {
      const root = temp('albera-app-rebuild-');
      write(root, 'src/runtime/entry.mjs', 'a');
      write(root, 'src/runtime/old.mjs', 'b');
      const output = path.join(temp('albera-app-out2-'), 'app');
      const first = buildAppTree({ root, output });
      assert.ok(first.has('src/runtime/old.mjs'));
      rmSync(path.join(root, 'src', 'runtime', 'old.mjs'));
      const second = buildAppTree({ root, output });
      assert.equal(second.has('src/runtime/old.mjs'), false);
      assert.throws(() => readFileSync(path.join(output, 'src', 'runtime', 'old.mjs')), { code: 'ENOENT' });
      assert.equal(appTreeFingerprint(second), appTreeFingerprint(buildAppTree({ root, output: path.join(temp('albera-app-out3-'), 'app') })), 'same source, another folder, same fingerprint');
      write(root, 'src/runtime/entry.mjs', 'changed');
      assert.notEqual(appTreeFingerprint(buildAppTree({ root, output })), appTreeFingerprint(second));
    });

    it('refuses to build an empty tree (no green while copying nothing)', () => {
      const root = temp('albera-app-empty-');
      mkdirSync(path.join(root, 'src', 'runtime'), { recursive: true });
      assert.throws(() => buildAppTree({ root, output: path.join(temp('albera-app-out4-'), 'app') }), /app_tree_empty/u);
    });
  });
});
