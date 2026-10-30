// arch check: dependency direction (spec/architecture.md §1) and forbidden APIs, checked with grep.
// Every rule also checks "files checked > 0" (no green while checking nothing), and rule 0 checks that
// every path in the role table (spec/architecture.md §1) exists. Rule 7 keeps every screen file under 400 lines (spec/ui.md §1).
// The only suppression is a trailing `// arch-allow: <reason>` on the same line. The count is printed every run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOW_RE = /\/\/\s*arch-allow:\s*\S+/;

/** @param {string} dir @returns {string[]} */
function listFiles(dir, exts = ['.mjs', '.js', '.html']) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return listFiles(rel, exts);
    return exts.includes(path.extname(e.name)) ? [rel] : [];
  });
}

const violations = [];
let suppressed = 0;
const results = [];
const posix = (/** @type {string} */ f) => f.replace(/\\/g, '/');

/** Apply test to each line of each file. @param {string} rule @param {string[]} files @param {(line: string, file: string) => string|null} test */
function check(rule, files, test) {
  if (files.length === 0) violations.push(`[${rule}] no files to check (false-safe)`);
  let hits = 0;
  for (const file of files) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const msg = test(line, file);
      if (!msg) return;
      if (ALLOW_RE.test(line)) {
        suppressed++;
        return;
      }
      hits++;
      violations.push(`[${rule}] ${posix(file)}:${i + 1} ${msg}`);
    });
  }
  results.push(`${rule}: ${files.length} files, ${hits} violations`);
}

// 0. The role table (spec/architecture.md §1) and the UI file list (spec/ui.md §1) exist as files.
const EXPECTED = {
  shared: ['constants.mjs', 'types.mjs', 'i18n.mjs'],
  core: ['turn.mjs', 'classify.mjs', 'project.mjs', 'board.mjs', 'session.mjs', 'text.mjs', 'activity.mjs', 'context.mjs'],
  adapters: [
    'app-sessions-fs.mjs', 'fake-app-sessions.mjs', 'transcripts-fs.mjs', 'fake-transcripts.mjs', 'folder-hints-fs.mjs', 'fake-folder-hints.mjs',
    'session-record.mjs', 'demo-data.mjs', 'map-limit.mjs',
  ],
  entry: ['server.mjs', 'config.mjs', 'messages.mjs', 'service.mjs', 'http.mjs', 'probe.mjs'],
    runtime: ['gateway.mjs', 'api.mjs', 'approval-broker.mjs', 'approval-host.mjs', 'audit-journal.mjs', 'journal-backup.mjs', 'entry.mjs', 'host.mjs', 'session-identity.mjs', 'supervisor.mjs', 'guardian.mjs', 'environment-provider.mjs', 'environment-host-broker.mjs', 'environment-control-plane.mjs', 'hyperv-environment-provider.mjs', 'environment-operations.mjs', 'computer-scheduler.mjs', 'mock-environment-provider.mjs', 'agent-harness-adapter.mjs', 'sqlite-operation-store.mjs', 'boundary-protocols.mjs', 'guest-event-intake.mjs', 'errors.mjs', 'desktop-control.mjs', 'hyperv-desktop-driver.mjs', 'mock-desktop-broker.mjs', 'hyperv-desktop-broker-prototype.mjs', 'hyperv-desktop/desktop-io.ps1', 'desktop-wall-host.mjs', 'computer-use-mapping.mjs', 'anthropic-computer-use-client.mjs', 'fake-computer-use-client.mjs', 'desktop-agent-loop.mjs', 'agent-status-board.mjs', 'agent-fleet.mjs', 'desktop-planner.mjs', 'anthropic-planner-client.mjs', 'fake-planner-client.mjs', 'planned-agent-loop.mjs', 'wall-ui/index.html', 'wall-ui/wall.mjs', 'wall-ui/wall.css', 'hyperv-environment-broker-prototype.mjs', 'hyperv-env/env-io.ps1',
    // control room (spec/room.md §3)
    'room-contract.mjs', 'room-host.mjs', 'room-demo.mjs', 'room-journal.mjs', 'room-figures.mjs', 'bero-director.mjs',
    'fake-guest-checker.mjs', 'hyperv-guest-check-prototype.mjs', 'hyperv-guest/check-io.ps1', 'workspace.mjs',
    // opt-in in-guest screen capture (spec/architecture.md decision log 2026-10-30+guest-capture)
    'hyperv-guest-capture-prototype.mjs', 'hyperv-guest/capture-io.ps1', 'hyperv-guest/screen-helper.ps1',
    // thin Node client for the Host Broker pipe: the only runtime file allowed to name the Broker (rule 8a arch-allow)
    'windows-broker-client.mjs',
    ...['index.html', 'room.css', 'canvas.mjs', 'app.mjs', 'api.mjs', 'i18n.mjs', 'words-canvas.mjs', 'cam.mjs', 'cam.css', 'words-cam.mjs',
      'figure.mjs', 'figure.css', 'ledger.mjs', 'words-figure.mjs', 'bero.mjs', 'bero.css', 'cards.mjs', 'words-bero.mjs'].map((f) => `room-ui/${f}`)],
  public: [
    'index.html', 'tokens.css', 'style.css', 'rows.css', 'tidy.css', 'canvas.css',
    'app.mjs', 'api.mjs', 'poll.mjs', 'state.mjs', 'ui-state.mjs', 'render.mjs', 'front.mjs', 'rows.mjs', 'labels.mjs', 'cleanup.mjs', 'handoff.mjs',
    'actions.mjs', 'canvas.mjs', 'canvas-slip.mjs', 'canvas-sheet.mjs', 'canvas-fit.mjs', 'canvas-bar.mjs', 'canvas-ctl.mjs', 'canvas-view.mjs', 'canvas-act.mjs',
    'canvas-layout.mjs', 'canvas-desk.mjs', 'canvas-fold.mjs', 'canvas-camera.mjs', 'canvas-input.mjs',
    'keys.mjs', 'notify.mjs', 'favicon.mjs', 'copy.mjs', 'view.mjs', 'format.mjs', 'doing.mjs', 'times.mjs', 'i18n.mjs',
    'dict-en.mjs', 'dict-ja.mjs', 'dict-zh.mjs', 'dict-en-handoff.mjs', 'dict-ja-handoff.mjs', 'dict-zh-handoff.mjs', 'dict-en-canvas.mjs', 'dict-ja-canvas.mjs', 'dict-zh-canvas.mjs',
  ],
};
const DIR_OF = { shared: 'src/shared', core: 'src/core', adapters: 'src/adapters', entry: 'src/entry', runtime: 'src/runtime', public: 'public' };
let expectedCount = 0;
for (const [role, names] of Object.entries(EXPECTED)) {
  for (const n of names) {
    expectedCount++;
    const rel = `${DIR_OF[/** @type {keyof typeof DIR_OF} */ (role)]}/${n}`;
    if (!fs.existsSync(path.join(ROOT, rel))) violations.push(`[0 role table] ${rel} is listed in spec/architecture.md but does not exist`);
  }
}
results.push(`0 role table: ${expectedCount} paths`);

const IMPORT_RE = /^\s*import\b[^'"]*['"]([^'"]+)['"]|^\s*export\b[^'"]*\bfrom\s*['"]([^'"]+)['"]/;
const specOf = (/** @type {string} */ line) => {
  const m = line.match(IMPORT_RE);
  return m ? m[1] ?? m[2] : null;
};

const shared = listFiles('src/shared');
const core = listFiles('src/core');
const adapters = listFiles('src/adapters');
const entry = listFiles('src/entry');
const runtime = listFiles('src/runtime');
const runtimeUi = ['src/runtime/approval-ui', 'src/runtime/wall-ui', 'src/runtime/room-ui'].flatMap((dir) => listFiles(dir, ['.mjs', '.js', '.html', '.css']));
const pub = listFiles('public');

// 1. core and shared know nothing of the outside world
const FORBIDDEN_PURE = [
  [/from\s+['"]node:/, 'import from node:'],
  [/import\(\s*['"]node:/, 'dynamic import of node:'],
  [/\brequire\(/, 'require('],
  [/\bprocess\./, 'process.'],
  [/\bDate\.now\b/, 'Date.now'],
  [/\bnew Date\(/, 'new Date('],
  [/\bfetch\(/, 'fetch('],
];
check('1 core/shared are pure', [...core, ...shared], (line) => {
  for (const [re, label] of FORBIDDEN_PURE) if (/** @type {RegExp} */ (re).test(line)) return `${label} is not allowed`;
  return null;
});

// 2. dependency direction: shared imports nothing / core imports only ../shared/ and ./ / adapters never import entry
check('2a shared imports nothing', shared, (line) => (specOf(line) ? `import ${specOf(line)}` : null));
check('2b core imports', core, (line) => {
  const s = specOf(line);
  if (s == null) return null;
  return s.startsWith('../shared/') || s.startsWith('./') ? null : `core cannot import ${s}`;
});
check('2c adapter imports', adapters, (line) => {
  const s = specOf(line);
  if (s == null) return null;
  return s.startsWith('node:') || s.startsWith('../shared/') || s.startsWith('../core/') || s.startsWith('./') ? null : `an adapter cannot import ${s}`;
});
check('2d runtime imports', runtime, (line, file) => {
  const s = specOf(line);
  if (s == null) return null;
  return s.startsWith('node:') || s.startsWith('./') ? null : `runtime cannot import ${s}`;
});
check('2e runtime isolation', [...entry, ...adapters, ...core, ...shared], (line) => {
  const s = specOf(line);
  if (s?.includes('/runtime/')) return `existing app layers cannot import runtime module ${s}`;
  return /\bimport\s*\(\s*['"][^'"]*\/runtime\//.test(line) ? 'existing app layers cannot dynamically import the runtime module' : null;
});

// 3. every touch point with the outside world (*-fs.mjs) has a Fake
const fsAdapters = adapters.filter((f) => f.endsWith('-fs.mjs'));
if (fsAdapters.length === 0) violations.push('[3 Fake pairs] no *-fs.mjs files (false-safe)');
for (const f of fsAdapters) {
  const name = path.basename(f, '-fs.mjs');
  const fake = path.join(path.dirname(f), `fake-${name}.mjs`);
  if (!fs.existsSync(path.join(ROOT, fake))) violations.push(`[3 Fake pairs] ${posix(f)} has no ${posix(fake)}`);
}
results.push(`3 Fake pairs: ${fsAdapters.length} pairs`);

// 4. UI: fetch only in api.mjs. No HTML strings are injected anywhere
check('4a fetch only in public/api.mjs', pub, (line, file) => (/\bfetch\(/.test(line) && path.basename(file) !== 'api.mjs' ? 'fetch( is allowed only in api.mjs' : null));
check('4b no HTML string injection', [...pub, ...shared, ...core, ...adapters, ...entry], (line) =>
  /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b/.test(line) ? 'innerHTML and friends are not allowed (use textContent / DOM APIs)' : null,
);

// 5. read-only: adapters and entry never use APIs that write to the app's files
check('5 read-only', [...adapters, ...entry], (line) =>
  /\b(writeFile|appendFile|rename|unlink|rmdir|mkdir|copyFile|createWriteStream|truncate|utimes|chmod|watch)\w*\(|\.rm\(|open\([^)]*['"](?:[wax]|r\+)/.test(line)
    ? 'write APIs are not allowed'
    : null,
);
check('5a no process execution in read-only layers', [...adapters, ...entry], (line) =>
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?child_process['"]|\b(?:spawn|exec|execFile)\s*\(/.test(line) ? 'process execution is restricted to src/runtime/' : null,
);
check('5b runtime process boundary', runtime, (line, file) => {
  if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) return null;
  if (/(?:import\s*\(\s*|require\s*\(\s*)['"](?:node:)?child_process['"]/.test(line)) return 'dynamic child_process loading is not allowed';
  if (/from\s+['"](?:node:)?child_process['"]/.test(line) && !/^\s*import\s+\{\s*spawn\s*\}\s+from\s+['"]node:child_process['"]\s*;?/.test(line)) return 'only the named asynchronous spawn API may be imported';
  const sqliteStatement = posix(file) === 'src/runtime/sqlite-operation-store.mjs' && /\bdb\.exec\s*\(/.test(line);
  if (/\b(?:exec|execSync|execFile|execFileSync|spawnSync)\s*\(/.test(line) && !sqliteStatement) return 'only asynchronous spawn is allowed in the runtime boundary';
  if (/\bshell\s*:\s*true\b/.test(line)) return 'shell execution is not allowed';
  return null;
});
check('5c runtime UI (approval, wall, room) uses safe DOM APIs', runtimeUi, (line) =>
  /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b/.test(line)
    ? 'runtime UI (approval, wall) must render untrusted text with textContent / DOM APIs'
    : null,
);

// 5d provider contracts and test doubles describe lifecycle state; they never execute host commands.
const providerContracts = [
  'src/runtime/environment-provider.mjs',
  'src/runtime/hyperv-environment-provider.mjs',
  'src/runtime/environment-operations.mjs',
  'src/runtime/mock-environment-provider.mjs',
  'src/runtime/agent-harness-adapter.mjs',
  'src/runtime/boundary-protocols.mjs',
  'src/runtime/desktop-control.mjs',
  'src/runtime/hyperv-desktop-driver.mjs',
  'src/runtime/mock-desktop-broker.mjs',
  'src/runtime/desktop-wall-host.mjs',
  'src/runtime/computer-use-mapping.mjs',
  'src/runtime/fake-computer-use-client.mjs',
  'src/runtime/desktop-agent-loop.mjs',
  'src/runtime/agent-status-board.mjs',
  'src/runtime/agent-fleet.mjs',
  'src/runtime/desktop-planner.mjs',
  'src/runtime/fake-planner-client.mjs',
  'src/runtime/planned-agent-loop.mjs',
  'src/runtime/room-contract.mjs',
  'src/runtime/room-host.mjs',
  'src/runtime/room-demo.mjs',
  'src/runtime/room-journal.mjs',
  'src/runtime/room-figures.mjs',
  'src/runtime/bero-director.mjs',
  'src/runtime/fake-guest-checker.mjs',
  'src/runtime/workspace.mjs',
];
// The room's pure parts (contract, journal, figures, director) also stay free of node: imports, clock and fetch.
check('5e room pure modules', ['src/runtime/room-contract.mjs', 'src/runtime/workspace.mjs', 'src/runtime/room-figures.mjs', 'src/runtime/bero-director.mjs'], (line) => {
  if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) return null;
  for (const [re, label] of FORBIDDEN_PURE) if (/** @type {RegExp} */ (re).test(line)) return `${label} is not allowed in a pure room module`;
  return null;
});
check('5d provider contracts have no process execution', providerContracts, (line) =>
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?child_process['"]|\b(?:spawn|exec|execFile|execSync|execFileSync|spawnSync)\s*\(/.test(line)
    ? 'provider contracts and MockProvider must not execute host commands'
    : null,
);

// 6. words live only in the dictionaries: no kana or kanji in string literals outside the UI dictionaries
//    (public/i18n.mjs, public/dict-*.mjs), the terminal dictionary (src/entry/messages.mjs) and the demo content
//    (src/adapters/demo-data.mjs). Comments may be Japanese. index.html: no kana or kanji outside data-i18n* attributes.
const CJK = '[\\u3000-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uff01-\\uff60]';
const CJK_RE = new RegExp(CJK);
const CJK_IN_STRING = new RegExp(`(['"\`])(?:(?!\\1).)*${CJK}(?:(?!\\1).)*\\1`);
/** The code part of a line: whole-line comments are dropped, and so is a trailing ` // comment`. @param {string} line */
const codePart = (line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line.replace(/\s\/\/\s.*$/, ''));
const DICT_FILES = new Set(['public/i18n.mjs', 'src/entry/messages.mjs', 'src/adapters/demo-data.mjs']);
// public/dict-<lang>.mjs and its parts public/dict-<lang>-<part>.mjs (a dictionary is split to stay under 400 lines)
const DICT_RE = /^public\/dict-(en|ja|zh)(-[a-z]+)?\.mjs$/;
const isDict = (/** @type {string} */ f) => DICT_FILES.has(posix(f)) || DICT_RE.test(posix(f));
const scripts6 = [...core, ...shared, ...adapters, ...entry, ...pub.filter((f) => f.endsWith('.mjs'))].filter((f) => !isDict(f));
if (!pub.some((f) => DICT_RE.test(posix(f)))) violations.push('[6 words only in dictionaries] no public/dict-*.mjs (false-safe)');
check('6 words only in dictionaries', scripts6, (line) => (CJK_IN_STRING.test(codePart(line)) ? 'put this text in public/dict-*.mjs or src/entry/messages.mjs' : null));
const html6 = pub.filter((f) => f.endsWith('.html'));
check('6b index.html words only in data-i18n', html6, (line) => {
  const outside = line.replace(/<!--.*?-->/g, '').replace(/\sdata-i18n[\w-]*\s*=\s*("[^"]*"|'[^']*')/g, '');
  return CJK_RE.test(outside) ? 'the first paint is English; Japanese comes from the dictionary' : null;
});

// 7. every screen file stays under 400 lines (spec/ui.md §1): split a helper module out rather than grow one past it
const UI_MAX_LINES = 400;
const ui7 = listFiles('public', ['.mjs', '.js', '.html', '.css']);
if (ui7.length === 0) violations.push('[7 UI files under 400 lines] no files to check (false-safe)');
let long7 = 0;
for (const f of ui7) {
  const n = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\n$/, '').split('\n').length;
  if (n > UI_MAX_LINES) {
    long7++;
    violations.push(`[7 UI files under 400 lines] ${posix(f)} has ${n} lines`);
  }
}
results.push(`7 UI files under ${UI_MAX_LINES} lines: ${ui7.length} files, ${long7} violations`);
if (runtimeUi.length === 0) violations.push('[7 runtime UI under 400 lines] no files to check (false-safe)');
for (const f of runtimeUi) {
  const n = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\n$/, '').split('\n').length;
  if (n > UI_MAX_LINES) violations.push(`[7 runtime UI under 400 lines] ${posix(f)} has ${n} lines`);
}
results.push(`7 runtime UI under ${UI_MAX_LINES} lines: ${runtimeUi.length} files`);

// 8. The Windows Host Broker prototype (src/runtime/windows-broker, ADR-002 Proposed) is built on demand only. The Observer
//    layers and every runtime .mjs file may not import, spawn or name it, and package.json may not wire it into `bin`, the
//    npm lifecycle or `start`/`demo`. The only runtime file that names them is windows-broker-client.mjs, with two explicit
//    `// arch-allow: <reason>` lines (the Broker wire reference, the pipe client helper path); any future launcher needs its own (counted above).
const BROKER_REF = /windows-broker|albera-windows-broker|WindowsBroker/i;
check('8a Windows Broker is not referenced by Observer layers or runtime modules', [...entry, ...adapters, ...core, ...shared, ...pub, ...runtime], (line) =>
  BROKER_REF.test(line) ? 'the Windows Broker prototype must not be imported, spawned or named here (build-on-demand only)' : null,
);
const brokerRoot = 'src/runtime/windows-broker';
const brokerFiles = ['Albera.WindowsBroker.csproj', 'Program.cs', 'packages.lock.json'];
for (const f of brokerFiles) if (!fs.existsSync(path.join(ROOT, brokerRoot, f))) violations.push(`[8b Windows Broker source] ${brokerRoot}/${f} does not exist (false-safe)`);
// The trusted pipe client helper (verifies the pipe server before it writes) is part of the same on-demand set: its 3 files must exist, its
// Program.cs stays small enough to review (<= 200 lines), and `build:windows-broker` must build it. Its name also matches BROKER_REF, so 8a and 8c cover it.
const pipeClientRoot = 'src/runtime/windows-broker-pipe-client';
const pipeClientFiles = ['Albera.WindowsBrokerPipeClient.csproj', 'Program.cs', 'packages.lock.json'];
const PIPE_CLIENT_MAX_LINES = 200;
for (const f of pipeClientFiles) if (!fs.existsSync(path.join(ROOT, pipeClientRoot, f))) violations.push(`[8b Windows Broker pipe client source] ${pipeClientRoot}/${f} does not exist (false-safe)`);
const pipeClientProgram = path.join(ROOT, pipeClientRoot, 'Program.cs');
if (fs.existsSync(pipeClientProgram)) {
  const n = fs.readFileSync(pipeClientProgram, 'utf8').replace(/\n$/, '').split('\n').length;
  if (n > PIPE_CLIENT_MAX_LINES) violations.push(`[8b Windows Broker pipe client source] ${pipeClientRoot}/Program.cs has ${n} lines (max ${PIPE_CLIENT_MAX_LINES})`);
}
const publishScript = fs.existsSync(path.join(ROOT, 'scripts/publish-windows-broker.mjs')) ? fs.readFileSync(path.join(ROOT, 'scripts/publish-windows-broker.mjs'), 'utf8') : '';
if (!publishScript.includes('Albera.WindowsBrokerPipeClient.csproj')) violations.push('[8b Windows Broker pipe client source] scripts/publish-windows-broker.mjs does not build the pipe client (false-safe)');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepublish', 'prepublishOnly', 'prepack', 'postpack', 'prepare', 'preversion', 'version', 'postversion', 'start', 'demo', 'prestart', 'poststart'];
const wired = [
  ...Object.entries(pkg.bin ?? {}).filter(([, v]) => BROKER_REF.test(String(v))).map(([k]) => `bin.${k}`),
  ...LIFECYCLE.filter((k) => BROKER_REF.test(String(pkg.scripts?.[k] ?? '')) || /build:windows-broker/.test(String(pkg.scripts?.[k] ?? ''))).map((k) => `scripts.${k}`),
  ...(pkg.files ?? []).filter((v) => BROKER_REF.test(String(v)) || String(v).replace(/\\/g, '/').replace(/\/$/, '') === 'src/runtime').map((v) => `files[${v}]`),
];
for (const w of wired) violations.push(`[8c package.json] ${w} wires the Windows Broker into the package or an automatic step`);
if (typeof pkg.scripts?.['build:windows-broker'] !== 'string') violations.push('[8c package.json] build:windows-broker script is missing (false-safe)');
results.push(`8 Windows Broker and pipe client are build-on-demand: ${brokerFiles.length + pipeClientFiles.length} source files, ${wired.length} wiring violations`);

for (const r of results) console.log(r);
console.log(`suppressed (arch-allow): ${suppressed}`);
if (violations.length) {
  console.error(`\narch: ${violations.length} violations:`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('arch: OK');
