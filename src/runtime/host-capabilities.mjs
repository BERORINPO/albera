// What this PC can use (docs/architecture/no-vm-mode.md): Watch everywhere, Work only with Hyper-V and the installed
// services. The result is for showing to a person and grants nothing: no start path reads it (arch-check rule 5c), and
// the Broker, the Authority and the receipts decide as before. Anything unknown counts as not available.
import { spawn } from 'node:child_process';
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

/** Gathers the facts of this PC. It needs no administrator, and it never throws. */
export async function probeHost({ platform = process.platform, systemRoot = process.env.SystemRoot, run = runFixed } = {}) {
  if (platform !== 'win32') return classify({ platform });
  if (typeof systemRoot !== 'string' || !path.win32.isAbsolute(systemRoot)) return classify({ platform, hyperV: 'unknown' });
  const scPath = path.win32.join(systemRoot, 'System32', 'sc.exe');
  const regPath = path.win32.join(systemRoot, 'System32', 'reg.exe');
  const [hyperV, services, edition] = await Promise.all([
    serviceFact(run, scPath, HYPERV_SERVICE), serviceFact(run, scPath, CONTROL_PLANE_SERVICE), editionFact(run, regPath),
  ]);
  return classify({ platform, hyperV, services, edition });
}

const WORDS = Object.freeze({
  en: {
    work: 'Level: Work. Jobs in VMs can be used on this PC.',
    watch: 'Level: Watch. The session board and the demo can be used on this PC.',
    missing: 'Work (jobs in VMs) cannot be used: {why}',
    fix: 'To change this: {how}',
    demo: 'To try the control room with fake VMs: albera-runtime room --demo',
    home_edition: ['this edition of Windows has no Hyper-V.', 'Windows Pro or above is needed.'],
    role_off: ['Hyper-V is not on, or this edition does not have it.', 'turn on the Hyper-V feature in Windows, if this edition offers it.'],
    not_installed: ['Hyper-V is here, but the ALBERA services are not installed, and jobs with approval need them.', 'install them (docs/architecture/host-install.md).'],
    platform: ['Work needs Hyper-V, which only Windows has.', 'use a Windows PC with Hyper-V.'],
    unknown: ['this PC could not be checked.', 'run albera-runtime doctor again. If it stays like this, please report it.'],
  },
  ja: {
    work: 'レベル: 任せる。この PC では VM でのジョブが使えます。',
    watch: 'レベル: 見る。この PC ではセッション一覧とデモが使えます。',
    missing: '任せる (VM でのジョブ) は使えません: {why}',
    fix: '変えるには: {how}',
    demo: '偽の VM で管制室を試すには: albera-runtime room --demo',
    home_edition: ['この Windows のエディションには Hyper-V がありません。', 'Windows Pro 以上が必要です。'],
    role_off: ['Hyper-V がオフか、このエディションにありません。', 'このエディションにあれば、Windows の機能で Hyper-V をオンにしてください。'],
    not_installed: ['Hyper-V はありますが、ALBERA のサービスが入っていません。承認つきのジョブにはサービスが必要です。', 'サービスをインストールしてください (docs/architecture/host-install.md)。'],
    platform: ['任せるには Hyper-V が必要で、Hyper-V は Windows にしかありません。', 'Hyper-V のある Windows PC を使ってください。'],
    unknown: ['この PC を確認できませんでした。', 'もう一度 albera-runtime doctor を実行してください。変わらなければ報告をお願いします。'],
  },
});

/** The lines a person reads. Fixed text only: nothing from the PC is repeated in them. */
export function describeLevel(result, lang = 'en') {
  const w = WORDS[lang] ?? WORDS.en;
  if (result.work.available) return [w.work];
  const [why, how] = w[result.work.reason] ?? w.unknown;
  return [w.watch, w.missing.replace('{why}', why), w.fix.replace('{how}', how), w.demo];
}

/** The language of the terminal: Japanese for a Japanese system, otherwise English. */
export const systemLang = () => (new Intl.DateTimeFormat().resolvedOptions().locale.startsWith('ja') ? 'ja' : 'en');
