// arch check: dependency direction (spec/architecture.md §1) and forbidden APIs, checked with grep.
// Every rule also checks "files checked > 0" (no green while checking nothing), and rule 0 checks that
// every path in the role table (spec/architecture.md §1) exists. Rule 7 keeps every screen file under 400 lines (spec/ui.md §1).
// The only suppression is a trailing `// arch-allow: <reason>` on the same line. The count is printed every run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkApproverBuildInputs } from './approver-build-inputs.mjs';

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
    runtime: ['gateway.mjs', 'api.mjs', 'approval-broker.mjs', 'approval-host.mjs', 'audit-journal.mjs', 'journal-backup.mjs', 'entry.mjs', 'host.mjs', 'session-identity.mjs', 'supervisor.mjs', 'guardian.mjs', 'environment-provider.mjs', 'environment-host-broker.mjs', 'environment-control-plane.mjs', 'hyperv-environment-provider.mjs', 'environment-operations.mjs', 'computer-scheduler.mjs', 'mock-environment-provider.mjs', 'agent-harness-adapter.mjs', 'sqlite-operation-store.mjs', 'boundary-protocols.mjs', 'guest-event-intake.mjs', 'errors.mjs', 'desktop-control.mjs', 'hyperv-desktop-driver.mjs', 'mock-desktop-broker.mjs', 'hyperv-desktop-broker-prototype.mjs', 'hyperv-desktop/desktop-io.ps1', 'desktop-wall-host.mjs', 'computer-use-mapping.mjs', 'anthropic-computer-use-client.mjs', 'fake-computer-use-client.mjs', 'desktop-agent-loop.mjs', 'agent-status-board.mjs', 'agent-fleet.mjs', 'desktop-planner.mjs', 'anthropic-planner-client.mjs', 'fake-planner-client.mjs', 'planned-agent-loop.mjs', 'wall-ui/index.html', 'wall-ui/wall.mjs', 'wall-ui/wall.css', 'hyperv-environment-broker-prototype.mjs', 'hyperv-env/env-io.ps1', 'environment-retirement-journal.mjs',
    // Broker network attestation (#115 step 2): the contract lives in broker-contract/, the Fake signer is test-only
    'fake-attestation-signer.mjs',
    // the production signature scheme of that attestation (ECDSA P-256; the key object comes from host configuration, step 3b)
    'ecdsa-attestation-signer.mjs',
    // control room (spec/room.md §3)
    'room-contract.mjs', 'room-host.mjs', 'room-demo.mjs', 'room-journal.mjs', 'room-figures.mjs', 'bero-director.mjs', 'room-starts.mjs', 'task-start-gate.mjs', 'room-approval-wiring.mjs',
    'fake-guest-checker.mjs', 'hyperv-guest-check-prototype.mjs', 'hyperv-guest/check-io.ps1', 'workspace.mjs',
    // opt-in in-guest screen capture (spec/architecture.md decision log 2026-10-30+guest-capture)
    'hyperv-guest-capture-prototype.mjs', 'hyperv-guest/capture-io.ps1', 'hyperv-guest/screen-helper.ps1',
    // thin Node client for the Host Broker pipe: the only runtime file allowed to name the Broker (rule 8a arch-allow)
    'windows-broker-client.mjs',
    // thin Node client for the Approval Authority submit pipe: it reuses the Broker client's pipe client helper (one arch-allow line for the helper path; arch 8a / 10a keep everything else away)
    'approval-authority-client.mjs',
    // fence -> submit -> approve -> claim flow and its journal port (rule 5e; decision log 2026-10-30+approved-operation-flow)
    'approved-operation-flow.mjs', 'approved-operation-journal.mjs',
    // shared receipt v2 / action digest contract for the future Broker and Approval Authority (rule 9; spec/architecture.md decision log 2026-10-30+receipt-v2-contract)
    ...['action-digest.mjs', 'receipt-v2.mjs', 'strict-json.mjs', 'network-attestation.mjs', 'network-attestation-vectors.json', 'receipt-v2.schema.json', 'test-vectors.json', 'ActionDigest.cs', 'ReceiptV2.cs', 'StrictJson.cs',
      // receipt v3 (basis + policy hash) and the tier policy, issue #115 step 3
      'receipt-v3.mjs', 'receipt-v3.schema.json', 'test-vectors-v3.json', 'ReceiptV3.cs', 'TierPolicy.cs',
      // the C# twin of the network attestation (step 3b)
      'NetworkAttestation.cs',
      // the task-start attestation (network none + a Production checkpoint, step 4) and its C# twin
      'task-start-attestation.mjs', 'task-start-attestation-vectors.json', 'TaskStartAttestation.cs'].map((f) => `broker-contract/${f}`),
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
  'src/runtime/room-starts.mjs',
  'src/runtime/task-start-gate.mjs',
  'src/runtime/room-figures.mjs',
  'src/runtime/bero-director.mjs',
  'src/runtime/fake-guest-checker.mjs',
  'src/runtime/workspace.mjs',
  ...['action-digest', 'receipt-v2', 'receipt-v3', 'strict-json', 'network-attestation', 'task-start-attestation'].map((f) => `src/runtime/broker-contract/${f}.mjs`),
  'src/runtime/fake-attestation-signer.mjs',
];
// The room's pure parts (contract, journal, figures, director) also stay free of node: imports, clock and fetch. So does the approved-operation flow and its journal port:
// the clients, the clock, the sleep and the storage are injected (and the flow must not name the Broker or the Authority: rules 8a / 10a).
check('5e pure runtime modules', ['src/runtime/room-contract.mjs', 'src/runtime/workspace.mjs', 'src/runtime/room-figures.mjs', 'src/runtime/bero-director.mjs', 'src/runtime/approved-operation-flow.mjs', 'src/runtime/approved-operation-journal.mjs', 'src/runtime/room-starts.mjs', 'src/runtime/task-start-gate.mjs'], (line) => {
  if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) return null;
  for (const [re, label] of FORBIDDEN_PURE) if (/** @type {RegExp} */ (re).test(line)) return `${label} is not allowed in a pure runtime module`;
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
//    npm lifecycle or `start`/`demo`. The only runtime files that name them are windows-broker-client.mjs, with two explicit
//    `// arch-allow: <reason>` lines (the Broker wire reference, the pipe client helper path), and approval-authority-client.mjs, with one
//    (the same helper path); any future launcher needs its own (counted above).
const BROKER_REF = /windows-broker|albera-windows-broker|WindowsBroker|windows-service-lab|lab-service-shim/i;
check('8a Windows Broker is not referenced by Observer layers or runtime modules', [...entry, ...adapters, ...core, ...shared, ...pub, ...runtime], (line) =>
  BROKER_REF.test(line) ? 'the Windows Broker prototype must not be imported, spawned or named here (build-on-demand only)' : null,
);
const brokerRoot = 'src/runtime/windows-broker';
const brokerFiles = ['Albera.WindowsBroker.csproj', 'Program.cs', 'BrokerRequests.cs', 'Journal.cs', 'ServiceConfig.cs', 'ServiceHost.cs', 'ServiceLoop.cs', 'packages.lock.json'];
for (const f of brokerFiles) if (!fs.existsSync(path.join(ROOT, brokerRoot, f))) violations.push(`[8b Windows Broker source] ${brokerRoot}/${f} does not exist (false-safe)`);
// The trusted pipe client helper (verifies the pipe server before it writes) is part of the same on-demand set: its 3 files must exist, its
// Program.cs stays small enough to review (<= 250 lines), and `build:windows-broker` must build it. Its name also matches BROKER_REF, so 8a and 8c cover it.
const pipeClientRoot = 'src/runtime/windows-broker-pipe-client';
const pipeClientFiles = ['Albera.WindowsBrokerPipeClient.csproj', 'Program.cs', 'packages.lock.json'];
const PIPE_CLIENT_MAX_LINES = 250; // 200 until the fence and inspect request kinds (receipt v2) were added; 220 until the Approval Authority submit request kind (`authority`) was added
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

// 9. The receipt v2 / action digest contract (src/runtime/broker-contract) is the single source for the Node Control Plane / Approval Authority client and the
//    .NET Broker / Authority. It stays pure: no clock, env, network or file access (node:crypto for hashing is the only node: import), the .NET sources use
//    the BCL only and name no other project, and the shared vectors cover enough ground. Pure-by-construction is what lets both languages run the same vectors.
const contractRoot = 'src/runtime/broker-contract';
const contractMjs = listFiles(contractRoot, ['.mjs']);
const contractCs = listFiles(contractRoot, ['.cs']);
check('9a broker-contract is pure', contractMjs, (line) => {
  if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) return null;
  if (/from\s+['"]node:(?!crypto['"])|import\(\s*['"]node:|\brequire\(|\bprocess\.|\bDate\b|\bperformance\.|\bfetch\(|\bsetTimeout\b|\bMath\.random\b/.test(line)) return 'the contract is pure (clock and I/O are injected, only node:crypto may be imported)';
  return null;
});
check('9b broker-contract C# uses the BCL only', contractCs, (line) => {
  const m = line.match(/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/);
  if (m && !m[1].startsWith('System') && m[1] !== 'Albera.BrokerContract') return `using ${m[1]}: the shared sources may use only System.* (BCL)`;
  return /namespace\s+(?!Albera\.BrokerContract\s*;)/.test(line) ? 'the shared sources live in namespace Albera.BrokerContract' : null;
});
const vectorsFile = path.join(ROOT, contractRoot, 'test-vectors.json');
let vectorCounts = 'missing';
if (!fs.existsSync(vectorsFile)) violations.push(`[9c vectors] ${contractRoot}/test-vectors.json does not exist (false-safe)`);
else {
  const vec = JSON.parse(fs.readFileSync(vectorsFile, 'utf8'));
  vectorCounts = `${vec.digestVectors?.length ?? 0} digest, ${vec.receiptVectors?.length ?? 0} receipt`;
  if (!(vec.digestVectors?.length >= 12 && vec.receiptVectors?.length >= 12)) violations.push('[9c vectors] test-vectors.json needs at least 12 digest and 12 receipt vectors');
}
const schemaFile = path.join(ROOT, contractRoot, 'receipt-v2.schema.json');
if (fs.existsSync(schemaFile)) {
  const sch = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
  if (sch.additionalProperties !== false || sch.required?.length !== Object.keys(sch.properties ?? {}).length) violations.push('[9d schema] receipt-v2.schema.json must forbid extra keys and require every property');
}
// 9c / 9d for receipt v3 (issue #115 step 3): its own vectors (receipts, tier policies, loosening cases) and a schema that forbids extra keys and requires every property.
const vectorsV3File = path.join(ROOT, contractRoot, 'test-vectors-v3.json');
const schemaV3File = path.join(ROOT, contractRoot, 'receipt-v3.schema.json');
if (!fs.existsSync(vectorsV3File) || !fs.existsSync(schemaV3File)) violations.push(`[9c vectors] ${contractRoot}/test-vectors-v3.json or receipt-v3.schema.json does not exist (false-safe)`);
else {
  const vec3 = JSON.parse(fs.readFileSync(vectorsV3File, 'utf8'));
  vectorCounts += `; v3: ${vec3.receiptVectors?.length ?? 0} receipt, ${vec3.policyVectors?.length ?? 0} policy, ${vec3.loosenVectors?.length ?? 0} loosen`;
  if (!(vec3.receiptVectors?.length >= 12 && vec3.policyVectors?.length >= 12 && vec3.loosenVectors?.length >= 4)) violations.push('[9c vectors] test-vectors-v3.json needs at least 12 receipt, 12 policy and 4 loosen vectors');
  const sch3 = JSON.parse(fs.readFileSync(schemaV3File, 'utf8'));
  // Every property is required except the one optional field of step 3b (the attestation digest a no-person start / create receipt carries).
  const optionalV3 = Object.keys(sch3.properties ?? {}).filter((name) => !(sch3.required ?? []).includes(name));
  if (sch3.additionalProperties !== false || (sch3.required ?? []).some((name) => !(name in (sch3.properties ?? {}))) || JSON.stringify(optionalV3) !== JSON.stringify(['attestationDigest'])) {
    violations.push('[9d schema] receipt-v3.schema.json must forbid extra keys and require every property except the optional attestationDigest');
  }
}
results.push(`9 broker-contract: ${contractMjs.length} .mjs, ${contractCs.length} .cs, vectors ${vectorCounts}`);

// 9e. The Broker enforces receipt v2 with the shared C# sources, included by link and never copied (a copy could drift from the vectors both languages run).
const brokerProject = fs.readFileSync(path.join(ROOT, brokerRoot, 'Albera.WindowsBroker.csproj'), 'utf8');
if (!/<Compile Include="\.\.\/broker-contract\/\*\.cs"/.test(brokerProject)) violations.push('[9e Broker uses the contract] Albera.WindowsBroker.csproj must include ../broker-contract/*.cs');
const copies = listFiles(brokerRoot, ['.cs']).filter((file) => /namespace\s+Albera\.BrokerContract|class\s+(?:ReceiptV2|ReceiptV3|Receipts|TierPolicy|PolicyChange|ActionDigest|StrictJson)\b/.test(fs.readFileSync(file, 'utf8')));
for (const file of copies) violations.push(`[9e Broker uses the contract] ${posix(file)} declares contract types: the Broker must include src/runtime/broker-contract, not copy it`);
results.push(`9e Broker includes the contract sources by link: ${copies.length} copies`);
// 10. The Approval Authority (src/runtime/windows-approval-authority, ADR-002 "Receipt v2", Proposed) is a separate Windows service that is built on demand
//     only, like the Broker (rule 8). The Observer layers and every runtime .mjs file may not import, spawn or name it, package.json may not wire it into
//     `bin`, `files` or the npm lifecycle, its sources may not name the Broker project (the two stay separately deployable), and its source set, lock file
//     and publish script must exist (false-safe). The receipt v2 contract is the only thing the two share (rule 9), by source include.
const AUTHORITY_REF = /windows-approval-authority|Albera\.ApprovalAuthority|AlberaApprovalAuthority|approval-authority\.exe|ALBERA\\{1,2}ApprovalAuthority|build:approval-authority/i;
check('10a Approval Authority is not referenced by Observer layers or runtime modules', [...entry, ...adapters, ...core, ...shared, ...pub, ...runtime], (line) =>
  AUTHORITY_REF.test(line) ? 'the Approval Authority must not be imported, spawned or named here (build-on-demand only)' : null,
);
const authorityRoot = 'src/runtime/windows-approval-authority';
const authoritySources = ['Program.cs', 'TestSeam.cs', 'AuthorityCore.cs', 'AuthorityConfig.cs', 'AuthorityRuntime.cs', 'ExitCodes.cs', 'PendingStore.cs', 'PipeHost.cs', 'Presence.cs',
  'Protocol.cs', 'ReceiptBuilder.cs', 'ServiceHost.cs', 'ServicePathGuard.cs', 'SidRules.cs', 'Signers.cs', 'PolicyStore.cs'];
for (const f of [...authoritySources, 'Albera.ApprovalAuthority.csproj', 'packages.lock.json']) {
  if (!fs.existsSync(path.join(ROOT, authorityRoot, f))) violations.push(`[10b Approval Authority source] ${authorityRoot}/${f} does not exist (false-safe)`);
}
check('10c Approval Authority sources do not name the Broker project', authoritySources.map((f) => `${authorityRoot}/${f}`).filter((f) => fs.existsSync(path.join(ROOT, f))), (line) =>
  /windows-broker|WindowsBroker/i.test(line) ? 'the Authority and the Broker are separately deployable: no reference to the Broker project' : null,
);
const authorityPublish = fs.existsSync(path.join(ROOT, 'scripts/publish-windows-approval-authority.mjs')) ? fs.readFileSync(path.join(ROOT, 'scripts/publish-windows-approval-authority.mjs'), 'utf8') : '';
if (!authorityPublish.includes('-p:AlberaAuthorityTestFaults=false')) violations.push('[10b Approval Authority source] scripts/publish-windows-approval-authority.mjs does not pin the test fakes off (false-safe)');
const authorityWired = [
  ...Object.entries(pkg.bin ?? {}).filter(([, v]) => AUTHORITY_REF.test(String(v))).map(([k]) => `bin.${k}`),
  ...LIFECYCLE.filter((k) => AUTHORITY_REF.test(String(pkg.scripts?.[k] ?? ''))).map((k) => `scripts.${k}`),
  ...(pkg.files ?? []).filter((v) => AUTHORITY_REF.test(String(v))).map((v) => `files[${v}]`),
];
for (const w of authorityWired) violations.push(`[10d package.json] ${w} wires the Approval Authority into the package or an automatic step`);
if (typeof pkg.scripts?.['build:approval-authority'] !== 'string') violations.push('[10d package.json] build:approval-authority script is missing (false-safe)');
results.push(`10 Approval Authority is build-on-demand: ${authoritySources.length + 2} source files, ${authorityWired.length} wiring violations`);

// 11. The approver app (src/runtime/windows-approver, AlberaApprover.exe, ADR-002 "Receipt v2" / Approval Authority, Proposed) is a console program a human runs; it is built on demand
//     only, like the Broker (rule 8) and the Authority (rule 10). The Observer layers and every runtime .mjs file may not import, spawn or name it, package.json may not wire it into
//     `bin`, `files` or the npm lifecycle, its sources may not name the Broker or Authority projects (it talks to the Authority only over the approver pipe, and shares only the
//     receipt v2 contract by source include, rule 9), and its source set, lock file and publish script must exist (false-safe). The publish script must pin the test fakes (the
//     in-memory "Hello" signer and the test options) off.
const APPROVER_REF = /windows-approver|Albera\.Approver|AlberaApprover|build:approver/i;
check('11a Approver app is not referenced by Observer layers or runtime modules', [...entry, ...adapters, ...core, ...shared, ...pub, ...runtime], (line) =>
  APPROVER_REF.test(line) ? 'the approver app must not be imported, spawned or named here (build-on-demand only)' : null,
);
const approverRoot = 'src/runtime/windows-approver';
const approverSources = ['Program.cs', 'TestSeam.cs', 'CommandLine.cs', 'ApproverCommands.cs', 'PendingView.cs', 'Renderer.cs', 'SafeText.cs', 'Presence.cs', 'Channel.cs', 'PipeChannel.cs',
  'ServerExpectation.cs', 'ExitCodes.cs', 'EnrollCommand.cs', 'SelfCheckCommand.cs', 'HelloKeyStore.cs', 'Wiring.cs', 'WindowsHello.cs', 'PolicyCommand.cs'];
for (const f of [...approverSources, 'Albera.Approver.csproj', 'packages.lock.json']) {
  if (!fs.existsSync(path.join(ROOT, approverRoot, f))) violations.push(`[11b Approver source] ${approverRoot}/${f} does not exist (false-safe)`);
}
check('11c Approver sources do not name the Broker or Authority projects', approverSources.map((f) => `${approverRoot}/${f}`).filter((f) => fs.existsSync(path.join(ROOT, f))), (line) =>
  /windows-broker|WindowsBroker|windows-approval-authority|Albera\.ApprovalAuthority|approval-authority\.exe/i.test(line) ? 'the approver is separately deployable: no reference to the Broker or Authority project' : null,
);
const approverPublish = fs.existsSync(path.join(ROOT, 'scripts/publish-windows-approver.mjs')) ? fs.readFileSync(path.join(ROOT, 'scripts/publish-windows-approver.mjs'), 'utf8') : '';
if (!approverPublish.includes('-p:AlberaApproverTestFaults=false')) violations.push('[11b Approver source] scripts/publish-windows-approver.mjs does not pin the test fakes off (false-safe)');
// 11e. Allowlist of every input of the approver build (scripts/approver-build-inputs.mjs): exactly Sdk Microsoft.NET.Sdk, the allowed elements and values, the pinned Windows SDK projection
// (the only external dependency), and no ambient Directory.Build.* / Directory.Packages.props / global.json / nuget.config from the project directory up to the repository root.
for (const v of checkApproverBuildInputs(ROOT)) violations.push(v);
const approverWired = [
  ...Object.entries(pkg.bin ?? {}).filter(([, v]) => APPROVER_REF.test(String(v))).map(([k]) => `bin.${k}`),
  ...LIFECYCLE.filter((k) => APPROVER_REF.test(String(pkg.scripts?.[k] ?? ''))).map((k) => `scripts.${k}`),
  ...(pkg.files ?? []).filter((v) => APPROVER_REF.test(String(v))).map((v) => `files[${v}]`),
];
for (const w of approverWired) violations.push(`[11d package.json] ${w} wires the approver app into the package or an automatic step`);
if (typeof pkg.scripts?.['build:approver'] !== 'string') violations.push('[11d package.json] build:approver script is missing (false-safe)');
results.push(`11 Approver app is build-on-demand: ${approverSources.length + 2} source files, ${approverWired.length} wiring violations`);

for (const r of results) console.log(r);
console.log(`suppressed (arch-allow): ${suppressed}`);
if (violations.length) {
  console.error(`\narch: ${violations.length} violations:`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('arch: OK');
