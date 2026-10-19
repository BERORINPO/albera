// @ts-check
// core: していること (spec/board.md §5.1、純粋関数)。tail の今のターンの最後の tool_use から、
// 種類のコード (ActivityKind) と短い安全な対象 (basename・commandHead・ホスト・コネクタ名) だけを出す。
// 言葉は画面 (doing.*)。transcript の生のオブジェクトは出力に入れない (文字列は新しく作る)。now は使わない (memo できる)。

import { ASK_TOOLS, CAP, COMMAND_RUNNERS, SUBAGENT_SCAN_MAX } from '../shared/constants.mjs';
import { cap, cleanText, looksSecret } from './text.mjs';
import { judgeUser } from './turn.mjs';

/** @typedef {import('../shared/types.mjs').ActivityKind} ActivityKind */
/** @typedef {import('../shared/types.mjs').ActivityFacts} ActivityFacts */
/** @typedef {import('../shared/types.mjs').Activity} Activity */
/** @typedef {import('../shared/types.mjs').BucketKey} BucketKey */

const SYNTHETIC_MODEL = '<synthetic>';
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LSP']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const AGENT_TOOLS = new Set(['Agent', 'Task', 'Workflow']);
const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);
const BROWSER_RE = /browser|playwright|chrome/i;
const MCP_RE = /^mcp__(.+?)__/;
const CONNECTOR_RE = /^[a-z][a-z0-9_-]{1,23}$/i;
const OPAQUE_HEX_RE = /[0-9a-f]{8,}/i;
const HOST_RE = /^[a-z0-9.-]{1,64}$/;
const PLAN_ITEMS_MAX = 200; // 計画の項目の上限 (メモリ保護)

// --- commandHead (コマンドのうち画面に出るのはこれだけ) ---
const PROGRAM_RE = /^[A-Za-z0-9._:-]{1,24}$/;
const WORD_RE = /^[a-z][a-z0-9:_-]{0,23}$/;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DIR_CHANGE_RE = /^(?:cd|chdir|set-location|sl|pushd|popd)(?:\s|$)/i;
const PREFIX_WORDS = new Set(['sudo', 'env', '&']);
// 前置きの語のフラグ: 値を取るもの (次のトークンも飛ばす) と取らないもの。どちらでもないフラグが来たら、
// どれがプログラムか分からないので target を出さない (sudo -u <ユーザー名> の名前をプログラムと見誤らない)
const PREFIX_FLAGS = Object.freeze({
  sudo: {
    value: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--chdir', '--role', '--type', '--other-user', '--command-timeout', '--close-from']),
    bare: new Set(['-E', '-H', '-n', '-S', '-k', '-K', '-b', '-i', '-s', '-A', '-P', '-B', '-N', '-v', '-l', '-V', '--', '--preserve-env', '--login', '--shell', '--non-interactive', '--stdin', '--background', '--askpass', '--set-home', '--reset-timestamp', '--remove-timestamp', '--bell']),
  },
  env: {
    value: new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']),
    bare: new Set(['-i', '-0', '-v', '--', '--ignore-environment', '--null', '--debug']),
  },
});
const PACKAGE_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const EXEC_RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'pnpm', 'yarn', 'bun']);
const TEST_SUBCOMMAND = new Set(['go', 'cargo', 'dotnet', 'mvn', 'mvnw', 'gradle', 'gradlew']);
const PYTHON_RE = /^(?:python\d*(?:\.\d+)?|py|uv|pipenv|poetry)$/;
const TOKEN_RE = /(?:[^\s"']+|"(?:[^"\\]|\\.)*(?:"|$)|'[^']*(?:'|$))+/g;
const COMMAND_SCAN_MAX = 4000; // コマンドの先頭からこれだけを見る (頭が分かれば十分。巨大な 1 行で遅くしない)

/**
 * 1 行のコマンドを、引用符の外の && || ; で文に分け、各文を | でパイプの部分に分ける。
 * @param {string} line
 * @returns {string[][]} 文ごとのパイプの部分
 */
function splitStatements(line) {
  /** @type {string[][]} */
  const out = [];
  /** @type {string[]} */
  let pipe = [];
  let cur = '';
  /** @type {string|null} */
  let quote = null;
  const flushPart = () => {
    pipe.push(cur.trim());
    cur = '';
  };
  const flushStatement = () => {
    flushPart();
    out.push(pipe);
    pipe = [];
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < line.length) {
        cur += ch + line[++i];
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if ((ch === '&' || ch === '|') && line[i + 1] === ch) {
      flushStatement();
      i++;
      continue;
    } else if (ch === ';') {
      flushStatement();
      continue;
    } else if (ch === '|') {
      flushPart();
      continue;
    }
    cur += ch;
  }
  flushStatement();
  return out;
}

/** 前後の引用符を外したプログラムの basename (小文字、.exe .cmd .ps1 なし)。 @param {string} token */
function programName(token) {
  const bare = token.replace(/^(["'])(.*)\1$/s, '$2');
  const base = bare.split(/[\\/]/).filter((x) => x !== '').at(-1) ?? '';
  return base.toLowerCase().replace(/\.(?:exe|cmd|ps1)$/, '');
}

/**
 * テストの実行か (spec/board.md §5.1)。program は programName の結果、rest は残りの生のトークン。
 * @param {string} program
 * @param {string[]} rest
 */
function isTestRun(program, rest) {
  const words = rest.filter((t) => !t.startsWith('-'));
  const isTestWord = (/** @type {string|undefined} */ t) => typeof t === 'string' && /^test(?:$|[:_-])/.test(t);
  if (PACKAGE_RUNNERS.has(program) && (isTestWord(rest[0]) || (rest[0] === 'run' && isTestWord(rest[1])))) return true;
  if (program === 'node' && rest.some((t) => /^--test(?:$|[-=])/.test(t))) return true;
  if (program === 'pytest' || program === 'vitest' || program === 'jest') return true;
  if (PYTHON_RE.test(program) && rest.slice(0, 4).includes('pytest')) return true;
  if (EXEC_RUNNERS.has(program) && words.slice(0, 2).some((t) => t === 'vitest' || t === 'jest' || t === 'pytest')) return true;
  return TEST_SUBCOMMAND.has(program) && words[0] === 'test';
}

/**
 * 前置き (NAME=value・sudo・env・&) とそのフラグを飛ばした、プログラムのトークンの位置。前置きの語の後ろに
 * 知らないフラグがあれば -1 (値を取るフラグかもしれず、どれがプログラムか分からない)。
 * @param {string[]} tokens
 */
function programIndex(tokens) {
  /** @type {{value: Set<string>, bare: Set<string>}|null} */
  let flags = null;
  let prefixed = false;
  let k = 0;
  while (k < tokens.length) {
    const tok = tokens[k];
    if (ENV_ASSIGN_RE.test(tok)) k++;
    else if (PREFIX_WORDS.has(tok)) {
      prefixed = true;
      flags = /** @type {Record<string, {value: Set<string>, bare: Set<string>}>} */ (PREFIX_FLAGS)[tok] ?? null;
      k++;
    } else if (tok.startsWith('-')) {
      const name = tok.split('=')[0];
      if (flags?.value.has(name)) k += tok.includes('=') ? 1 : 2;
      else if (flags?.bare.has(tok)) k++;
      else if (prefixed) return -1;
      else k++;
    } else break;
  }
  return k;
}

/**
 * コマンドの種類 (test / git / run) と、画面に出してよい頭 (target、'' = 出さない)。
 * 1 行目だけ → 引用符の外の && || ; で分けた文のうち cd・Set-Location・pushd で始まらない最後のもの → そのパイプの先頭 →
 * 先頭の NAME=value・sudo・env・& と、その語のフラグ (値を取るフラグは値ごと。知らないフラグなら target は '') を外す → 1 つ目 = プログラムの basename (小文字、.exe .cmd .ps1 なし) →
 * 2・3 つ目は COMMAND_RUNNERS のときだけ、フラグでない小文字の単語が続く間だけ → プログラムが
 * /^[A-Za-z0-9._:-]{1,24}$/ に合わなければ target は ''。`node --test` だけはフラグを残す (単語の検査の前に見る)。
 * パイプはその先頭を見る (`npm test 2>&1 | tail` は tail ではなく npm test を実行している)。
 * @param {unknown} command
 * @returns {{kind: 'test'|'git'|'run', target: string}}
 */
export function commandInfo(command) {
  if (typeof command !== 'string') return { kind: 'run', target: '' };
  const firstLine = command.slice(0, COMMAND_SCAN_MAX).split(/\r?\n/)[0] ?? '';
  const statements = splitStatements(firstLine).filter((pipe) => pipe[0] !== '' && !DIR_CHANGE_RE.test(pipe[0]));
  const head = statements.at(-1)?.[0] ?? '';
  const tokens = head.match(TOKEN_RE) ?? [];
  const k = programIndex(tokens);
  if (k < 0 || k >= tokens.length) return { kind: 'run', target: '' };
  const program = programName(tokens[k]);
  const rest = tokens.slice(k + 1);
  const test = isTestRun(program, rest);
  const kind = test ? 'test' : program === 'git' || program === 'gh' ? 'git' : 'run';
  if (!PROGRAM_RE.test(program)) return { kind, target: '' };
  if (program === 'node' && test) return { kind, target: 'node --test' };
  const words = [];
  if (COMMAND_RUNNERS.includes(program)) {
    for (const t of rest.slice(0, 2)) {
      if (!WORD_RE.test(t)) break;
      words.push(t);
    }
  }
  return { kind, target: cap([program, ...words].join(' '), CAP.ACT_TARGET) };
}

/** @param {unknown} command */
export const commandHead = (command) => commandInfo(command).target;

/**
 * パスの最後の部分 (区切りは / と \ の両方) を、note と同じ規則 (cleanText: 見えない文字・UUID・秘密らしい並び・メール) に通して
 * CAP.ACT_TARGET で切る。UUID の名前の会話ログは「….jsonl」、鍵の形の名前は「•••.txt」になる。
 * @param {unknown} p
 */
function baseName(p) {
  if (typeof p !== 'string') return '';
  const last = p.split(/[\\/]/).filter((x) => x !== '').at(-1) ?? '';
  return cleanText(last, CAP.ACT_TARGET);
}

/** ホストのラベルが中身の分からない ID か (UUID・16 進の 8 文字以上・秘密らしい並び)。 @param {string} label */
const opaqueLabel = (label) => OPAQUE_HEX_RE.test(label) || looksSecret(label);

/**
 * WebFetch の url のホスト (小文字)。中身の分からない ID のラベル (トンネル・プロジェクト番号の部分) があれば、それより後ろだけ。
 * CAP.ACT_TARGET より長ければ最後の 2 つのラベル。それでも長いか、ID を外して 1 つのラベルしか残らなければ ''。
 * @param {unknown} url
 */
function hostOf(url) {
  if (typeof url !== 'string') return '';
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url.trim());
  if (!m) return '';
  const host = m[1].slice(m[1].lastIndexOf('@') + 1).replace(/:\d*$/, '').toLowerCase();
  if (!HOST_RE.test(host)) return '';
  const labels = host.split('.');
  const cut = labels.reduce((last, l, i) => (opaqueLabel(l) ? i : last), -1);
  let kept = labels.slice(cut + 1).filter((l) => l !== '');
  if (kept.join('.').length > CAP.ACT_TARGET) kept = kept.slice(-2);
  const out = kept.join('.');
  return kept.length >= (cut >= 0 ? 2 : 1) && out.length <= CAP.ACT_TARGET ? out : '';
}

/** mcp__<server>__* の server (中身の分からない ID の名前は出さない)。 @param {string} name */
function connectorOf(name) {
  const server = MCP_RE.exec(name)?.[1] ?? '';
  return CONNECTOR_RE.test(server) && !OPAQUE_HEX_RE.test(server) ? server : '';
}

/** @param {string} name */
const isPlanTool = (name) => PLAN_TOOLS.has(name) || name.endsWith('update_plan');

/**
 * tool の名前と入力から kind と target (spec/board.md §5.1 の表、上から最初に当たったもの)。
 * @param {string} name
 * @param {any} input
 * @returns {{kind: ActivityKind, target: string}}
 */
export function toolKind(name, input) {
  if (EDIT_TOOLS.has(name)) return { kind: 'edit', target: baseName(input?.file_path ?? input?.notebook_path) };
  if (name === 'Write') return { kind: 'write', target: baseName(input?.file_path) };
  if (name === 'Read') return { kind: 'read', target: baseName(input?.file_path) };
  if (SEARCH_TOOLS.has(name)) return { kind: 'search', target: '' };
  if (SHELL_TOOLS.has(name)) return commandInfo(input?.command);
  if (name === 'WebSearch') return { kind: 'web', target: '' };
  if (name === 'WebFetch') return { kind: 'web', target: hostOf(input?.url) };
  if (AGENT_TOOLS.has(name)) return { kind: 'agents', target: '' };
  if (BROWSER_RE.test(name)) return { kind: 'browser', target: '' };
  if (name.endsWith('wrap_up')) return { kind: 'wrap_up', target: '' };
  if (MCP_RE.test(name)) return { kind: 'connector', target: connectorOf(name) };
  return { kind: 'tool', target: '' };
}

/** 行の timestamp (ms)。有限の数でなければ undefined。 @param {any} entry */
function timeOf(entry) {
  const at = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(at) ? at : undefined;
}

/** 本筋の (sidechain でも合成でもない) assistant 行か。 @param {any} e */
const isMainAssistant = (e) => e.type === 'assistant' && e.isSidechain !== true && e.message?.model !== SYNTHETIC_MODEL;

/**
 * 計画の 1 回の呼び出しを再生する (items = 一覧を置き換える / advance = 進行中を完了にして次の pending を始める /
 * done: [i] と start: i は 1 始まり)。items がまだ無ければ何もしない (null のまま)。元の配列は書き換えない。
 * @param {Array<{text: string, status: string}>|null} list
 * @param {any} input
 */
function replayPlan(list, input) {
  if (!input || typeof input !== 'object') return list;
  let next = Array.isArray(input.items)
    ? input.items.slice(0, PLAN_ITEMS_MAX).map((/** @type {any} */ it) => ({
        text: typeof it?.content === 'string' ? it.content : '',
        status: typeof it?.status === 'string' ? it.status : 'pending',
      }))
    : list;
  if (!next) return null;
  if (input.advance === true) {
    const cur = next.findIndex((x) => x.status === 'in_progress');
    const after = next.map((x, i) => (i === cur ? { ...x, status: 'completed' } : x));
    const pend = after.findIndex((x) => x.status === 'pending');
    next = after.map((x, i) => (i === pend ? { ...x, status: 'in_progress' } : x));
  }
  if (Array.isArray(input.done)) {
    const done = new Set(input.done.filter((/** @type {unknown} */ d) => Number.isInteger(d)));
    next = next.map((x, i) => (done.has(i + 1) ? { ...x, status: 'completed' } : x));
  }
  if (Number.isInteger(input.start) && next[input.start - 1]) {
    next = next.map((x, i) => (i === input.start - 1 ? { ...x, status: 'in_progress' } : x.status === 'in_progress' ? { ...x, status: 'pending' } : x));
  }
  return next;
}

/**
 * tail の計画の呼び出しを古い順に再生し、進行中の項目の文字 (cleanText 済み)。一覧を置き換える呼び出し
 * (update_plan の items か TodoWrite) が tail に無ければ ''。TodoWrite は in_progress の todo の activeForm ?? content。
 * @param {any[]} entries
 * @returns {string}
 */
export function planStep(entries) {
  /** @type {Array<{text: string, status: string}>|null} */
  let list = null;
  for (const e of entries) {
    if (!isMainAssistant(e) || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
      if (b.name.endsWith('update_plan')) list = replayPlan(list, b.input);
      else if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) {
        list = b.input.todos.slice(0, PLAN_ITEMS_MAX).map((/** @type {any} */ t) => ({
          text: typeof t?.activeForm === 'string' && t.activeForm.trim() !== '' ? t.activeForm : typeof t?.content === 'string' ? t.content : '',
          status: typeof t?.status === 'string' ? t.status : 'pending',
        }));
      }
    }
  }
  const cur = list?.find((x) => x.status === 'in_progress');
  return cur ? cleanText(cur.text, CAP.ACT_TEXT) : '';
}

/**
 * 今のターン: 末尾から、直近の「指示」の user 行 (parseTurn が lastKind 'prompt' と読む行) まで。
 * sidechain・合成の assistant 行・parseTurn が読み飛ばす受け身の user 行と system 行 (stop_hook_summary を除く) は飛ばす。
 * answered = 指示の後に合成の assistant 行 (API エラーの代わりの行) がある: 指示には (エラーで) 返事が済んでいる。
 * @param {any[]} entries
 * @returns {{tools: Array<{name: string, input: any, entry: any}>, lastKept: any, prompt: any, answered: boolean}}
 */
function currentTurn(entries) {
  const st = { skipCmd: false };
  /** @type {Array<{name: string, input: any, entry: any}>} */
  const tools = [];
  let lastKept = null;
  let prompt = null;
  let answered = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.isSidechain === true) continue;
    if (e.type === 'system') {
      if (e.subtype === 'stop_hook_summary') lastKept ??= e;
      continue;
    }
    if (e.type === 'assistant') {
      if (e.message?.model === SYNTHETIC_MODEL) answered = true;
      if (!isMainAssistant(e)) continue;
      lastKept ??= e;
      const content = Array.isArray(e.message?.content) ? e.message.content : [];
      for (let j = content.length - 1; j >= 0; j--) {
        const b = content[j];
        if (b && b.type === 'tool_use' && typeof b.name === 'string') tools.push({ name: b.name, input: b.input, entry: e });
      }
      continue;
    }
    const r = judgeUser(e, st);
    if (!r) continue;
    lastKept ??= e;
    if (r.turn === 'inprogress' && r.lastKind === 'prompt') {
      prompt = e;
      break;
    }
  }
  return { tools, lastKept, prompt, answered };
}

/**
 * していることの材料 (spec/board.md §5.1)。now を使わない。何も当たらなければ null。
 * @param {any[]} entries turnEntries の結果
 * @returns {ActivityFacts}
 */
export function activityFacts(entries) {
  const { tools, lastKept, prompt, answered } = currentTurn(entries);
  const usable = tools.filter((t) => !ASK_TOOLS.includes(t.name));
  const main = usable.find((t) => !isPlanTool(t.name));
  /** @type {{kind: ActivityKind, target: string, line: any}|null} */
  let picked = null;
  if (main) picked = { ...toolKind(main.name, main.input), line: main.entry };
  else if (usable.length) picked = { kind: 'plan', target: '', line: usable[0].entry };
  else if (prompt && lastKept === prompt && !answered) picked = { kind: 'think', target: '', line: prompt };
  if (!picked) return null;
  const note = main && SHELL_TOOLS.has(main.name) && typeof main.input?.description === 'string' ? cleanText(main.input.description, CAP.ACT_TEXT) : '';
  const step = planStep(entries);
  const at = timeOf(picked.line);
  return {
    kind: picked.kind,
    ...(picked.target ? { target: picked.target } : {}),
    ...(note ? { note } : {}),
    ...(step ? { step } : {}),
    ...(at !== undefined ? { at } : {}),
  };
}

/**
 * カードに付ける Activity (spec/board.md §5.1)。返事待ちと片付けのカードには付けない。live = 作業中のカードだけ。
 * 作業中で subLive ≥ 1 なら kind を agents、n = min(subLive, SUBAGENT_SCAN_MAX) にする (target と note は外し、step は残す)。
 * 材料が無くても作業中で subLive ≥ 1 なら agents (バックグラウンドで動いている)。
 * @param {ActivityFacts|undefined} facts
 * @param {BucketKey} bucket
 * @param {number} subLive
 * @returns {Activity|undefined}
 */
export function finishActivity(facts, bucket, subLive) {
  if (bucket === 'needs_you' || bucket === 'cleanup') return undefined;
  const live = bucket === 'working';
  const n = Number.isFinite(subLive) ? Math.min(Math.max(0, Math.floor(subLive)), SUBAGENT_SCAN_MAX) : 0;
  const step = facts?.step ? { step: facts.step } : {};
  const at = facts?.at !== undefined ? { at: facts.at } : {};
  if (live && n >= 1) return { kind: 'agents', n, ...step, live, ...at };
  if (!facts) return undefined;
  return {
    kind: facts.kind,
    ...(facts.target ? { target: facts.target } : {}),
    ...(facts.note ? { note: facts.note } : {}),
    ...step,
    live,
    ...at,
  };
}
