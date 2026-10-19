import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandHead } from '../src/core/activity.mjs';
import { cap, cleanText, cleanTextWithHits, reportSummary, resetPart } from '../src/core/text.mjs';

test('cap: code point 単位で切り、切ったら末尾を「…」にする', () => {
  assert.equal(cap('abc', 5), 'abc');
  assert.equal(cap('abcdef', 4), 'abc…');
  assert.equal(Array.from(cap('😀'.repeat(10), 5)).length, 5);
  assert.equal(cap('😀'.repeat(10), 5), '😀😀😀😀…');
  assert.equal(cap('😀😀', 2), '😀😀'); // UTF-16 では 4 単位でも 2 文字なので切らない
  assert.equal(cap(undefined, 5), '');
  assert.equal(cap(42, 5), '');
});

test('reportSummary: 前後の引用符を外し、⏎ の前を取り、リンクを文字だけにして空白を詰める', () => {
  assert.equal(reportSummary('"[PR #3](https://x/y) を出しました。\n  確認待ち ⏎ 本文"'), 'PR #3 を出しました。 確認待ち');
  assert.equal(reportSummary('\\"**太字** と [別の会話](#local_x)\\"'), '太字 と 別の会話');
  assert.equal(reportSummary('要約だけ'), '要約だけ');
  assert.equal(reportSummary(undefined), '');
});

test('resetPart: 使用上限の解除時刻の部分', () => {
  assert.equal(resetPart("You've hit your session limit · resets 1:50pm"), 'resets 1:50pm');
  assert.equal(resetPart('limit reached'), '');
});

// --- cleanText (v0.2)。鍵の形の文字列は実行時に組み立てる (ソースに鍵の形を置かない)。どれも合成の偽物 ---
const fake = (/** @type {string[]} */ ...parts) => parts.join('');
const C = (/** @type {unknown} */ s, n = 80) => cleanText(s, n);

test('cleanText: 制御文字と ANSI エスケープを消し、空白を詰める (改行・タブは空白)', () => {
  assert.equal(C('Run \u001b[31mthe\u001b[0m tests'), 'Run the tests');
  assert.equal(C('a\u001b]0;title\u0007b'), 'ab');
  assert.equal(C('line one\nline two\t\tend'), 'line one line two end');
  assert.equal(C('bell\u0007 nul\u0000 del\u007f'), 'bell nul del');
  assert.equal(C('rtl\u202eoverride\u200bzero'), 'rtloverridezero');
  assert.equal(C('   spaced    out   '), 'spaced out');
});

test('cleanText: URL はホストだけ (資格情報・ポート・パス・クエリを消す)', () => {
  assert.equal(C('Fetch https://user:hunter2@API.example.com:8443/v1/items?token=abc#x'), 'Fetch api.example.com');
  assert.equal(C('Open http://example.com/a/b).'), 'Open example.com).');
  assert.equal(C('see ftp://files.example.org/pub'), 'see files.example.org');
  assert.equal(C('file:///C:/private/notes.txt'), '•••');
  assert.ok(!C('https://u:p@h.example/x').includes('u:p'));
});

test('cleanText: UUID は「…」、メールは •••', () => {
  assert.equal(C('Session 0f1e2d3c-4b5a-4968-8776-655443322110 done'), 'Session … done');
  assert.equal(C('Open local_00000000-0000-4000-8000-000000000001'), 'Open local_…');
  assert.equal(C('mail tester@example.org now'), 'mail ••• now');
});

test('cleanText: 英字と数字を含む 24 文字以上の並びは •••。字だけ・数字だけは残す', () => {
  assert.equal(C(`commit ${'3f2a9c8b7d6e'.repeat(3)}`), 'commit •••');
  assert.equal(C('token abcdEFGH1234ijklMNOP5678qrst'), 'token •••');
  assert.equal(C('Supercalifragilisticexpialidocious words'), 'Supercalifragilisticexpialidocious words');
  assert.equal(C('123456789012345678901234567890'), '123456789012345678901234567890');
  assert.equal(C('short a1b2c3'), 'short a1b2c3');
});

test('cleanText: 既知の鍵の頭 (sk- gh?_ xox?- AKIA AIza glpat-) で始まる並びは •••', () => {
  const keys = [
    fake('sk', '-', 'ant-api03-', 'FAKEfake0000'),
    fake('gh', 'p_', 'FAKEfake0000'),
    fake('gh', 'o_', 'FAKEfake0000'),
    fake('gh', 's_', 'FAKEfake0000'),
    fake('xo', 'xb-', '0000-FAKEfake'),
    fake('AK', 'IA', 'FAKEFAKEFAKEFAKE'),
    fake('AI', 'za', 'FAKE_fake_FAKE_fake_00'),
    fake('gl', 'pat-', 'FAKEfake0000'),
  ];
  for (const k of keys) assert.equal(C(`use ${k} here`), 'use ••• here', k.slice(0, 4));
  assert.equal(C(`KEY=${keys[0]}`), 'KEY=•••'); // = の後ろでも鍵の頭を見る
  assert.equal(C('sk-learn is fine'), 'sk-learn is fine'); // 頭だけで中身が短いものは残す
  assert.equal(C(fake('Bearer ', 'abcdefghijklmnop')), 'Bearer •••');
  assert.equal(C(fake('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxIn0', '.', 'c2lnbmF0dXJl')), '•••');
});

test('cleanText: 名前に pass|token|secret|key|auth を含む key=value は key=•••', () => {
  assert.equal(C('export API_TOKEN=hunter2 and password=x'), 'export API_TOKEN=••• and password=•••');
  assert.equal(C('--api-key=abc --verbose'), '--api-key=••• --verbose');
  assert.equal(C('secret:"two words" ok'), 'secret:••• ok');
  assert.equal(C('AUTH_HEADER=x'), 'AUTH_HEADER=•••');
  assert.equal(C('mode=fast'), 'mode=fast');
});

test('cleanText: 絶対パス (Windows・POSIX・~/・UNC) は basename', () => {
  assert.equal(C('Edit C:\\Users\\someone\\proj\\board.mjs now'), 'Edit board.mjs now');
  assert.equal(C('Read D:/code/beta/README.md'), 'Read README.md');
  assert.equal(C('cat /home/someone/proj/x.txt.'), 'cat x.txt.');
  assert.equal(C('Write ~/notes/today.md'), 'Write today.md');
  assert.equal(C('Copy \\\\server\\share\\f.txt'), 'Copy f.txt');
  assert.equal(C('--config=/etc/app/config.json'), '--config=config.json');
  assert.equal(C('(/var/log/app.log)'), '(app.log)');
  assert.equal(C('ファイル/home/someone/b.txtを編集'), 'ファイルb.txtを編集');
  assert.equal(C('and/or 1/2 KB/s ./rel/path'), 'and/or 1/2 KB/s ./rel/path'); // 絶対パスでないものは残す
  assert.equal(C('/'), '/');
});

test('cleanText: NFC、cap で code point 単位に切って「…」、空になったら ""', () => {
  assert.equal(C('Cafe\u0301'), 'Café');
  assert.equal(Array.from(C('あ'.repeat(50), 40)).length, 40);
  assert.equal(C('あ'.repeat(50), 40).at(-1), '…');
  assert.equal(C('😀'.repeat(41), 40), '😀'.repeat(39) + '…');
  assert.equal(C('exactly'.padEnd(40, 'x'), 40), 'exactly'.padEnd(40, 'x'));
  assert.equal(C(''), '');
  assert.equal(C('   \n\t '), '');
  assert.equal(C('\u001b[0m'), '');
  assert.equal(C(undefined), '');
  assert.equal(C(42), '');
  assert.equal(C({ toString: () => 'x' }), '');
});

test('cleanText: 巨大な入力でもすぐ終わり、先に切った最後の並び (秘密の一部かもしれない) は出さない', () => {
  const started = performance.now();
  for (const big of ['a'.repeat(200_000), 'a1-'.repeat(70_000), `${'x='.repeat(50_000)}`, `/${'d/'.repeat(80_000)}`, 'a@'.repeat(80_000)]) {
    const out = C(big, 40);
    assert.ok(Array.from(out).length <= 40);
  }
  assert.ok(performance.now() - started < 1000);
  // 前の部分が URL でホストだけに縮んでも、切られた最後の並びは見えない
  const cutSecret = `see https://example.com/${'p'.repeat(500)} ${'9f'.repeat(100)}`; // 16 進の並びが切る位置 (640) をまたぐ
  assert.equal(C(cutSecret, 40), 'see example.com…');
});

test('commandHead: 巨大な 1 行のコマンドでもすぐ終わる', () => {
  const started = performance.now();
  assert.equal(commandHead(`npm run build ${'"x" '.repeat(100_000)}`), 'npm run build');
  assert.equal(commandHead(`${'a'.repeat(300_000)}`), '');
  assert.ok(performance.now() - started < 1000);
});

test('cleanTextWithHits: 消した箇所の数 (smoke が数だけを出す)', () => {
  assert.deepEqual(cleanTextWithHits('Run the tests', 40), { text: 'Run the tests', hits: 0 });
  assert.deepEqual(cleanTextWithHits('Open https://example.com/x and /home/a/b.txt', 40), { text: 'Open example.com and b.txt', hits: 2 });
  assert.equal(cleanTextWithHits('password=x token=y', 40).hits, 2);
  assert.deepEqual(cleanTextWithHits(undefined, 40), { text: '', hits: 0 });
});

test('cleanText: 空白を含む絶対パスも basename (引用符の中は閉じるまで、外は区切りの続く間)', () => {
  const bs = String.fromCharCode(92);
  assert.equal(C(`List C:${bs}Users${bs}Jane Doe${bs}OneDrive - Acme Corp${bs}x`), 'List x');
  assert.equal(C('Copy /Users/jane/My Projects/acme-secret/x.txt'), 'Copy x.txt');
  assert.equal(C('Save to "/Users/jane/Library/Application Support/Claude/x.json"'), 'Save to "x.json"');
  assert.equal(C(`Open "C:${bs}Program Files${bs}Acme Secret${bs}tool.exe"`), 'Open "tool.exe"');
  assert.equal(C('Copy /a/b.txt to /tmp/y'), 'Copy b.txt to y', '次の絶対パスは別のパス');
  assert.equal(C('Edit src/core/text.mjs and /home/a/b.txt'), 'Edit src/core/text.mjs and b.txt', '相対パスは残す');
});

test('cleanText: コロンの後ろ・ルートからの相対 (バックスラッシュ + Users)・~user/ も絶対パス。改行の書き方のような 1 文字は残す', () => {
  const bs = String.fromCharCode(92);
  assert.equal(C(`path:C:${bs}Users${bs}jane${bs}secret${bs}a.txt`), 'path:a.txt');
  assert.equal(C('Read at:/home/jane/secret/x'), 'Read at:x');
  assert.equal(C(`Read ${bs}Users${bs}jane${bs}Documents${bs}notes.txt`), 'Read notes.txt');
  assert.equal(C('Edit ~jane/notes/x.md'), 'Edit x.md');
  assert.equal(C(`Replace ${bs}r${bs}n with ${bs}n`), `Replace ${bs}r${bs}n with ${bs}n`);
  assert.equal(C('Meet at 10:30 today'), 'Meet at 10:30 today');
});

test('cleanText: password: x・--password x・pwd=x・-u user:pass・user:pass@host の値は •••。小文字 1 語の文は残す', () => {
  const pw = ['hun', 'ter2'].join('');
  assert.equal(C(`Use password: ${pw}`), 'Use password: •••');
  assert.equal(C(`Logging in with password: ${pw}`), 'Logging in with password: •••');
  assert.equal(C(`Log in with --password ${pw}`), 'Log in with --password •••');
  assert.equal(C(`Set pwd=${pw}`), 'Set pwd=•••');
  assert.equal(C('token: abc123'), 'token: •••');
  assert.equal(C(`curl -u admin:${pw} api.internal`), 'curl -u admin:••• api.internal');
  assert.equal(C('Login as admin:Sup3rS3cret!@host'), 'Login as admin:•••@host');
  // 普通の文はそのまま
  for (const s of ['Check token: expiry', 'Fix auth: handle expiry', 'Update password reset page', 'Rotate token storage', 'Bypass: done', 'Fix API key handling']) assert.equal(C(s), s);
});

test('cleanText: 見えない文字 (ソフトハイフン・タグ文字・異体字セレクタ) は消してから並びとメールを見る', () => {
  assert.equal(C('key AbCdEfGhIjKlMn0\u00ad123456789ZyXwVu'), 'key •••');
  assert.equal(C('mail jane.doe\u00ad@example.com'), 'mail •••');
  assert.equal(C('tag \u{E0041}\u{E0042} end'), 'tag end');
  assert.equal(C('a\u034fb\ufe0fc\u2064d'), 'abcd');
});

test('cleanText: - と _ で区切った短い語の並び (日付つきの名前) は秘密とみなさない。長く混ぜた語があれば •••', () => {
  assert.equal(C('2026-10-18-release-notes.md'), '2026-10-18-release-notes.md');
  assert.equal(C('test-v2-integration-results-2026'), 'test-v2-integration-results-2026');
  assert.equal(C('tok3n-abcdef0123456789abcdef'), '•••');
  assert.equal(C('live_51HxYzAbC123DeF456gHi789'), '•••');
});
