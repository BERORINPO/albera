import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProjectResolver, folderName, folderSegment, normRoots, repoMajority } from '../src/core/project.mjs';
import { ROOTS, rec, sid } from './helpers/fixtures.mjs';

const roots = normRoots(ROOTS);
/** 手掛かり (adapter が付ける folders) を足した SessionRecord。 @param {ReturnType<typeof rec>} s @param {any} folders */
const withHints = (s, folders) => ({ ...s, folders });
/** @param {ReturnType<typeof rec>[]} list */
const resolverOf = (list, r = ROOTS) => createProjectResolver({ roots: r, byId: new Map(list.map((s) => [s.sessionId, s])) });

test('root の下なら root 直下の最初のフォルダ名', () => {
  assert.equal(folderSegment('C:\\work\\alpha\\src\\deep', roots), 'alpha');
  assert.equal(folderSegment('c:/WORK/Alpha/', roots), 'Alpha');
  assert.equal(folderSegment('D:\\code\\beta', roots), 'beta');
  assert.equal(folderSegment('/home/tester/gamma/src', roots), 'gamma');
});

test('worktree (.claude/worktrees/) はその手前で切る (区切りは \\ でも / でも)', () => {
  assert.equal(folderSegment('C:\\work\\alpha\\.claude\\worktrees\\brave-x-1a2b3c', roots), 'alpha');
  assert.equal(folderSegment('E:\\elsewhere\\gamma\\.claude\\worktrees\\w1', roots), 'gamma');
  assert.equal(folderSegment('/srv/repos/delta/.claude/worktrees/w2', roots), 'delta');
});

test('ドライブ直下・root そのもの・空は null', () => {
  assert.equal(folderSegment('C:\\', roots), null);
  assert.equal(folderSegment('C:\\work', roots), null);
  assert.equal(folderSegment('/home/tester/', roots), null);
  assert.equal(folderSegment('/', roots), null);
  assert.equal(folderSegment('', roots), null);
  assert.equal(folderSegment(undefined, roots), null);
});

test('どの root の下でもなければ最後のフォルダ名', () => {
  assert.equal(folderSegment('E:\\somewhere\\delta', roots), 'delta');
  assert.equal(folderSegment('/opt/stuff/epsilon', roots), 'epsilon');
});

test('folder hint: repo ならその名前、container ならこのパスでは決めない、無ければ roots の規則', () => {
  assert.equal(folderName('/home/tester/x/deep/inside', { kind: 'repo', name: 'real-repo' }, roots), 'real-repo');
  assert.equal(folderName('/home/tester', { kind: 'container' }, roots), null);
  assert.equal(folderName('/home/tester/projects', { kind: 'container' }, roots), null);
  assert.equal(folderName('/home/tester/plain', undefined, roots), 'plain');
  // 名前の空な repo hint は手掛かりなし扱い
  assert.equal(folderName('/home/tester/plain', { kind: 'repo', name: ' ' }, roots), 'plain');
});

test('folder hint: repo の名前は roots より優先する (root 直下でなく深い場所の repo でも、その repo 名)', () => {
  const s = withHints(rec(1, { originCwd: '/home/tester/clients/acme-site/web', cwd: '/home/tester/clients/acme-site/web' }), {
    origin: { kind: 'repo', name: 'acme-site' },
    cwd: { kind: 'repo', name: 'acme-site' },
  });
  const r = resolverOf([s])(s);
  assert.deepEqual([r.key, r.name, r.how], ['acme-site', 'acme-site', 'folder']);
  // hint が無ければ今までどおり root 直下のフォルダ名
  const plain = rec(2, { originCwd: '/home/tester/clients/acme-site/web', cwd: '/home/tester/clients/acme-site/web' });
  assert.equal(resolverOf([plain])(plain).name, 'clients');
});

test('folder hint: originCwd が container なら cwd を見る、両方 container なら PR → 親 → フォルダなし', () => {
  const container = { kind: 'container' };
  const toCwd = withHints(rec(1, { originCwd: '/home/tester/projects', cwd: '/home/tester/projects/zeta' }), {
    origin: container,
    cwd: { kind: 'repo', name: 'zeta' },
  });
  assert.deepEqual([resolverOf([toCwd])(toCwd).name, resolverOf([toCwd])(toCwd).how], ['zeta', 'folder']);
  // root の規則なら 'projects' になってしまう場所でも、container なら決めない
  const both = { origin: container, cwd: container };
  const viaPr = withHints(rec(2, { originCwd: '/home/tester/projects', cwd: '/home/tester/projects', prs: [{ prNumber: 1, repo: 'org/eta' }] }), both);
  assert.deepEqual([resolverOf([viaPr])(viaPr).name, resolverOf([viaPr])(viaPr).how], ['eta', 'pr']);
  const parent = rec(3, { originCwd: 'C:\\work\\theta', cwd: 'C:\\work\\theta' });
  const viaParent = withHints(rec(4, { originCwd: '/home/tester/projects', cwd: '/home/tester/projects', spawnedFrom: { sessionId: sid(3) } }), both);
  assert.deepEqual([resolverOf([parent, viaParent])(viaParent).name, resolverOf([parent, viaParent])(viaParent).how], ['theta', 'parent']);
  const none = withHints(rec(5, { originCwd: '/home/tester/projects', cwd: '/home/tester/projects' }), both);
  const r = resolverOf([none])(none);
  assert.deepEqual([r.key, r.name, r.how], ['(other)', '', 'other']);
});

test('folder hint: 片方だけ hint があれば、無い方は roots の規則で見る', () => {
  const s = withHints(rec(1, { originCwd: '/home/tester', cwd: '/home/tester/iota/sub' }), { origin: { kind: 'container' } });
  assert.equal(resolverOf([s])(s).name, 'iota');
});

test('既定の roots が home だけでも、home 直下のフォルダ名になる (所有者固有のドライブを前提にしない)', () => {
  const s = rec(1, { originCwd: '/home/someone/kappa/src', cwd: '/home/someone/kappa/src' });
  assert.equal(resolverOf([s], ['/home/someone'])(s).name, 'kappa');
  const win = rec(2, { originCwd: 'C:\\Users\\someone\\lambda', cwd: 'C:\\Users\\someone\\lambda' });
  assert.equal(resolverOf([win], ['C:\\Users\\someone'])(win).name, 'lambda');
});

test('PR の repo の多数決 (同数なら先頭の PR の repo、他の repo は +N)', () => {
  const tie = rec(1, { prs: [{ prNumber: 1, repo: 'o/first', state: 'OPEN' }, { prNumber: 2, repo: 'o/second', state: 'OPEN' }] });
  assert.deepEqual(repoMajority(tie), { name: 'first', extra: 1 });
  // 4 つの repo が 1 件ずつ (アプリの主 PR は先頭) → 先頭の repo
  const four = rec(1, { prs: ['main-repo', 'b', 'c', 'last'].map((r, i) => ({ prNumber: i + 1, repo: 'o/' + r, state: 'MERGED' })) });
  assert.deepEqual(repoMajority(four), { name: 'main-repo', extra: 3 });
  // prs が無ければ旧形式の prRepository
  assert.deepEqual(repoMajority(rec(1, { prRepository: 'o/legacy' })), { name: 'legacy', extra: 0 });
  const major = rec(1, { prs: [{ prNumber: 1, repo: 'o/a' }, { prNumber: 2, repo: 'o/b' }, { prNumber: 3, repo: 'o/a' }], prRepository: 'o/a' });
  assert.deepEqual(repoMajority(major), { name: 'a', extra: 1 });
  assert.equal(repoMajority(rec(1)), null);
});

test('決める順: フォルダ (originCwd 優先) → PR → 親 → フォルダなし (名前は空)', () => {
  const parent = rec(1, { originCwd: 'C:\\work\\parentproj', cwd: 'C:\\work\\parentproj' });
  const viaOrigin = rec(2, { originCwd: 'C:\\work\\origin', cwd: 'C:\\work\\other' });
  const viaPr = rec(3, { originCwd: 'C:\\work', cwd: 'C:\\work', prs: [{ prNumber: 1, repo: 'org/Repo-X' }] });
  const viaParent = rec(4, { originCwd: 'C:\\work', cwd: 'C:\\work', spawnedFrom: { sessionId: sid(1) } });
  const none = rec(5, { originCwd: 'C:\\work', cwd: 'C:\\work' });
  const resolve = resolverOf([parent, viaOrigin, viaPr, viaParent, none]);
  assert.deepEqual([resolve(viaOrigin).name, resolve(viaOrigin).how], ['origin', 'folder']);
  assert.deepEqual([resolve(viaPr).key, resolve(viaPr).name, resolve(viaPr).how], ['repo-x', 'Repo-X', 'pr']);
  assert.deepEqual([resolve(viaParent).name, resolve(viaParent).how], ['parentproj', 'parent']);
  assert.deepEqual([resolve(none).key, resolve(none).name, resolve(none).how], ['(other)', '', 'other']);
});

test('親から継承するとき +N (自分の PR の数) は引き継がない', () => {
  const parent = rec(1, { originCwd: 'C:/work', cwd: 'C:/work', prs: [{ prNumber: 1, repo: 'o/main' }, { prNumber: 2, repo: 'o/other' }] });
  const child = rec(2, { originCwd: 'C:/work', cwd: 'C:/work', spawnedFrom: { sessionId: sid(1) } });
  const resolve = resolverOf([parent, child]);
  assert.deepEqual([resolve(parent).name, resolve(parent).extra], ['main', 1]);
  assert.deepEqual([resolve(child).name, resolve(child).extra, resolve(child).how], ['main', 0, 'parent']);
});

test('プロジェクト名は TITLE の上限で切る (フォルダ名・repo 名・hint の名前とも)', () => {
  const longFolder = rec(1, { originCwd: 'C:/work/' + 'A'.repeat(5000), cwd: '' });
  const longRepo = rec(2, { originCwd: 'C:/work', cwd: 'C:/work', prs: [{ prNumber: 1, repo: 'o/' + 'r'.repeat(5000) }] });
  const longHint = withHints(rec(3, { originCwd: '/x', cwd: '/x' }), { origin: { kind: 'repo', name: 'h'.repeat(5000) } });
  const resolve = createProjectResolver({ roots: ROOTS, byId: new Map() });
  assert.equal(Array.from(resolve(longFolder).name).length, 200);
  assert.equal(Array.from(resolve(longRepo).name).length, 200);
  assert.equal(Array.from(resolve(longHint).name).length, 200);
  assert.ok(Array.from(resolve(longFolder).key).length <= 200);
});

test('親の循環と深さ 5 で止まる', () => {
  const a = rec(1, { originCwd: 'C:\\work', cwd: 'C:\\work', spawnedFrom: { sessionId: sid(2) } });
  const b = rec(2, { originCwd: 'C:\\work', cwd: 'C:\\work', spawnedFrom: { sessionId: sid(1) } });
  assert.equal(resolverOf([a, b])(a).key, '(other)');
  // 7 段の鎖の先にだけフォルダがある → 深さ 5 を超えるので届かない
  const chain = Array.from({ length: 8 }, (_, i) =>
    rec(10 + i, i === 7 ? { originCwd: 'C:\\work\\far', cwd: 'C:\\work\\far' } : { originCwd: 'C:\\work', cwd: 'C:\\work', spawnedFrom: { sessionId: sid(11 + i) } }),
  );
  const deep = resolverOf(chain);
  assert.equal(deep(chain[0]).key, '(other)');
  assert.equal(deep(chain[3]).key, 'far');
});
