// ADR-012 gates, on the real image and the real sandbox, from the Windows side. A measuring tool, not part of `npm test`: it imports a throwaway
// distribution and needs WSL. It uses no token and no network. It never runs a job without the seccomp filter, so it does not touch AF_VSOCK.
//
// Usage: node scripts/wsl2-gates.mjs <image .tar> <empty folder for the distribution> [a Windows .exe to try from the sandbox]
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIST = 'albera-gate';
const [image, folder, windowsProgram = 'C:\\Windows\\System32\\PING.EXE'] = process.argv.slice(2);
if (!image || !folder) { console.error('usage: wsl2-gates.mjs <image .tar> <folder> [exe]'); process.exit(2); }

const env = { ...process.env, WSL_UTF8: '1' };
const wsl = (...args) => spawnSync('wsl.exe', args, { encoding: 'utf8', env });
/** A script through stdin: wsl.exe hands its arguments to a shell again, so quoting does not survive there. */
const script = (user, text) => spawnSync('wsl.exe', ['-d', DIST, '-u', user, '--cd', '/', '--', '/bin/bash', '-s'], { encoding: 'utf8', env, input: text });
const results = [];
function record(gate, pass, detail) {
  results.push({ gate, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${gate}: ${String(detail).trim().replace(/\s*\n\s*/gu, ' | ').slice(0, 600)}`);
}

const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const frame = (op, ...parts) => { const body = Buffer.concat([Buffer.from([op]), ...parts]); return Buffer.concat([u32(body.length), body]); };

/** One sandbox, one agent. Each call waits for its response. */
function openSandbox() {
  const child = spawn('wsl.exe', ['-d', DIST, '-u', 'root', '--cd', '/', '--', '/bin/bash', '/opt/albera/enter.sh', 'albera-agent'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = Buffer.alloc(0);
  let waiting = null;
  let stderr = '';
  const closed = new Promise((resolve) => { child.on('close', (code) => { if (waiting) { waiting(null); waiting = null; } resolve(code); }); });
  child.stdin.on('error', () => {});
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    if (waiting && pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
      const size = pending.readUInt32BE(0);
      const body = pending.subarray(4, 4 + size);
      pending = pending.subarray(4 + size);
      const done = waiting;
      waiting = null;
      done({ status: body[0], body: body.subarray(1) });
    }
  });
  const call = (bytes) => new Promise((resolve) => { waiting = resolve; child.stdin.write(bytes); });
  return {
    async run(command, seconds = 30) {
      const response = await call(frame(1, u32(seconds), Buffer.from(command)));
      if (!response) return null;
      return { exit: response.body.readInt32BE(0), flags: response.body[4], output: response.body.subarray(5).toString() };
    },
    write: (name, data) => call(frame(3, u32(Buffer.byteLength(name)), Buffer.from(name), data)),
    bundle: (name) => call(frame(4, u32(120), Buffer.from(name))),
    async close() { child.stdin.end(); return closed; },
    closed,
    stderr: () => stderr,
  };
}

async function inSandbox(work) {
  const sandbox = openSandbox();
  try { return await work(sandbox); } finally { await sandbox.close(); }
}

const VSOCK = `perl -e '
  my $s = syscall(41, 40, 1, 0); print "socket=$s err=", $!+0, "\\n";
  my $p = pack("ii", 0, 0); my $r = syscall(53, 40, 1, 0, $p); print "socketpair=$r err=", $!+0, "\\n";'`;
const MOUNTS = `perl -e '
  for my $t (["C:\\0","/tmp\\0","drvfs\\0"], ["C:\\0","/tmp\\0","9p\\0"], ["none\\0","/tmp\\0","tmpfs\\0"]) {
    my $r = syscall(165, $t->[0], $t->[1], $t->[2], 0, 0); print "mount=$r err=", $!+0, "\\n"; }'`;

async function gateVisibility() {
  await inSandbox(async (box) => {
    const who = await box.run('id -u; grep -E "^(CapEff|CapBnd|NoNewPrivs|Seccomp):" /proc/self/status');
    record('G4 identity', /^1000\n/u.test(who.output) && /CapEff:\s+0{16}/u.test(who.output) && /CapBnd:\s+0{16}/u.test(who.output) && /Seccomp:\s+2/u.test(who.output), who.output);
    const root = await box.run('ls -a / | tr "\\n" " "; echo; ls -a /dev | tr "\\n" " "');
    record('G4 root and /dev', !/\b(mnt|init|run)\b/u.test(root.output) && !/dxg/u.test(root.output), root.output);
    const fds = await box.run('ls -l /proc/1/fd');
    const agentFds = [0, 1, 2].every((fd) => new RegExp(`\\b${fd} -> pipe:`, 'u').test(fds.output));
    record('G4 the agent holds pipes and no socket', agentFds && !/socket:|anon_inode/u.test(fds.output), fds.output);
    const wslg = await box.run('ls /mnt/wslg /dev/dxg /run/WSL /init 2>&1 | grep -vc "No such file"; true');
    record('G4 WSL paths absent', wslg.output.trim() === '0', wslg.output);
  });
}

async function gateNetworkAndVsock() {
  await inSandbox(async (box) => {
    const vsock = await box.run(VSOCK);
    record('G2 AF_VSOCK under the real filter', (vsock.output.match(/=-1 err=1\b/gu) ?? []).length === 2, vsock.output);
    const tcp = await box.run('for t in 1.1.1.1/443 192.168.1.1/80 127.0.0.1/1; do (timeout 3 bash -c "exec 3<>/dev/tcp/$t" 2>/dev/null && echo "$t open") || echo "$t closed"; done; cat /proc/net/dev | awk "NR>2{print \\$1}" | tr "\\n" " "');
    record('G5 TCP and interfaces', !/ open/u.test(tcp.output) && /lo:/u.test(tcp.output) && !/eth/u.test(tcp.output), tcp.output);
    const udp = await box.run(`perl -e 'use Socket; socket(my $s,PF_INET,SOCK_DGRAM,0) or die "socket: $!"; my $r=send($s,"x",0,pack_sockaddr_in(53,inet_aton("1.1.1.1"))); print defined $r ? "sent\\n" : "unsent: $!\\n";' 2>&1`);
    record('G5 UDP', /unsent/u.test(udp.output), udp.output);
    const mounts = await box.run(MOUNTS);
    // A plain user gets EPERM from mount(2) with no filter at all, so this shows the result and not who refused.
    record('G0 mount(2) as the job fails', (mounts.output.match(/mount=-1 err=1\b/gu) ?? []).length === 3, mounts.output);
    const userns = await box.run('unshare -Ur id -u 2>&1 | head -1');
    record('G0 user namespace refused', /Operation not permitted/u.test(userns.output), userns.output);
  });
}

const windowsProcessSeen = (name) => spawnSync('tasklist.exe', ['/FI', `IMAGENAME eq ${name}`, '/NH'], { encoding: 'utf8' }).stdout.includes(name);
async function watchWindows(name, seconds, action) {
  let seen = 0;
  const timer = setInterval(() => { if (windowsProcessSeen(name)) seen += 1; }, 400);
  await action();
  await new Promise((resolve) => { setTimeout(resolve, seconds * 1000); });
  clearInterval(timer);
  return seen;
}

async function gateWindowsProgram() {
  const name = 'albera-g3.exe';
  const onC = path.join(os.tmpdir(), name);
  copyFileSync(windowsProgram, onC);
  const linuxPath = wsl('-d', 'Ubuntu', '--', 'wslpath', '-a', onC.replaceAll('\\', '/')).stdout.trim().split('\n').pop();
  const control = await watchWindows(name, 5, async () => {
    spawn('wsl.exe', ['-d', 'Ubuntu', '--cd', path.posix.dirname(linuxPath), '--', linuxPath, '-n', '6', '127.0.0.1'], { env, stdio: 'ignore' });
  });
  record('G3 control: a plain distribution with interop starts it', control > 0, `seen in ${control} polls`);
  await inSandbox(async (box) => {
    await box.write(name, readFileSync(onC));
    const seen = await watchWindows(name, 2, async () => { await box.run(`chmod +x ${name}; timeout 6 ./${name} -n 6 127.0.0.1; echo exit=$?`, 10); });
    // Weak by nature: a Windows program starts only from C:, and the sandbox has no C:, so this file is not where the control's file is.
    record('G3 a Windows program copied into the sandbox does not run', seen === 0, `seen in ${seen} polls`);
  });
}

const crashDumps = () => { const dir = path.join(os.tmpdir(), 'wsl-crashes'); return existsSync(dir) ? readdirSync(dir).length : 0; };
async function gateCrash() {
  const before = crashDumps();
  await inSandbox(async (box) => {
    await box.run('ulimit -c unlimited 2>/dev/null; bash -c "kill -SEGV \\$\\$"; true');
    await box.run('perl -e "kill SEGV => \\$\\$"; true');
    // The route Zaku found: the kernel skips a piped dump only at a soft limit of exactly 1, so lower it. Both calls, then crash anyway.
    const lowered = await box.run(`perl -e '
      my $l = pack("QQ", 0, 1);
      my $a = syscall(160, 4, $l); print "setrlimit=$a err=", $!+0, "\\n";
      my $b = syscall(302, 0, 4, $l, 0); print "prlimit64=$b err=", $!+0, "\\n";'
      ulimit -Sc 0; echo ulimit=$?; grep "core file" /proc/self/limits; bash -c 'ulimit -Sc 0; kill -SEGV $$'; true`);
    const refused = (lowered.output.match(/=-1 err=1\b/gu) ?? []).length === 2 && /ulimit=1/u.test(lowered.output) && /core file size\s+1\s+1\s/u.test(lowered.output);
    record('R8 the core limit cannot be lowered', refused, lowered.output);
  });
  await new Promise((resolve) => { setTimeout(resolve, 3000); });
  const after = crashDumps();
  record('R8 crashes in the sandbox add no dump, with the limit attacked', after === before, `${before} -> ${after}`);
  script('job', 'ulimit -c unlimited\nbash -c \'kill -SEGV $$\'\n');
  await new Promise((resolve) => { setTimeout(resolve, 3000); });
  const control = crashDumps();
  record('R8 control, after the sandbox: a plain job still dumps', control > after, `${after} -> ${control}`);
}

async function gateLimits() {
  await inSandbox(async (box) => {
    const disk = await box.run('dd if=/dev/zero of=/work/fill bs=1M count=3000 2>&1 | tail -1; du -sm /work | cut -f1; rm -f /work/fill', 120);
    record('G6 /work stops at its size', /No space left/u.test(disk.output) || Number(disk.output.trim().split('\n').pop()) <= 2048, disk.output);
    const pids = await box.run(`perl -e 'my $n = 0; while (1) { my $p = fork(); if (!defined $p) { print "forked=$n err=", $!+0, "\\n"; last } if (!$p) { sleep 20; exit } $n++ } kill "KILL", -$$'; true`, 60);
    const forked = Number(pids?.output.match(/forked=(\d+) err=11/u)?.[1] ?? 9999);
    record('G6 the process limit holds', forked <= 1024, pids?.output);
    const events = counters();
    record('G6 pids.events counted it', /pids\.events: max [1-9]/u.test(events), events);
    const gone = await box.run('ls /proc | grep -c "^[0-9]"');
    record('G6 nothing outlives a run', Number(gone.output.trim()) <= 6, gone.output);
  });
  const box = openSandbox();
  const memory = await box.run(`perl -e '$x = "a" x (6 * 1024**3); print "allocated\\n"' 2>&1; echo exit=$?`, 60);
  const events = counters();
  const limit = Number(events.match(/memory\.max: (\d+)/u)?.[1] ?? 0);
  const total = Number(events.match(/MemTotal:\s+(\d+) kB/u)?.[1] ?? 0) * 1024;
  const code = await box.close();
  record('G6 memory stops at the limit', !/^allocated/mu.test(memory?.output ?? ''), `${memory ? memory.output : 'the run ended'} (agent exit ${code})`);
  record('G6 memory.events counted it', /oom_kill [1-9]/u.test(events), events);
  record('G6 memory.max is below the VM memory', limit > 0 && limit < total, `${limit} of ${total}`);
}

/** The run's cgroup, read as root from outside the sandbox while the run is open. */
function counters() {
  return script('root', 'for g in /sys/fs/cgroup/albera-run-*; do\n  echo "pids.events: $(cat $g/pids.events)"\n  echo "memory.max: $(cat $g/memory.max)"\n  cat $g/memory.events\ndone\ngrep MemTotal /proc/meminfo\n').stdout;
}

async function gatePlanted() {
  await inSandbox(async (box) => {
    const plant = `git init -q repo && cd repo && git -c user.name=j -c user.email=j@e commit -q --allow-empty -m one
      printf '#!/bin/sh\\nid -u > /work/hook-ran\\n' > .git/hooks/pre-commit; chmod +x .git/hooks/pre-commit
      git config core.fsmonitor '/bin/sh -c "id -u > /work/fsmonitor-ran"'
      ln -s /etc/passwd link; echo planted`;
    await box.run(plant);
    const bundle = await box.bundle('repo');
    const check = await box.run('cat /work/hook-ran /work/fsmonitor-ran 2>/dev/null | sort -u; echo end');
    // Not G7: there is no root in the sandbox and no root relay yet, so nothing here could have run as root. G7 waits for the bridge.
    record('A bundle of a repository with planted config works', bundle.status === 0, `bundle status ${bundle.status}, uids: ${check.output}`);
    const started = Date.now();
    const data = randomBytes(50 * 1024 * 1024);
    await box.write('big', data);
    const hash = await box.run('sha256sum big | cut -d" " -f1');
    record('G0 50 MB through the real pipe', hash.output.trim() === createHash('sha256').update(data).digest('hex'), `${hash.output} in ${Date.now() - started} ms`);
  });
}

function reportHelpers() {
  const read = script('root', 'for f in /proc/sys/kernel/core_pattern /proc/sys/kernel/modprobe /proc/sys/kernel/hotplug /proc/sys/kernel/poweroff_cmd; do echo "$f=$(cat $f 2>&1)"; done\nls /proc/sys/fs/binfmt_misc 2>&1 | tr "\\n" " "\ncat /proc/sys/fs/binfmt_misc/WSLInterop 2>&1 | head -4\n');
  console.log(`INFO kernel-side helpers: ${read.stdout.trim().replace(/\n/gu, ' | ')}`);
  const shipped = script('root', 'grep -alr ALBERA-NOT-FOR-SHIPPING /opt/albera | wc -l\n');
  record('No test build in the image', shipped.stdout.trim() === '0', shipped.stdout);
}

const started = Date.now();
const imported = wsl('--import', DIST, folder, image, '--version', '2');
if (imported.status !== 0) { console.error(imported.stdout, imported.stderr); process.exit(1); }
console.log(`INFO import ${Date.now() - started} ms`);
try {
  const first = Date.now();
  await inSandbox(async (box) => {
    const hello = await box.run('echo hello');
    record('Start: the agent answers in the real sandbox', hello?.output.trim() === 'hello', hello ? `${Date.now() - first} ms` : `no answer: ${box.stderr()}`);
    if (!hello) process.exitCode = 1;
  });
  if (!process.exitCode) {
    for (const gate of [gateVisibility, gateNetworkAndVsock, gateWindowsProgram, gatePlanted, gateCrash, gateLimits]) await gate();
    reportHelpers();
  }
} finally {
  wsl('--unregister', DIST);
  console.log(`INFO unregistered ${DIST}`);
}
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length} of ${results.length} passed`);
if (failed.length) process.exitCode = 1;
