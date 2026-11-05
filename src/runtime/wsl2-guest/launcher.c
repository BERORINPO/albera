// The last step into a WSL2 job (docs/architecture/decisions/ADR-012-wsl2-provider.md, decisions 8 and "Proof on every run").
// It runs as the job user, after enter.sh has built the namespaces and dropped every capability. It closes inherited descriptors, loads
// the seccomp allowlist, proves that the filter refuses what it must, and only then executes the job's program. Phase 0 measured that this
// filter is the only thing between a job and a file server on the Windows side, so every failure here ends the run: nothing falls back.
//
// Build (static, so the sandbox needs no libraries for it):  gcc -O2 -static -Wall -Wextra -Werror -o albera-launcher launcher.c
// -DALBERA_BROKEN=<n> builds a copy with one hole (1 AF_VSOCK, 2 no architecture check, 4 clone unchecked, 5 allow by default).
// They exist for the acceptance tests: each must stop at the self-test. -DALBERA_TEST_BUILD skips the checks that need the real sandbox, for
// tests on a plain machine. Neither is ever shipped.
//
// Usage: albera-launcher <absolute program> [args...]
// Exit codes: 90 usage, 91 not safe to start (still privileged), 92 filter did not load, 93 a self-test call was not refused,
// 94 a call the job needs was refused, 95 exec failed, 96 this is not the sandbox.

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef ALBERA_BROKEN
#define ALBERA_BROKEN 0
#endif
#ifndef AF_VSOCK
#define AF_VSOCK 40
#endif
#define X32_BIT 0x40000000u
#define DENY (SECCOMP_RET_ERRNO | EPERM)
#define NO_SYS (SECCOMP_RET_ERRNO | ENOSYS)
#define NS_FLAGS 0x7E020080u /* every CLONE_NEW*: NEWNS, NEWCGROUP, NEWUTS, NEWIPC, NEWUSER, NEWPID, NEWNET, and NEWTIME */
#define MAX_FILTER 1024

static const int ALLOWED[] = {
  SYS_read, SYS_write, SYS_open, SYS_openat, SYS_close, SYS_close_range, SYS_stat, SYS_fstat, SYS_lstat, SYS_newfstatat, SYS_statx,
  SYS_poll, SYS_ppoll, SYS_select, SYS_pselect6, SYS_lseek, SYS_mmap, SYS_mprotect, SYS_munmap, SYS_mremap, SYS_msync, SYS_mincore,
  SYS_madvise, SYS_brk, SYS_rt_sigaction, SYS_rt_sigprocmask, SYS_rt_sigreturn, SYS_rt_sigpending, SYS_rt_sigtimedwait,
  SYS_rt_sigsuspend, SYS_sigaltstack, SYS_ioctl, SYS_pread64, SYS_pwrite64, SYS_readv, SYS_writev, SYS_preadv, SYS_pwritev,
  SYS_access, SYS_faccessat, SYS_faccessat2, SYS_pipe, SYS_pipe2, SYS_sched_yield, SYS_sched_getaffinity, SYS_sched_getparam,
  SYS_sched_getscheduler, SYS_sched_get_priority_max, SYS_sched_get_priority_min, SYS_dup, SYS_dup2, SYS_dup3, SYS_pause,
  SYS_nanosleep, SYS_clock_nanosleep, SYS_getitimer, SYS_setitimer, SYS_alarm, SYS_timer_create, SYS_timer_settime, SYS_timer_gettime,
  SYS_timer_getoverrun, SYS_timer_delete, SYS_clock_gettime, SYS_clock_getres, SYS_gettimeofday, SYS_time, SYS_times, SYS_getpid,
  SYS_getppid, SYS_gettid, SYS_getuid, SYS_getgid, SYS_geteuid, SYS_getegid, SYS_getgroups, SYS_getresuid, SYS_getresgid, SYS_getpgid,
  SYS_getpgrp, SYS_setpgid, SYS_setsid, SYS_getsid, SYS_getrlimit, SYS_setrlimit, SYS_prlimit64, SYS_getrusage, SYS_sysinfo, SYS_uname,
  SYS_getpriority, SYS_setpriority, SYS_getcpu, SYS_getrandom, SYS_fork, SYS_vfork, SYS_execve, SYS_execveat, SYS_exit, SYS_exit_group,
  SYS_wait4, SYS_waitid, SYS_kill, SYS_tkill, SYS_tgkill, SYS_fcntl, SYS_flock, SYS_fsync, SYS_fdatasync, SYS_sync_file_range,
  SYS_truncate, SYS_ftruncate, SYS_fallocate, SYS_fadvise64, SYS_getdents, SYS_getdents64, SYS_getcwd, SYS_chdir, SYS_fchdir,
  SYS_rename, SYS_renameat, SYS_renameat2, SYS_mkdir, SYS_mkdirat, SYS_rmdir, SYS_creat, SYS_link, SYS_linkat, SYS_unlink, SYS_unlinkat,
  SYS_symlink, SYS_symlinkat, SYS_readlink, SYS_readlinkat, SYS_chmod, SYS_fchmod, SYS_fchmodat, SYS_chown, SYS_fchown, SYS_lchown,
  SYS_fchownat, SYS_umask, SYS_utime, SYS_utimes, SYS_utimensat, SYS_futimesat, SYS_statfs, SYS_fstatfs, SYS_getxattr, SYS_lgetxattr,
  SYS_fgetxattr, SYS_listxattr, SYS_llistxattr, SYS_flistxattr, SYS_futex, SYS_set_tid_address, SYS_set_robust_list, SYS_get_robust_list,
  SYS_rseq, SYS_membarrier, SYS_arch_prctl, SYS_prctl, SYS_restart_syscall, SYS_epoll_create, SYS_epoll_create1, SYS_epoll_ctl,
  SYS_epoll_wait, SYS_epoll_pwait, SYS_eventfd, SYS_eventfd2, SYS_signalfd, SYS_signalfd4, SYS_timerfd_create, SYS_timerfd_settime,
  SYS_timerfd_gettime, SYS_inotify_init, SYS_inotify_init1, SYS_inotify_add_watch, SYS_inotify_rm_watch, SYS_memfd_create, SYS_sendfile,
  SYS_copy_file_range, SYS_connect, SYS_accept, SYS_accept4, SYS_bind, SYS_listen, SYS_sendto, SYS_recvfrom, SYS_sendmsg, SYS_recvmsg,
  SYS_shutdown, SYS_getsockname, SYS_getpeername, SYS_setsockopt, SYS_getsockopt,
};

static struct sock_filter program[MAX_FILTER];
static unsigned short used = 0;

static void put(struct sock_filter instruction) {
  if (used < MAX_FILTER) program[used] = instruction;
  used++;
}
#define LOAD(offset) put((struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (offset)))
#define RETURN(value) put((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, (value)))
#define IF_EQ_ELSE_SKIP(value, skip) put((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (value), 0, (skip)))
#define IF_EQ_SKIP(value, skip) put((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (value), (skip), 0))
#define IF_BELOW_SKIP(value, skip) put((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, (value), 0, (skip)))
#define IF_SET_SKIP(value, skip) put((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, (value), (skip), 0))
#define ARG0 offsetof(struct seccomp_data, args[0])
#define NR offsetof(struct seccomp_data, nr)

/** socket(2) and socketpair(2): a short list of families. The network namespace is empty, so AF_INET reaches nothing; programs only expect it to exist. */
static void family_rule(int syscall_number) {
#if ALBERA_BROKEN == 1
  IF_EQ_ELSE_SKIP((unsigned)syscall_number, 7);
  LOAD(ARG0);
  IF_EQ_SKIP(AF_VSOCK, 4);
#else
  IF_EQ_ELSE_SKIP((unsigned)syscall_number, 6);
  LOAD(ARG0);
#endif
  IF_EQ_SKIP(AF_UNIX, 3);
  IF_EQ_SKIP(AF_INET, 2);
  IF_EQ_SKIP(AF_INET6, 1);
  RETURN(DENY);
  RETURN(SECCOMP_RET_ALLOW);
}

static void build_filter(void) {
#if ALBERA_BROKEN != 2
  LOAD(offsetof(struct seccomp_data, arch));
  IF_EQ_SKIP(AUDIT_ARCH_X86_64, 1); /* a 32-bit call has another table of numbers, so it is refused before any number is read */
  RETURN(DENY);
#endif
  LOAD(NR);
  IF_BELOW_SKIP(X32_BIT, 1); /* x32 numbers carry this bit. A second line of defence: no number with the bit is on the list, so default deny refuses them too */
  RETURN(DENY);
  family_rule(SYS_socket);
  family_rule(SYS_socketpair);
#if ALBERA_BROKEN == 4
  IF_EQ_ELSE_SKIP(SYS_clone, 1);
  RETURN(SECCOMP_RET_ALLOW);
#else
  IF_EQ_ELSE_SKIP(SYS_clone, 4);  /* clone(2) passes its flags in a register, so they can be read */
  LOAD(ARG0);
  IF_SET_SKIP(NS_FLAGS, 1);
  RETURN(SECCOMP_RET_ALLOW);
  RETURN(DENY);
#endif
  IF_EQ_ELSE_SKIP(SYS_clone3, 1); /* clone3(2) passes them in memory, which seccomp cannot read. ENOSYS makes libc fall back to clone(2) */
  RETURN(NO_SYS);
  for (size_t i = 0; i < sizeof ALLOWED / sizeof ALLOWED[0]; i++) {
    IF_EQ_ELSE_SKIP((unsigned)ALLOWED[i], 1);
    RETURN(SECCOMP_RET_ALLOW);
  }
#if ALBERA_BROKEN == 5
  RETURN(SECCOMP_RET_ALLOW);
#else
  RETURN(DENY);
#endif
}

/** The filter answers EPERM, except for clone3. Nothing else counts: an x32 call on a kernel without x32 gives ENOSYS with no filter at all.
 *  mount, fsopen and bpf also give EPERM to a plain user with no filter, so those three lines cannot tell; the ALBERA_BROKEN builds cover the filter itself. */
static int refused(long result) { return result == -1 && errno == EPERM; }

/** A 32-bit call through the old gate. On a kernel without 32-bit support it fails too, which also counts: it must never succeed. */
static long legacy_getpid(void) {
  long result = 20; /* getpid in the 32-bit table */
  __asm__ volatile("int $0x80" : "+a"(result) : : "memory", "rcx", "r11");
  return result;
}

static int check(const char *name, int ok) {
  if (!ok) dprintf(2, "albera-launcher: self-test failed: %s\n", name);
  return ok;
}

/** Everything that must be refused, under the same filter the job gets. Returns 1 when all of it was. */
static int self_test(void) {
  int ok = 1;
  int pair[2];
  long clone_result;
  errno = 0; ok &= check("socket AF_VSOCK", refused(syscall(SYS_socket, AF_VSOCK, SOCK_STREAM, 0)));
  errno = 0; ok &= check("socket AF_NETLINK", refused(syscall(SYS_socket, 16, SOCK_RAW, 0)));
  errno = 0; ok &= check("socketpair AF_VSOCK", refused(syscall(SYS_socketpair, AF_VSOCK, SOCK_STREAM, 0, pair)));
  errno = 0; ok &= check("io_uring_setup", refused(syscall(SYS_io_uring_setup, 1, NULL)));
  errno = 0; ok &= check("x32 socket", refused(syscall(X32_BIT | SYS_socket, AF_VSOCK, SOCK_STREAM, 0)));
  ok &= check("32-bit gate", (int)legacy_getpid() < 0);
  errno = 0; clone_result = syscall(SYS_clone, CLONE_NEWUSER, NULL, NULL, NULL, NULL);
  if (clone_result == 0) _exit(0);
  ok &= check("clone NEWUSER", refused(clone_result));
  errno = 0; ok &= check("clone3", syscall(SYS_clone3, NULL, 0) == -1 && errno == ENOSYS);
  errno = 0; ok &= check("unshare", refused(syscall(SYS_unshare, CLONE_NEWUSER)));
  errno = 0; ok &= check("setns", refused(syscall(SYS_setns, 0, 0)));
  errno = 0; ok &= check("mount", refused(syscall(SYS_mount, "none", "/tmp", "tmpfs", 0, NULL)));
  errno = 0; ok &= check("fsopen", refused(syscall(SYS_fsopen, "tmpfs", 0)));
  errno = 0; ok &= check("ptrace", refused(syscall(SYS_ptrace, 0, 0, 0, 0)));
  errno = 0; ok &= check("bpf", refused(syscall(SYS_bpf, 0, NULL, 0)));
  errno = 0; ok &= check("keyctl", refused(syscall(SYS_keyctl, 0, 0, 0, 0, 0)));
  return ok;
}

#ifndef ALBERA_TEST_BUILD
/** One read of a small /proc file. Returns the length, or -1. */
static long read_file(const char *name, char *buffer, size_t size) {
  int fd = open(name, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  long total = 0, got;
  while (total < (long)size - 1 && (got = read(fd, buffer + total, size - 1 - (size_t)total)) > 0) total += got;
  close(fd);
  buffer[total < 0 ? 0 : total] = 0;
  return total;
}

/** The sandbox, checked from the inside: first process of its PID namespace, no capabilities, nothing but loopback, stdio that is only pipes. */
static int in_sandbox(void) {
  static char text[8192];
  if (getpid() != 1) return 0;
  if (read_file("/proc/self/status", text, sizeof text) <= 0 || strstr(text, "CapEff:\t0000000000000000\n") == NULL) return 0;
  if (read_file("/proc/net/dev", text, sizeof text) <= 0) return 0;
  for (char *line = strchr(text, ':'); line != NULL; line = strchr(line + 1, ':')) {
    char *start = line;
    while (start > text && start[-1] != '\n') start--;
    while (*start == ' ') start++;
    if (strncmp(start, "lo:", 3) != 0 && line[1] != '\0' && strncmp(start, "Inter-", 6) != 0 && strncmp(start, "face", 4) != 0) return 0;
  }
  for (int fd = 0; fd <= 2; fd++) {
    struct stat info;
    if (fstat(fd, &info) != 0 || !S_ISFIFO(info.st_mode)) return 0;
  }
  return 1;
}
#endif

int main(int argc, char **argv) {
  if (argc < 2 || argv[1][0] != '/') { dprintf(2, "albera-launcher: usage: albera-launcher <absolute program> [args...]\n"); return 90; }
  if (geteuid() == 0 || getuid() == 0) { dprintf(2, "albera-launcher: refusing to start as root\n"); return 91; }
#ifndef ALBERA_TEST_BUILD
  if (!in_sandbox()) { dprintf(2, "albera-launcher: this is not the sandbox\n"); return 96; }
#endif
  /* A crash would otherwise reach Windows outside this filter: WSL's core_pattern pipes the dump to a root helper that sends it over vsock.
     The kernel skips a piped dump when the limit is exactly 1 (0 does not stop it), and without a capability the job cannot raise a hard limit. */
  struct rlimit no_core = { .rlim_cur = 1, .rlim_max = 1 };
  if (setrlimit(RLIMIT_CORE, &no_core) != 0) { dprintf(2, "albera-launcher: core limit failed\n"); return 91; }
  if (syscall(SYS_close_range, 3u, ~0u, 0u) != 0) { dprintf(2, "albera-launcher: close_range failed\n"); return 91; }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) { dprintf(2, "albera-launcher: no_new_privs failed\n"); return 92; }

  build_filter();
  if (used > MAX_FILTER) { dprintf(2, "albera-launcher: filter too long\n"); return 92; }
  struct sock_fprog fprog = { .len = used, .filter = program };
  if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_TSYNC, &fprog) != 0) { dprintf(2, "albera-launcher: filter did not load\n"); return 92; }

  if (!self_test()) return 93;
  int local[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, local) != 0) { dprintf(2, "albera-launcher: AF_UNIX was refused\n"); return 94; }
  close(local[0]); close(local[1]);

  execv(argv[1], argv + 1);
  dprintf(2, "albera-launcher: exec failed\n");
  return 95;
}
