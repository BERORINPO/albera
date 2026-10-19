import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityFacts, commandHead, commandInfo, finishActivity, planStep, toolKind } from '../src/core/activity.mjs';
import { turnEntries } from '../src/core/turn.mjs';
import { ACTIVITY_KINDS, CAP, SUBAGENT_SCAN_MAX } from '../src/shared/constants.mjs';
import { NOW, MIN, assistantLine, synth, synth2 } from './helpers/fixtures.mjs';

const join = (/** @type {string[]} */ ...lines) => lines.join('\n') + '\n';
/** @param {string[]} lines */
const facts = (...lines) => activityFacts(turnEntries(join(...lines), false));
/** 指示 → tool 1 つ、の今のターン。 @param {string} name @param {Record<string, unknown>} [input] */
const one = (name, input = {}) => facts(synth.prompt('go'), synth2.tool(name, input));

test('activity: 表のすべてのツール → kind と target (上の行から順に、最初に当たったもの)', () => {
  /** @type {Array<[string, Record<string, unknown>, string, string|undefined]>} */
  const rows = [
    ['Edit', { file_path: 'C:\\work\\alpha\\src\\board.mjs' }, 'edit', 'board.mjs'],
    ['MultiEdit', { file_path: '/home/tester/alpha/src/a.ts' }, 'edit', 'a.ts'],
    ['NotebookEdit', { notebook_path: '~/notes/book.ipynb' }, 'edit', 'book.ipynb'],
    ['Write', { file_path: '/home/tester/alpha/new.md' }, 'write', 'new.md'],
    ['Read', { file_path: 'D:\\code\\beta\\README.md' }, 'read', 'README.md'],
    ['Grep', { pattern: 'secret', path: '/home/tester' }, 'search', undefined],
    ['Glob', { pattern: '**/*.mjs' }, 'search', undefined],
    ['LSP', { file_path: '/x/y.ts' }, 'search', undefined],
    ['Bash', { command: 'npm test' }, 'test', 'npm test'],
    ['Bash', { command: 'git push origin main' }, 'git', 'git push origin'],
    ['Bash', { command: 'npm run report' }, 'run', 'npm run report'],
    ['PowerShell', { command: 'Get-ChildItem -Recurse C:\\work' }, 'run', 'get-childitem'],
    ['WebSearch', { query: 'how to' }, 'web', undefined],
    ['WebFetch', { url: 'https://user:pw@Docs.Example.com:8443/a/b?q=1' }, 'web', 'docs.example.com'],
    ['WebFetch', { url: 'not a url' }, 'web', undefined],
    ['Agent', { prompt: 'look' }, 'agents', undefined],
    ['Task', { prompt: 'look' }, 'agents', undefined],
    ['Workflow', { script: 'x' }, 'agents', undefined],
    ['mcp__Claude_Browser__navigate', { url: 'https://example.com' }, 'browser', undefined],
    ['mcp__playwright__browser_click', {}, 'browser', undefined],
    ['mcp__claude-in-chrome__computer', {}, 'browser', undefined],
    ['mcp__ccd_turn__wrap_up', { recap: 'x' }, 'wrap_up', undefined],
    ['mcp__session-bus__send_message', {}, 'connector', 'session-bus'],
    ['mcp__00000000-1111-4222-8333-444444444444__read', {}, 'connector', undefined], // 中身の分からない ID
    ['mcp__abcdef12345__x', {}, 'connector', undefined], // 16 進の 8 文字以上の並び
    ['mcp__a_name_that_is_far_too_long_x__y', {}, 'connector', undefined],
    ['ToolSearch', { query: 'x' }, 'tool', undefined],
    ['SendMessage', { to: 'x' }, 'tool', undefined],
  ];
  /** @type {Set<string>} */
  const seen = new Set(['plan', 'think']); // この 2 つは下のテストで確かめる
  for (const [name, input, kind, target] of rows) {
    const f = one(name, input);
    assert.equal(f?.kind, kind, name);
    assert.equal(f?.target, target, `${name} target`);
    seen.add(kind);
  }
  assert.deepEqual([...seen].sort(), [...ACTIVITY_KINDS].sort());
});

test('activity: target は CAP.ACT_TARGET まで、制御文字を除き、空なら省く', () => {
  const long = one('Edit', { file_path: `/x/${'a'.repeat(60)}.mjs` });
  assert.equal(Array.from(long?.target ?? '').length, CAP.ACT_TARGET);
  assert.ok(long?.target?.endsWith('…'));
  assert.equal(one('Edit', { file_path: '/x/a\u0007b.mjs' })?.target, 'ab.mjs');
  assert.equal(one('Edit', { file_path: '/' })?.target, undefined);
  assert.equal(one('Edit', {})?.target, undefined);
  assert.equal(toolKind('Read', { file_path: 42 }).target, '');
});

test('activity: 計画のツールは他のツールがあれば step だけ、単独なら kind plan', () => {
  const items = { items: [{ content: '仕様を書く', status: 'in_progress' }, { content: '実装する', status: 'pending' }] };
  const withEdit = facts(synth.prompt('go'), synth2.plan(items), synth2.tool('Edit', { file_path: '/a/b.mjs' }));
  assert.deepEqual({ kind: withEdit?.kind, target: withEdit?.target, step: withEdit?.step }, { kind: 'edit', target: 'b.mjs', step: '仕様を書く' });
  const planAfterEdit = facts(synth.prompt('go'), synth2.tool('Edit', { file_path: '/a/b.mjs' }), synth2.plan({ advance: true }));
  assert.equal(planAfterEdit?.kind, 'edit'); // 一番新しいのが計画でも、他のツールがあればそちら
  assert.equal(facts(synth.prompt('go'), synth2.plan(items))?.kind, 'plan');
  assert.equal(facts(synth.prompt('go'), synth2.tool('TodoWrite', { todos: [] }))?.kind, 'plan');
  assert.equal(facts(synth.prompt('go'), synth2.tool('TaskCreate', { subject: 'x' }))?.kind, 'plan');
  assert.equal(facts(synth.prompt('go'), synth2.tool('TaskUpdate', { taskId: '1' }))?.kind, 'plan');
});

test('activity: ASK_TOOLS は無視する (返事待ちで出る)', () => {
  const f = facts(synth.prompt('go'), synth2.tool('Read', { file_path: '/a/spec.md' }), synth.ask('q1', 'どちら?'), synth.resultFor('q1'));
  assert.equal(f?.kind, 'read');
  assert.equal(facts(synth.prompt('go'), synth.ask('q1', 'どちら?'), synth.resultFor('q1')), null);
  assert.equal(facts(synth.prompt('go'), synth.ask('p1', 'plan', 'ExitPlanMode')), null);
});

test('activity: 前のターンには入らない (直近の指示の行で止まる)', () => {
  const prevTurn = [synth.prompt('first'), synth2.tool('Edit', { file_path: '/a/old.mjs' }), synth.toolResult(), synth.text('done'), synth.stopHook()];
  assert.equal(facts(...prevTurn, synth.prompt('next'))?.kind, 'think');
  const f = facts(...prevTurn, synth.prompt('next'), synth2.tool('Read', { file_path: '/a/new.mjs' }));
  assert.deepEqual({ kind: f?.kind, target: f?.target }, { kind: 'read', target: 'new.mjs' });
  // 受け身の user 行 (task-notification・system-reminder・ローカルコマンド) は区切りにならない
  const passive = facts(synth.prompt('go'), synth2.tool('Edit', { file_path: '/a/x.mjs' }), synth.notification(), synth.reminder(), synth.commandName(), synth.commandStdout());
  assert.equal(passive?.kind, 'edit');
  // tail の先頭まで指示が無ければ tail 全体が今のターン
  assert.equal(facts(synth.toolResult(), synth2.tool('Grep', {}))?.kind, 'search');
});

test('activity: think は指示が最後のときだけ。ツール無しで終わったターンは null', () => {
  assert.equal(facts(synth.prompt('go'))?.kind, 'think');
  assert.equal(facts(synth.text('ok'), synth.stopHook(), synth.prompt('go'), synth.reminder(), synth.meta())?.kind, 'think');
  assert.equal(facts(synth.prompt('go'), synth.text('answer')), null);
  assert.equal(facts(synth.prompt('go'), synth.text('answer'), synth.stopHook()), null);
  assert.equal(facts(synth.prompt('go'), synth.stopHook()), null);
  assert.equal(facts(synth.prompt('go'), synth.interrupted()), null);
  assert.equal(facts(), null);
  assert.equal(facts(synth.noise()), null);
});

test('activity: ターンが終わっていても、ツールのあったターンなら最後のツール (画面は「最後に」と出す)', () => {
  const f = facts(synth.prompt('go'), synth2.tool('Edit', { file_path: '/a/x.mjs' }), synth.toolResult(), synth.text('done'), synth.stopHook());
  assert.equal(f?.kind, 'edit');
});

test('activity: sidechain と <synthetic> の行を飛ばす', () => {
  const f = facts(
    synth.prompt('go'),
    synth2.tool('Edit', { file_path: '/a/main.mjs' }),
    synth2.sidePrompt('subagent の指示'),
    synth2.tool('Read', { file_path: '/a/side.mjs' }, { sidechain: true }),
    synth2.tool('Bash', { command: 'npm test' }, { model: '<synthetic>' }),
  );
  assert.deepEqual({ kind: f?.kind, target: f?.target }, { kind: 'edit', target: 'main.mjs' });
  // 指示への返事が合成の行 (API エラーの代わり) だけなら、考えている途中ではない (返事は済んでいる) → null
  const apiError = assistantLine([{ type: 'text', text: 'API Error' }], { model: '<synthetic>', stop: 'stop_sequence' });
  assert.equal(facts(synth.prompt('go'), apiError), null);
  assert.equal(facts(synth.prompt('go'), apiError, synth.reminder())?.kind, undefined);
  // sidechain の合成の行は数えない
  assert.equal(facts(synth.prompt('go'), assistantLine([{ type: 'text', text: 'x' }], { model: '<synthetic>', sidechain: true }))?.kind, 'think');
});

test('activity: note は kind を決めた Bash / PowerShell の description だけ (cleanText を通す)', () => {
  const bash = one('Bash', { command: 'npm test', description: 'Run the unit tests' });
  assert.equal(bash?.note, 'Run the unit tests');
  const ps = one('PowerShell', { command: 'Get-Item x', description: 'Check C:\\Users\\someone\\secret\\x.txt' });
  assert.equal(ps?.note, 'Check x.txt');
  assert.equal(one('Edit', { file_path: '/a/b.mjs', description: 'not a shell' })?.note, undefined);
  const notKindSetter = facts(synth.prompt('go'), synth2.tool('Bash', { command: 'ls', description: 'List files' }), synth2.tool('Edit', { file_path: '/a/b.mjs' }));
  assert.equal(notKindSetter?.note, undefined);
  assert.equal(one('Bash', { command: 'ls', description: '   ' })?.note, undefined);
  assert.equal(one('Bash', { command: 'ls', description: 42 })?.note, undefined);
  const long = one('Bash', { command: 'ls', description: 'x'.repeat(100) });
  assert.equal(Array.from(long?.note ?? '').length, CAP.ACT_TEXT);
});

test('activity: at はその tool の行の timestamp (読めなければ省く)。think は指示の行', () => {
  const at = NOW - 3 * MIN;
  assert.equal(facts(synth.prompt('go', NOW - 9 * MIN), synth2.tool('Read', {}, { at }))?.at, at);
  assert.equal(facts(synth.prompt('go'), synth2.tool('Read', {}))?.at, undefined);
  assert.equal(facts(synth.prompt('go', at))?.at, at);
});

test('activity: 出力は新しく作った文字列だけ (生の入力・コマンド・パスを持たない)', () => {
  const f = facts(synth.prompt('go'), synth2.tool('Bash', { command: 'FOO=secret-value npm test -- --grep "x"', description: 'Run tests' }));
  assert.deepEqual(Object.keys(f ?? {}).sort(), ['kind', 'note', 'target']);
  const json = JSON.stringify(f);
  assert.ok(!json.includes('secret-value'));
  assert.ok(!json.includes('--grep'));
});

test('計画の再生: items のあと advance・done・start。items の無い advance は step 無し', () => {
  const items = { items: [{ content: 'one', status: 'in_progress' }, { content: 'two', status: 'pending' }, { content: 'three', status: 'pending' }] };
  const step = (/** @type {string[]} */ ...lines) => planStep(turnEntries(join(...lines), false));
  assert.equal(step(synth2.plan(items)), 'one');
  assert.equal(step(synth2.plan(items), synth2.plan({ advance: true })), 'two');
  assert.equal(step(synth2.plan(items), synth2.plan({ advance: true }), synth2.plan({ advance: true })), 'three');
  assert.equal(step(synth2.plan(items), synth2.plan({ done: [1], start: 3 })), 'three');
  assert.equal(step(synth2.plan(items), synth2.plan({ start: 2 })), 'two'); // 前の進行中は pending に戻る
  assert.equal(step(synth2.plan({ advance: true })), '');
  assert.equal(step(synth2.plan({ done: [1], start: 2 })), '');
  const allDone = { items: [{ content: 'one', status: 'completed' }] };
  assert.equal(step(synth2.plan(allDone)), '');
  assert.equal(step(synth2.plan(items), synth2.plan({ advance: true }), synth2.plan({ advance: true }), synth2.plan({ advance: true })), '');
  // 前のターンの計画も tail の中なら再生する。sidechain の計画は見ない
  assert.equal(step(synth2.plan(items), synth.text('ok'), synth.stopHook(), synth.prompt('next'), synth2.plan({ advance: true })), 'two');
  const side = assistantLine([{ type: 'tool_use', id: 't', name: 'mcp__ccd_turn__update_plan', input: { advance: true } }], { sidechain: true });
  assert.equal(step(synth2.plan(items), side), 'one');
});

test('計画の再生: TodoWrite は in_progress の todo の activeForm ?? content。手順の文字は cleanText を通す', () => {
  const step = (/** @type {string[]} */ ...lines) => planStep(turnEntries(join(...lines), false));
  const todos = (/** @type {unknown[]} */ list) => synth2.tool('TodoWrite', { todos: list });
  assert.equal(step(todos([{ content: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' }])), 'Writing tests');
  assert.equal(step(todos([{ content: 'Write tests', status: 'in_progress' }])), 'Write tests');
  assert.equal(step(todos([{ content: 'Write tests', status: 'pending' }])), '');
  const secret = { items: [{ content: 'Edit /home/tester/private/notes.md with token=abc123', status: 'in_progress' }] };
  assert.equal(step(synth2.plan(secret)), 'Edit notes.md with token=•••');
  // TodoWrite のあとの update_plan の advance は TodoWrite の一覧に効く
  assert.equal(step(todos([{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }]), synth2.plan({ advance: true })), 'b');
});

test('commandHead: 残すもの (npm test・npm run report・node --test・pytest・git push・gh pr)', () => {
  /** @type {Array<[string, string, string]>} */
  const rows = [
    ['npm test', 'npm test', 'test'],
    ['npm run report', 'npm run report', 'run'],
    ['node --test', 'node --test', 'test'],
    ['node --test test/x.test.mjs', 'node --test', 'test'],
    ['pytest -q tests/', 'pytest', 'test'],
    ['git push', 'git push', 'git'],
    ['gh pr create --fill', 'gh pr create', 'git'],
    ['go test ./...', 'go test', 'test'],
    ['cargo test', 'cargo test', 'test'],
    ['dotnet test', 'dotnet test', 'test'],
    ['mvn test', 'mvn test', 'test'],
    ['gradle test', 'gradle test', 'test'],
    ['npx vitest run', 'npx vitest run', 'test'],
    ['jest --watch', 'jest', 'test'],
    ['yarn run test:unit', 'yarn run test:unit', 'test'],
    ['python -m pytest', 'python', 'test'],
    ['docker compose up -d', 'docker compose up', 'run'],
    ['ls -la', 'ls', 'run'],
  ];
  for (const [cmd, target, kind] of rows) assert.deepEqual(commandInfo(cmd), { kind, target }, cmd);
});

test('commandHead: 前置き (NAME=value・sudo・env・cd x &&・&) を外し、プログラムは basename の小文字で .exe .cmd .ps1 なし', () => {
  assert.equal(commandHead('FOO=bar npm test'), 'npm test');
  assert.equal(commandHead('FOO=bar BAZ=1 env sudo npm test'), 'npm test');
  assert.equal(commandHead('cd x && npm run build'), 'npm run build');
  assert.equal(commandHead('cd "C:\\some dir" && git status'), 'git status');
  assert.equal(commandHead('Set-Location C:\\work; pushd y; npm test'), 'npm test');
  assert.equal(commandHead('C:\\tools\\x.exe --flag'), 'x');
  assert.equal(commandHead('"C:\\Program Files\\nodejs\\npm.cmd" test'), 'npm test');
  assert.equal(commandHead("& 'C:\\Program Files\\x\\Tool.ps1' -Arg 1"), 'tool');
  assert.equal(commandHead('$env:FOO="1"; npm test'), 'npm test');
  assert.equal(commandHead('cd x'), '');
  assert.equal(commandHead('npm test\nrm -rf /'), 'npm test'); // 1 行目だけ
  assert.equal(commandHead('npm test 2>&1 | tail -20'), 'npm test'); // パイプは先頭を見る
  assert.equal(commandInfo('npm test 2>&1 | tail -20').kind, 'test');
  assert.equal(commandHead('git commit -m "fix: a; b && c"'), 'git commit'); // 引用符の中では分けない
});

test('commandHead: 引用符つきの引数と、= @ $ スラッシュ・40 文字の 16 進を含むものを落とす', () => {
  const hex = 'deadbeef'.repeat(5);
  assert.equal(commandHead('node "./scripts/a b.mjs"'), 'node');
  assert.equal(commandHead('npm run "weird name"'), 'npm run');
  assert.equal(commandHead('git log --author=a@b.example'), 'git log');
  assert.equal(commandHead('git checkout feature/secret-branch'), 'git checkout');
  assert.equal(commandHead(`git show ${hex}`), 'git show');
  assert.equal(commandHead(`npm run ${hex}`), 'npm run');
  assert.equal(commandHead('docker run -e KEY=$SECRET image'), 'docker run');
  assert.equal(commandHead('npm install @scope/pkg'), 'npm install');
  assert.equal(commandHead('cat ~/.ssh/id_rsa'), 'cat'); // 走らせるプログラム以外は単語も出さない
  assert.equal(commandHead('curl -H "Authorization: Bearer sk-ant-api03-xxxxxxxx" https://api.example.com'), 'curl');
  assert.equal(commandHead('$SECRET_TOOL --run'), ''); // プログラムが検査に通らなければ全体を無しに
  assert.equal(commandHead('"weird"name" x'), '');
  assert.equal(commandHead('python3 -c "import os; print(os.environ)"'), 'python3');
  assert.equal(commandInfo(undefined).target, '');
  assert.equal(commandInfo('').target, '');
  assert.equal(commandInfo(42).kind, 'run');
  const target = commandHead('npm run a-very-long-script-name-xx extra');
  assert.ok(Array.from(target).length <= CAP.ACT_TARGET);
});

test('finishActivity: 返事待ちと片付けには付けない。live は作業中のカードだけ', () => {
  const f = { kind: /** @type {const} */ ('edit'), target: 'x.mjs', step: 'one', at: NOW };
  assert.equal(finishActivity(f, 'needs_you', 0), undefined);
  assert.equal(finishActivity(f, 'cleanup', 3), undefined);
  assert.deepEqual(finishActivity(f, 'working', 0), { kind: 'edit', target: 'x.mjs', step: 'one', live: true, at: NOW });
  assert.deepEqual(finishActivity(f, 'trouble', 0), { kind: 'edit', target: 'x.mjs', step: 'one', live: false, at: NOW });
  assert.equal(finishActivity(f, 'unread', 0)?.live, false);
  assert.equal(finishActivity(f, 'recent', 0)?.live, false);
  assert.equal(finishActivity(null, 'working', 0), undefined);
});

test('finishActivity: 作業中で subLive ≥ 1 なら agents と n (target と note を外し、step は残す)', () => {
  const f = { kind: /** @type {const} */ ('run'), target: 'npm test', note: 'Run tests', step: 'two' };
  assert.deepEqual(finishActivity(f, 'working', 3), { kind: 'agents', n: 3, step: 'two', live: true });
  assert.equal(finishActivity(f, 'working', SUBAGENT_SCAN_MAX + 5)?.n, SUBAGENT_SCAN_MAX);
  assert.deepEqual(finishActivity(null, 'working', 2), { kind: 'agents', n: 2, live: true }); // バックグラウンドで動いている
  assert.equal(finishActivity(f, 'trouble', 3)?.kind, 'run'); // 作業中でなければ変えない
  assert.equal(finishActivity(f, 'working', Number.NaN)?.kind, 'run');
});

test('activity: ファイル名の target も cleanText の規則 (UUID は …・鍵の形とメールは •••・見えない文字は消す、拡張子は残す)', () => {
  const key = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');
  const sk = ['sk', '-', 'abcdefghijklmnopqrstuvwxyz0123'].join('');
  assert.equal(one('Read', { file_path: '/home/tester/.claude/projects/p/00000000-0000-4000-8000-000000000000.jsonl' })?.target, '….jsonl');
  assert.equal(one('Read', { file_path: `/tmp/${key}.txt` })?.target, '•••.txt');
  assert.equal(one('NotebookEdit', { notebook_path: `${sk}.ipynb` })?.target, '•••.ipynb');
  assert.equal(one('Read', { file_path: '/tmp/jane.doe@example.com.vcf' })?.target, '•••');
  // 双方向の上書き・分離・幅ゼロ・ソフトハイフンは消す (拡張子を見せかけない、辞書の言葉の向きを変えない)
  assert.equal(one('Edit', { file_path: 'C:/work/synth/invoice\u202Etxt.exe' })?.target, 'invoicetxt.exe');
  assert.equal(one('Edit', { file_path: '/x/report\u2067gpj.exe' })?.target, 'reportgpj.exe');
  assert.equal(one('Write', { file_path: '/x/a\u200bb\u00adc.txt' })?.target, 'abc.txt');
  assert.equal(one('Edit', { file_path: '/x/2026-10-18-release-notes.md' })?.target, '2026-10-18-release-notes.md', '日付つきの名前は秘密ではない');
});

test('activity: WebFetch のホストは中身の分からない ID のラベルより後ろだけ、CAP.ACT_TARGET まで', () => {
  const host = (/** @type {string} */ url) => one('WebFetch', { url })?.target;
  assert.equal(host('https://00000000-0000-4000-8000-00000000004e.ngrok-free.app/admin'), 'ngrok-free.app');
  assert.equal(host('https://abcd1234efgh5678.supabase.co/rest'), 'supabase.co');
  assert.equal(host('https://tok3n-abcdef0123456789abcdef.example.com/'), 'example.com');
  assert.equal(host('https://my-service-abc123xyz-uc.a.run.app/'), 'run.app', '長いホストは最後の 2 つのラベル');
  assert.equal(host('http://localhost:3000/x'), 'localhost');
  assert.equal(host('https://deadbeefcafe.app/'), undefined, 'ID を外して 1 つしか残らなければ出さない');
  for (const u of ['https://00000000-0000-4000-8000-00000000004e.ngrok-free.app/', `https://${'a'.repeat(40)}.example.com/`]) {
    assert.ok(Array.from(host(u) ?? '').length <= CAP.ACT_TARGET, u);
  }
});

test('commandHead: sudo と env のフラグの値はプログラムにしない。知らないフラグなら target は無し', () => {
  assert.deepEqual(commandInfo('sudo -u jdoe cat /etc/shadow'), { kind: 'run', target: 'cat' });
  assert.equal(commandHead('env -u AWS_SECRET_ACCESS_KEY node x.js'), 'node');
  assert.equal(commandHead('env -C /srv/acme-secret node'), 'node');
  assert.equal(commandHead('sudo -g acmeadmins ls'), 'ls');
  assert.equal(commandHead('sudo -u postgres psql'), 'psql');
  assert.equal(commandHead('sudo --user=jdoe ls'), 'ls');
  assert.equal(commandHead('sudo -E npm test'), 'npm test');
  assert.equal(commandHead('sudo -- npm test'), 'npm test');
  assert.deepEqual(commandInfo('sudo -Eu jdoe ls'), { kind: 'run', target: '' }, 'まとめた短いフラグは値を取るか分からない');
  assert.deepEqual(commandInfo('sudo --made-up x ls'), { kind: 'run', target: '' });
});
