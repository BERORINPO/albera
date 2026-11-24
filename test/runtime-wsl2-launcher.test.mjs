import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The WSL2 job launcher (ADR-012). It is Linux x86-64 C, so the tests that run it need gcc on such a machine: CI's ubuntu runners have both.
// The file tests run everywhere.

const SOURCE = path.resolve('src/runtime/wsl2-guest/launcher.c');
const ENTER = path.resolve('src/runtime/wsl2-guest/enter.sh');
const SANDBOX_ROOT = path.resolve('src/runtime/wsl2-guest/sandbox-root.sh');
const hasCompiler = process.platform === 'linux' && process.arch === 'x64' && spawnSync('gcc', ['--version']).status === 0;
const isRoot = process.getuid?.() === 0;
const skip = !hasCompiler || isRoot ? 'needs gcc on Linux x86-64, as a non-root user' : false;

function build(flags = ['-DALBERA_TEST_BUILD']) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'albera-launcher-'));
  const out = path.join(dir, 'launcher');
  const compiled = spawnSync('gcc', ['-O2', '-static', '-Wall', '-Wextra', '-Werror', ...flags, '-o', out, SOURCE], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  return { out, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the launcher starts the program when every self-test call is refused', { skip }, () => {
  const { out, done } = build();
  try {
    const run = spawnSync(out, ['/bin/sh', '-c', 'grep "^Seccomp:" /proc/self/status'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Seccomp:\s+2/u);
  } finally { done(); }
});

// 4 (clone unchecked) is left to the real-sandbox run: an ubuntu runner may refuse user namespaces with no filter at all, so it cannot tell there.
for (const [hole, line] of [[1, /socket AF_VSOCK/u], [2, /32-bit gate/u], [5, /io_uring_setup/u], [6, /core soft limit, setrlimit/u]]) {
  test(`a filter with hole ${hole} stops the run at the self-test`, { skip }, () => {
    const { out, done } = build(['-DALBERA_TEST_BUILD', `-DALBERA_BROKEN=${hole}`]);
    try {
      const run = spawnSync(out, ['/bin/true'], { encoding: 'utf8' });
      assert.equal(run.status, 93, run.stderr);
      assert.match(run.stderr, line);
    } finally { done(); }
  });
}

test('the real build refuses to start outside the sandbox', { skip }, () => {
  const { out, done } = build([]);
  try {
    const run = spawnSync(out, ['/bin/true'], { encoding: 'utf8' });
    assert.equal(run.status, 96, run.stderr);
  } finally { done(); }
});

test('a job cannot raise the core limit, so a crash is not piped out', { skip }, () => {
  const { out, done } = build();
  try {
    const run = spawnSync(out, ['/bin/sh', '-c', 'grep "core file" /proc/self/limits'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /core file size\s+1\s+1\s+bytes/u);
  } finally { done(); }
});

test('under the filter, git can work and a namespace cannot be made', { skip }, () => {
  const { out, done } = build();
  try {
    const script = 'cd "$(mktemp -d)" && git init -q . && git -c user.name=j -c user.email=j@example.invalid commit -q --allow-empty -m x && git bundle create -q b.bundle --all && git bundle verify -q b.bundle && echo bundled; unshare -U true; echo "unshare=$?"';
    const run = spawnSync(out, ['/bin/sh', '-c', script], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /bundled/u);
    assert.doesNotMatch(run.stdout, /unshare=0/u);
  } finally { done(); }
});

test('the launcher needs an absolute program and closes what it inherited', { skip }, () => {
  const { out, done } = build();
  try {
    assert.equal(spawnSync(out, ['true']).status, 90);
    const run = spawnSync(out, ['/bin/sh', '-c', 'ls /proc/self/fd'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
    assert.equal(run.status, 0, run.stderr);
    const open = run.stdout.split('\n').filter(Boolean).map(Number);
    assert.ok(!open.includes(4), `inherited descriptor still open: ${open.join(',')}`);
  } finally { done(); }
});

test('the filter denies by default and enter.sh drops every capability', () => {
  const source = readFileSync(SOURCE, 'utf8');
  const enter = readFileSync(ENTER, 'utf8');
  const sandboxRoot = readFileSync(SANDBOX_ROOT, 'utf8');
  assert.match(source, /#if ALBERA_BROKEN == 5\n {2}RETURN\(SECCOMP_RET_ALLOW\);\n#else\n {2}RETURN\(DENY\);\n#endif\n\}/u);
  for (const name of ['SYS_ptrace', 'SYS_mount', 'SYS_unshare', 'SYS_setns', 'SYS_bpf', 'SYS_keyctl', 'SYS_io_uring_setup', 'SYS_userfaultfd', 'SYS_process_vm_readv']) {
    const allowed = source.slice(source.indexOf('ALLOWED[]'), source.indexOf('static struct sock_filter'));
    assert.ok(!allowed.includes(name), name);
  }
  assert.match(sandboxRoot, /--bounding-set=-all --inh-caps=-all/u);
  assert.match(enter, /--net --mount --pid --ipc --uts --cgroup/u);
  assert.match(sandboxRoot, /albera-launcher "\$program"/u);
  assert.match(enter, /memory\.max/u);
  assert.match(enter, /pids\.max/u);
  for (const script of [enter, sandboxRoot]) assert.doesNotMatch(script, /\|\| true/u);
});
