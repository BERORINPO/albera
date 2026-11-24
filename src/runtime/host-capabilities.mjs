// What this PC can use (docs/architecture/no-vm-mode.md): Watch everywhere, Work only with Hyper-V and the installed
// services. The result is for showing to a person and grants nothing: no start path reads it (arch-check rule 5c), and
// the Broker, the Authority and the receipts decide as before. Anything unknown counts as not available.
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const PROBE_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 16384;
const SERVICE_MISSING_EXIT = 1060; // ERROR_SERVICE_DOES_NOT_EXIST, measured on Windows 11 Home
const HYPERV_SERVICE = 'vmms'; // not Win32_ComputerSystem.HypervisorPresent: that is true on Home with WSL2
// The one ALBERA service asked about: it is created last, and a person who is no administrator can query it.
const CONTROL_PLANE_SERVICE = 'AlberaControlPlane';
const EDITION_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';

const unavailable = (reason) => Object.freeze({ level: 'watch', work: Object.freeze({ available: false, reason }) });

/** Pure: the facts of one PC to its level. Only a fact stated as 'present' counts. */
export function classify({ platform, hyperV, edition, services } = {}) {
  if (platform !== 'win32') return unavailable(platform ? 'platform' : 'unknown');
  if (hyperV === 'missing') return unavailable(/^Core/.test(String(edition ?? '')) ? 'home_edition' : 'role_off');
  if (hyperV !== 'present') return unavailable('unknown');
  if (services === 'missing') return unavailable('not_installed');
  if (services !== 'present') return unavailable('unknown');
  return Object.freeze({ level: 'work', work: Object.freeze({ available: true, reason: null }) });
}

/** Runs one fixed program, without a shell, and gives its exit code and output. Rejects on a failed start or a hang. */
export function runFixed(file, args, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('probe_timeout')); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout }); });
  });
}

async function serviceFact(run, scPath, name) {
  try {
    const { code } = await run(scPath, ['query', name]);
    if (code === 0) return 'present';
    return code === SERVICE_MISSING_EXIT ? 'missing' : 'unknown';
  } catch { return 'unknown'; }
}

async function editionFact(run, regPath) {
  try {
    const { code, stdout } = await run(regPath, ['query', EDITION_KEY, '/v', 'EditionID']);
    return code === 0 ? stdout.match(/EditionID\s+REG_SZ\s+(\S+)/)?.[1] ?? null : null;
  } catch { return null; }
}

async function gatherFacts({ platform, systemRoot, run }) {
  if (platform !== 'win32') return { platform };
  if (typeof systemRoot !== 'string' || !path.win32.isAbsolute(systemRoot)) return { platform, hyperV: 'unknown' };
  const scPath = path.win32.join(systemRoot, 'System32', 'sc.exe');
  const regPath = path.win32.join(systemRoot, 'System32', 'reg.exe');
  const [hyperV, services, edition] = await Promise.all([
    serviceFact(run, scPath, HYPERV_SERVICE), serviceFact(run, scPath, CONTROL_PLANE_SERVICE), editionFact(run, regPath),
  ]);
  return { platform, hyperV, services, edition };
}

/** Gathers the facts of this PC. It needs no administrator, and it never throws. */
export async function probeHost({ platform = process.platform, systemRoot = process.env.SystemRoot, run = runFixed } = {}) {
  return classify(await gatherFacts({ platform, systemRoot, run }));
}

// 'ok' says only that a file is there: the installer makes its own checks (owner, rights, links) and may still refuse it.
export async function fileState(file) {
  try {
    return (await stat(file)).isFile() ? 'ok' : 'missing';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'missing' : 'unknown';
  }
}
const FACT_STATE = Object.freeze({ present: 'ok', missing: 'missing' });
const NODE_FOR_INSTALL = 'C:\\Program Files\\nodejs\\node.exe'; // the one path the installer copies from, whatever the environment says

/**
 * The level and what Work still needs on Windows, each item at once, so that a person does not find them one failure at
 * a time. Windows Hello and the list of VMs cannot be read without an administrator: those say 'manual', never 'ok'.
 * Node.js and Claude Code are copied by the install, so they are listed only until the services are there.
 */
export async function probeReport({
  platform = process.platform, systemRoot = process.env.SystemRoot, userProfile = process.env.USERPROFILE,
  run = runFixed, readFile = fileState,
} = {}) {
  const facts = await gatherFacts({ platform, systemRoot, run });
  const result = classify(facts);
  if (platform !== 'win32') return Object.freeze({ result, checklist: Object.freeze([]) });
  const profileKnown = typeof userProfile === 'string' && path.win32.isAbsolute(userProfile);
  const [node, claude] = await Promise.all([
    readFile(NODE_FOR_INSTALL),
    profileKnown ? readFile(path.win32.join(userProfile, '.local', 'bin', 'claude.exe')) : 'unknown',
  ]);
  const checklist = [
    { item: 'hyperV', state: FACT_STATE[facts.hyperV] ?? 'unknown' },
    ...(facts.services === 'present' ? [] : [{ item: 'node', state: node }, { item: 'claude', state: claude }]),
    { item: 'hello', state: 'manual' },
    ...(facts.hyperV === 'missing' ? [] : [{ item: 'vm', state: 'manual' }]),
    { item: 'services', state: FACT_STATE[facts.services] ?? 'unknown' },
  ];
  return Object.freeze({ result, checklist: Object.freeze(checklist.map(Object.freeze)) });
}

const WORDS = Object.freeze({
  en: {
    work: 'Level: Work. Hyper-V and the ALBERA services are on this PC.',
    watch: 'Level: Watch. The session board and the demo can be used on this PC.',
    missing: 'Work (jobs in VMs) cannot be used: {why}',
    fix: 'To change this: {how}',
    demo: 'To try the control room with fake VMs: albera-runtime room --demo',
    home_edition: ['this edition of Windows has no Hyper-V.', 'Windows Pro or above is needed.'],
    role_off: ['Hyper-V is not on, or this edition does not have it.', 'turn on the Hyper-V feature in Windows, if this edition offers it.'],
    not_installed: ['Hyper-V is here, but the ALBERA services are not installed, and jobs with approval need them.', 'install them (docs/architecture/host-install.md).'],
    platform: ['Work needs Hyper-V, which only Windows has.', 'use a Windows PC with Hyper-V.'],
    unknown: ['this PC could not be checked.', 'run albera-runtime doctor again. If it stays like this, please report it.'],
    checklist: 'What Work needs:',
    states: { ok: '[ok]', missing: '[missing]', unknown: '[unknown]', manual: '[check yourself]' },
    items: {
      hyperV: 'Hyper-V',
      node: 'for the install: Node.js in Program Files\\nodejs (from the normal installer)',
      claude: 'for the install: Claude Code as claude.exe in .local\\bin of your profile (the npm version does not count)',
      hello: 'Windows Hello: Settings, Accounts, Sign-in options',
      vm: 'a VM with an operating system in it: Hyper-V Manager',
      services: 'the ALBERA services are registered (docs/architecture/host-install.md)',
    },
    checklistEnd: 'This list is not a promise: a stopped service or a missing token shows only when a job runs.',
  },
  ja: {
    work: 'レベル: 任せる。この PC には Hyper-V と ALBERA のサービスがあります。',
    watch: 'レベル: 見る。この PC ではセッション一覧とデモが使えます。',
    missing: '任せる (VM でのジョブ) は使えません: {why}',
    fix: '変えるには: {how}',
    demo: '偽の VM で管制室を試すには: albera-runtime room --demo',
    home_edition: ['この Windows のエディションには Hyper-V がありません。', 'Windows Pro 以上が必要です。'],
    role_off: ['Hyper-V がオフか、このエディションにありません。', 'このエディションにあれば、Windows の機能で Hyper-V をオンにしてください。'],
    not_installed: ['Hyper-V はありますが、ALBERA のサービスが入っていません。承認つきのジョブにはサービスが必要です。', 'サービスをインストールしてください (docs/architecture/host-install.md)。'],
    platform: ['任せるには Hyper-V が必要で、Hyper-V は Windows にしかありません。', 'Hyper-V のある Windows PC を使ってください。'],
    unknown: ['この PC を確認できませんでした。', 'もう一度 albera-runtime doctor を実行してください。変わらなければ報告をお願いします。'],
    checklist: '任せるに必要なもの:',
    states: { ok: '[あり]', missing: '[なし]', unknown: '[不明]', manual: '[自分で確認]' },
    items: {
      hyperV: 'Hyper-V',
      node: 'インストールに必要: Program Files\\nodejs の Node.js (通常のインストーラーで入ります)',
      claude: 'インストールに必要: プロファイルの .local\\bin にある Claude Code の claude.exe (npm 版は使えません)',
      hello: 'Windows Hello: 設定、アカウント、サインイン オプション',
      vm: 'OS を入れた VM: Hyper-V マネージャー',
      services: 'ALBERA のサービスの登録 (docs/architecture/host-install.md)',
    },
    checklistEnd: 'これは保証ではありません。サービスの停止やトークンの不足は、ジョブを動かすまで分かりません。',
  },
});

/** The lines a person reads. Fixed text only: nothing from the PC is repeated in them. */
export function describeLevel(result, lang = 'en') {
  const w = WORDS[lang] ?? WORDS.en;
  if (result.work.available) return [w.work];
  const [why, how] = w[result.work.reason] ?? w.unknown;
  return [w.watch, w.missing.replace('{why}', why), w.fix.replace('{how}', how), w.demo];
}

/** The checklist as lines. Fixed text only, like describeLevel; nothing when there is no list. */
export function describeChecklist(checklist, lang = 'en') {
  if (checklist.length === 0) return [];
  const w = WORDS[lang] ?? WORDS.en;
  return [w.checklist, ...checklist.map(({ item, state }) => `  ${w.states[state] ?? w.states.unknown} ${w.items[item]}`), w.checklistEnd];
}

/** The language of the terminal: Japanese for a Japanese system, otherwise English. */
export const systemLang = () => (new Intl.DateTimeFormat().resolvedOptions().locale.startsWith('ja') ? 'ja' : 'en');
