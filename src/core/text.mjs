// @ts-check
// core: 文字列の整形 (純粋関数)。

/**
 * code point 単位で n 文字以内に切る。切ったときは末尾を「…」にする。
 * @param {unknown} value
 * @param {number} n
 * @returns {string}
 */
export function cap(value, n) {
  if (typeof value !== 'string' || value === '') return '';
  if (value.length <= n) return value; // UTF-16 長が n 以下なら code point も n 以下
  const points = Array.from(value);
  if (points.length <= n) return value;
  return points.slice(0, Math.max(0, n - 1)).join('') + '…';
}

/** @param {unknown} v */
export const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * lastTurnReport ("<要約> ⏎ <最後のメッセージ>") から要約部分を取り出す。
 * 前後の " と \" を外し、⏎ より前を取り、[t](u) を t にして、空白を詰める。
 * @param {unknown} report
 * @returns {string}
 */
export function reportSummary(report) {
  if (typeof report !== 'string') return '';
  let t = report.trim();
  t = t.replace(/^(\\?")+/, '').replace(/(\\?")+$/, '');
  const cut = t.indexOf('⏎');
  if (cut >= 0) t = t.slice(0, cut);
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\*\*/g, '');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * エラー文から使用上限の解除時刻の部分 ("resets 1:50pm") を取り出す。
 * @param {string} error
 * @returns {string}
 */
export function resetPart(error) {
  const m = error.match(/resets?\s.+$/);
  return m ? m[0].trim() : '';
}

// --- cleanText (v0.2、spec/board.md §5.1): Claude 自身の短い言葉 (note・step) を画面に出す前に通す ---
// 秘密らしい並び・URL・UUID・絶対パスを消し、短く切る。出力は新しく作った文字列だけ。
const REDACTED = '•••';
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
const SPACE_CTRL_RE = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
// 制御文字と見えない文字: 書式文字 (\p{Cf}: 幅ゼロ・双方向の上書きと分離・ソフトハイフン・タグ文字など)、書記素の連結子、
// ハングルの埋め字、異体字セレクタ。見えないまま並びを割って、下の規則 (長い並び・メール) をすり抜けさせない
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u3164\ufe00-\ufe0f\uffa0\u{e0100}-\u{e01ef}]|\p{Cf}/gu;
const URL_RE = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'`<>()[\]{}]+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const UUID_RE = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+)?/g;
const BEARER_RE = /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})/gi;
// スキームの無い user:pass@host (メールの規則より先に見る) と curl -u user:pass: パスワードの部分だけ •••
const USERINFO_RE = /(?<![\w.%+-])([A-Za-z0-9._%+-]+):([^\s@/:]+)@(?=[A-Za-z0-9-])/g;
const USER_FLAG_RE = /(?<![\w-])(-u|--user)(\s+|=)([^\s:]+):(\S+)/g;
// 絶対パスの始まり: ドライブ・/・~/ と ~user/・\\ (UNC)・\Users\… (ルートからの相対。\n のような 1 文字の並びは除く)
const PATH_START = String.raw`(?:[A-Za-z]:[\\/]|~[A-Za-z0-9._-]*[\\/]|\\\\|\\(?=[A-Za-z][A-Za-z0-9._-]+\\)|\/)`;
const SEG = String.raw`[^\s"'\x60<>()[\]{},;]`;
const SEG_NOSEP = String.raw`[^\s"'\x60<>()[\]{},;\\/]`;
// パスの中の空白: 続く 3 語以内に、新しいパスで始まらない区切りつきの語があれば、そこまで同じパス
// (C:\Users\Jane Doe\OneDrive - Acme\x は x まで。/a/b.txt to /tmp/y の /tmp/y は別のパス)
const PATH_SPACE = String.raw`\s(?=(?:${SEG_NOSEP}+\s){0,2}(?!${PATH_START})${SEG_NOSEP}*[\\/])`;
// 絶対パス: 先頭か、空白・区切り・コロン・非 ASCII の文字のすぐ後ろから
const PATH_RE = new RegExp(String.raw`(^|[\s=:([{"'\x60<,]|[^\u0000-\u007f])(${PATH_START}(?:${SEG}|${PATH_SPACE})*)`, 'g');
// 引用符の中の絶対パスは、閉じる引用符まで (空白を含んでも) 1 つのパス
const QUOTED_PATH_RE = new RegExp(String.raw`(["'\x60])(${PATH_START}(?:(?!\1)[^\n])*)(\1?)`, 'g');
// 並び: 英数字と +/_- (= は区切り。KEY=<秘密> の KEY は残し、値だけを見る)
const RUN_RE = /[A-Za-z0-9+/_-]+/g;
const KEY_PREFIX_RE = /^(?:(?:sk-|gh[pousr]_|xox[a-z]-|glpat-)[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{16,})/;
const LONG_TOKEN_MIN = 24;
// - と _ で区切った語のどれかがこの長さ以上で英字と数字を混ぜていれば秘密らしい (日付つきのファイル名のような短い語の並びは残す)
const MIXED_PIECE_MIN = 8;
// 規則を当てる前に入力をこの長さで切る (規則の中には長い並びで遅くなるものがあるため。出力は n で切るので見た目は変わらない)
const PRE_CAP_MIN = 256;
const PRE_CAP_PER_POINT = 16;
const SECRET_KV_RE = /([A-Za-z0-9_.-]*(?:pass|pwd|token|secret|key|auth)[A-Za-z0-9_.-]*)(=|:(?=[^\s/]))("[^"]*"?|'[^']*'?|[^\s"']+)/gi;
// 区切りの前後に空白がある形 (password: x・token = x): 名前が password・pass・pwd・secret・token の語のときだけ。
// 値が小文字だけの 1 語 (「token: expiry」のような文) なら残す
const SECRET_KEY = String.raw`\b(?:[A-Za-z0-9]+[_-])*(?:password|passwd|passphrase|pass|pwd|secret|token)\b`;
const SECRET_SPACED_RE = new RegExp(String.raw`(${SECRET_KEY})(\s*[:=]\s+|\s+[:=]\s*)("[^"]*"?|'[^']*'?|[^\s"']+)`, 'gi');
// フラグの後ろの値: --password x・--token x
const SECRET_FLAG_RE = /(?<![\w-])(--(?:password|passwd|pass|pwd|token|secret|api-?key|auth-?token))(\s+)(?!-)("[^"]*"?|'[^']*'?|[^\s"']+)/gi;
const PLAIN_WORD_RE = /^[a-z]+[.,;:!?]?$/;

/** URL の host (小文字、資格情報とポートを外す)。形が変なら ''。 @param {string} url */
function urlHost(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url);
  let host = m ? m[1] : '';
  const at = host.lastIndexOf('@');
  if (at >= 0) host = host.slice(at + 1);
  host = host.replace(/:\d*$/, '').toLowerCase();
  return /^[a-z0-9.-]{1,64}$/.test(host) ? host : '';
}

/** パスの最後の部分 (区切りは / と \ の両方)。 @param {string} p */
const lastSegment = (p) => p.split(/[\\/]+/).filter((x) => x !== '').at(-1) ?? '';

/** パスを basename に (最後の . : ! ? は文の終わりとして残す)。basename が無ければ null。 @param {string} path */
function pathBase(path) {
  const tail = /[.:!?]+$/.exec(path)?.[0] ?? '';
  const base = lastSegment(path.slice(0, path.length - tail.length));
  return base === '' ? null : base + tail;
}

/**
 * 並び (英数字と +/_-) が秘密らしいか。/ で区切った各部分も鍵の頭を見る。ほかは 24 文字以上で英字と数字を含み、
 * - や _ の区切りが無いか、区切った語のどれかが MIXED_PIECE_MIN 文字以上で英字と数字を混ぜているもの。
 * @param {string} run
 */
export function looksSecret(run) {
  if (run.split('/').some((piece) => KEY_PREFIX_RE.test(piece))) return true;
  if (!(run.length >= LONG_TOKEN_MIN && /[A-Za-z]/.test(run) && /\d/.test(run))) return false;
  const pieces = run.split(/[-_]+/).filter(Boolean);
  return pieces.length < 2 || pieces.some((p) => p.length >= MIXED_PIECE_MIN && /[A-Za-z]/.test(p) && /\d/.test(p));
}

/** NFC にして、制御文字と見えない文字を消す (ファイル名など、画面に出す短い文字列にも使う)。 @param {string} s */
export const stripInvisible = (s) => s.normalize('NFC').replace(INVISIBLE_RE, '');

/**
 * cleanText と同じ規則で整え、消した (置き換えた) 箇所の数も返す (smoke が数だけを出すため)。
 * @param {unknown} value
 * @param {number} n 上限 (code point)
 * @returns {{text: string, hits: number}}
 */
export function cleanTextWithHits(value, n) {
  if (typeof value !== 'string' || value === '') return { text: '', hits: 0 };
  let hits = 0;
  /** @param {string} s @param {RegExp} re @param {(...m: string[]) => string} fn */
  const sub = (s, re, fn) => s.replace(re, (...m) => {
    const out = fn(...m);
    if (out !== m[0]) hits++;
    return out;
  });
  const limit = Math.max(PRE_CAP_MIN, n * PRE_CAP_PER_POINT);
  const truncated = value.length > limit;
  // 切ったときは、途中で切れた最後の並び (秘密の一部かもしれない) を出さない
  const head = truncated ? value.slice(0, limit).replace(/\S*$/, '') : value;
  let t = stripInvisible(head.normalize('NFC').replace(ANSI_RE, '').replace(SPACE_CTRL_RE, ' '));
  t = t.replace(/\s+/g, ' ').trim();
  t = sub(t, URL_RE, (url) => {
    const tail = /[.,;:!?]+$/.exec(url)?.[0] ?? '';
    return (urlHost(url.slice(0, url.length - tail.length)) || REDACTED) + tail;
  });
  t = sub(t, USERINFO_RE, (_m, user) => `${user}:${REDACTED}@`);
  t = sub(t, EMAIL_RE, () => REDACTED);
  t = sub(t, UUID_RE, () => '…');
  t = sub(t, JWT_RE, () => REDACTED);
  t = sub(t, BEARER_RE, (_m, word) => `${word} ${REDACTED}`);
  t = sub(t, USER_FLAG_RE, (_m, flag, sep, user) => `${flag}${sep}${user}:${REDACTED}`);
  t = sub(t, QUOTED_PATH_RE, (whole, open, path, close) => {
    const base = pathBase(path);
    return base === null ? whole : open + base + close;
  });
  t = sub(t, PATH_RE, (whole, lead, path) => {
    const base = pathBase(path);
    return base === null ? whole : lead + base;
  });
  t = sub(t, RUN_RE, (run) => (looksSecret(run) ? REDACTED : run));
  t = sub(t, SECRET_KV_RE, (whole, key, sep, val) => (val === REDACTED ? whole : `${key}${sep}${REDACTED}`));
  t = sub(t, SECRET_FLAG_RE, (whole, flag, sep, val) => (val === REDACTED ? whole : `${flag}${sep}${REDACTED}`));
  t = sub(t, SECRET_SPACED_RE, (whole, key, sep, val) => (val === REDACTED || PLAIN_WORD_RE.test(val) ? whole : `${key}${sep}${REDACTED}`));
  t = t.replace(/\s+/g, ' ').trim();
  if (truncated && t !== '') t += '…';
  return { text: cap(t, n), hits };
}

/**
 * Claude 自身の短い言葉 (Bash の description・計画の手順) を画面に出せる形にする (spec/board.md §5.1)。
 * NFC → 制御文字・見えない文字・ANSI を消す → 空白を詰める → URL はホストだけ (資格情報も消える) → user:pass@ の pass は •••
 * → メールは ••• → UUID は … → JWT・Bearer の値は ••• → -u user:pass の pass は ••• → 絶対パス (ドライブ・/・~/・~user/・\\・
 * \Users\ で始まる並び。引用符の中は閉じる引用符まで、空白の後ろも区切りの続く間は同じパス) は basename → 秘密らしい並び
 * (looksSecret・既知の鍵の頭) は ••• → 名前に pass|pwd|token|secret|key|auth を含む key=value と --password x は値を •••
 * → password: x のような空白つきの形も ••• (値が小文字の 1 語なら文として残す) → code point で n まで (切ったら …)。
 * 空になったら '' (省く)。パスを並びの規則より先に見るのは、長いパスが「•••.mjs」ではなく basename になるようにするため。
 * @param {unknown} value
 * @param {number} n
 * @returns {string}
 */
export const cleanText = (value, n) => cleanTextWithHits(value, n).text;
