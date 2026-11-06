// The job's hands inside a WSL2 sandbox (docs/architecture/decisions/ADR-012-wsl2-provider.md, decision 9). albera-launcher executes it once
// per run, as the job user and under the seccomp filter, so it is the first process of the PID namespace. When it ends, the namespace ends.
// It holds no authority: a job can take it over, so the bridge sets its own limits and nothing outside trusts these. The limits here keep an
// honest run from using up memory.
//
// Build (static, so the sandbox needs no libraries for it):  gcc -O2 -static -Wall -Wextra -Werror -o albera-agent agent.c
// -DALBERA_TEST_BUILD runs outside a sandbox for the tests, and stops only its own process group. It is never shipped.
//
// Frames, both ways: u32 big-endian length, then that many bytes. All numbers are big-endian.
//   request   u8 op, then   1 run:    u32 seconds, command for bash -c (the rest)
//                           2 read:   path (the rest)
//                           3 write:  u32 path length, path, data (the rest)
//                           4 bundle: u32 seconds, path of the repository (the rest)
//   response  u8 status (0 ok, 1 bad path, 2 too large, 3 file error, 4 could not start, 5 failed), then for an ok
//                           run:    i32 exit code (128 + n for signal n), u8 flags (1 output cut, 2 out of time), output
//                           read:   the bytes        write: nothing        bundle: the bundle
// Paths are relative to the folder it started in (/work). After every run all other processes in the sandbox are stopped, so nothing a
// command left behind runs between calls.
// Exit codes: 0 stdin closed, 96 this is not the sandbox, 97 a frame was malformed, 98 out of memory or the output is gone.

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define MAX_FRAME (256u * 1024u * 1024u)
#define MAX_OUTPUT (1024u * 1024u)
#define MAX_BUNDLE (MAX_FRAME - 16u)
#define MAX_SECONDS 3600u
#define POLL_MS 100
enum { OP_RUN = 1, OP_READ = 2, OP_WRITE = 3, OP_BUNDLE = 4 };
enum { OK = 0, BAD_PATH = 1, TOO_LARGE = 2, FILE_ERROR = 3, NO_START = 4, FAILED = 5 };
enum { CUT = 1, OUT_OF_TIME = 2 };
enum { EXIT_NOT_SANDBOX = 96, EXIT_BAD_FRAME = 97, EXIT_FATAL = 98 };

#ifdef ALBERA_TEST_BUILD
__attribute__((used)) static const char not_for_shipping[] = "ALBERA-NOT-FOR-SHIPPING";
#endif

typedef struct { unsigned char *data; size_t length, capacity, limit; } Buffer;
typedef struct { int exit_code; unsigned char flags; } Outcome;

static uint32_t get_u32(const unsigned char *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }
static void put_u32(unsigned char *p, uint32_t v) { p[0] = (unsigned char)(v >> 24); p[1] = (unsigned char)(v >> 16); p[2] = (unsigned char)(v >> 8); p[3] = (unsigned char)v; }

/** 1 when all of it arrived, 0 on end of input before the first byte, -1 on end of input part way. */
static int read_exact(int fd, unsigned char *to, size_t size) {
  size_t got = 0;
  while (got < size) {
    ssize_t n = read(fd, to + got, size - got);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return got == 0 ? 0 : -1;
    got += (size_t)n;
  }
  return 1;
}

static int write_exact(int fd, const unsigned char *from, size_t size) {
  while (size > 0) {
    ssize_t n = write(fd, from, size);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return 0;
    from += n;
    size -= (size_t)n;
  }
  return 1;
}

static void reply(unsigned char status, const unsigned char *head, size_t head_size, const unsigned char *body, size_t body_size) {
  unsigned char start[5];
  put_u32(start, (uint32_t)(1 + head_size + body_size));
  start[4] = status;
  if (!write_exact(1, start, sizeof start) || !write_exact(1, head, head_size) || !write_exact(1, body, body_size)) _exit(EXIT_FATAL);
}

static void reply_status(unsigned char status) { reply(status, NULL, 0, NULL, 0); }

/** Takes up to the limit and reports whether everything fit. */
static int buffer_add(Buffer *buffer, const unsigned char *from, size_t size) {
  size_t room = buffer->limit - buffer->length;
  size_t take = size < room ? size : room;
  if (buffer->length + take > buffer->capacity) {
    size_t capacity = buffer->capacity ? buffer->capacity : 65536;
    while (capacity < buffer->length + take) capacity *= 2;
    unsigned char *grown = realloc(buffer->data, capacity);
    if (grown == NULL) _exit(EXIT_FATAL);
    buffer->data = grown;
    buffer->capacity = capacity;
  }
  memcpy(buffer->data + buffer->length, from, take);
  buffer->length += take;
  return take == size;
}

/** Relative, and no step goes up. This keeps an honest caller in /work; it is not a boundary, because the job can already reach all of it. */
static int safe_path(const char *path, int allow_dot) {
  if (path[0] == '\0' || path[0] == '/') return 0;
  if (!allow_dot && strcmp(path, ".") == 0) return 0;
  for (const char *step = path; step != NULL;) {
    const char *end = strchr(step, '/');
    size_t size = end ? (size_t)(end - step) : strlen(step);
    if (size == 2 && step[0] == '.' && step[1] == '.') return 0;
    step = end ? end + 1 : NULL;
  }
  return 1;
}

/** A copy that ends in NUL, or NULL when the bytes hold a NUL of their own. */
static char *text_of(const unsigned char *from, size_t size) {
  if (size > 0 && memchr(from, 0, size) != NULL) return NULL;
  char *text = malloc(size + 1);
  if (text == NULL) _exit(EXIT_FATAL);
  if (size > 0) memcpy(text, from, size);
  text[size] = '\0';
  return text;
}

static long now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static void start_child(char *const argv[], int out, int with_stderr) {
  setsid();
  signal(SIGPIPE, SIG_DFL);
  int null = open("/dev/null", O_RDWR | O_CLOEXEC); /* dup2 clears the flag on 0, 1 and 2, so only this copy closes */
  if (null < 0 || dup2(null, 0) < 0 || dup2(out, 1) < 0 || dup2(with_stderr ? out : null, 2) < 0) _exit(127);
  execv(argv[0], argv);
  _exit(127);
}

/** The real build is process 1 of the sandbox, so kill(-1) is every other process there. Never in a test build: there it would be the tester's. */
static void stop_all(pid_t pid) {
#ifdef ALBERA_TEST_BUILD
  kill(-pid, SIGKILL);
#else
  (void)pid;
  kill(-1, SIGKILL);
#endif
}

static void drain(int fd, Buffer *output, Outcome *outcome) {
  unsigned char chunk[65536];
  ssize_t n;
  while ((n = read(fd, chunk, sizeof chunk)) > 0) {
    if (!buffer_add(output, chunk, (size_t)n)) { outcome->flags |= CUT; return; }
  }
}

/** Reads until the command ends, runs out of time, or fills the buffer. Returns 1 when the command itself ended and was collected. */
static int watch(int fd, pid_t pid, long deadline, Buffer *output, Outcome *outcome, int *status) {
  unsigned char chunk[65536];
  struct pollfd wait_for = { .fd = fd, .events = POLLIN };
  for (;;) {
    if (now_ms() >= deadline) { outcome->flags |= OUT_OF_TIME; return 0; }
    int ready = poll(&wait_for, 1, POLL_MS);
    if (ready < 0 && errno != EINTR) return 0;
    if (ready > 0) {
      ssize_t n = read(fd, chunk, sizeof chunk);
      if (n == 0) wait_for.fd = -1; /* the command closed its output, and may still be working */
      if (n > 0 && !buffer_add(output, chunk, (size_t)n)) { outcome->flags |= CUT; return 0; }
    }
    if (waitpid(pid, status, WNOHANG) == pid) return 1; /* a background process may hold the pipe open, so the pipe alone cannot end this */
  }
}

/** Runs argv with its output in the buffer. Returns 0 when it could not start. */
static int capture(char *const argv[], int with_stderr, uint32_t seconds, Buffer *output, Outcome *outcome) {
  int ends[2];
  if (pipe2(ends, O_CLOEXEC) != 0) return 0;
  if (fcntl(ends[0], F_SETFL, O_NONBLOCK) != 0) { close(ends[0]); close(ends[1]); return 0; }
  pid_t pid = fork();
  if (pid < 0) { close(ends[0]); close(ends[1]); return 0; }
  if (pid == 0) start_child(argv, ends[1], with_stderr);
  close(ends[1]);

  int status = 0;
  int ended = watch(ends[0], pid, now_ms() + (long)seconds * 1000, output, outcome, &status);
  stop_all(pid);
  if (!(outcome->flags & CUT)) drain(ends[0], output, outcome);
  close(ends[0]);
  if (!ended) while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
  while (waitpid(-1, NULL, 0) > 0 || errno == EINTR) {} /* everything was killed, so this ends: nothing runs between calls */
  outcome->exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
  return 1;
}

static uint32_t limited_seconds(uint32_t seconds) { return seconds == 0 || seconds > MAX_SECONDS ? MAX_SECONDS : seconds; }

static void do_run(const unsigned char *body, size_t size) {
  if (size < 4) _exit(EXIT_BAD_FRAME);
  char *command = text_of(body + 4, size - 4);
  if (command == NULL) { reply_status(FAILED); return; }
  char *argv[] = { "/bin/bash", "-c", command, NULL };
  Buffer output = { .limit = MAX_OUTPUT };
  Outcome outcome = { 0, 0 };
  if (!capture(argv, 1, limited_seconds(get_u32(body)), &output, &outcome)) reply_status(NO_START);
  else {
    unsigned char head[5];
    put_u32(head, (uint32_t)outcome.exit_code);
    head[4] = outcome.flags;
    reply(OK, head, sizeof head, output.data, output.length);
  }
  free(output.data);
  free(command);
}

static void do_read(const unsigned char *body, size_t size) {
  char *path = text_of(body, size);
  if (path == NULL || !safe_path(path, 0)) { free(path); reply_status(BAD_PATH); return; }
  struct stat info;
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  free(path);
  if (fd < 0) { reply_status(FILE_ERROR); return; }
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode)) { close(fd); reply_status(FILE_ERROR); return; }
  if ((uint64_t)info.st_size > MAX_BUNDLE) { close(fd); reply_status(TOO_LARGE); return; }
  Buffer content = { .limit = MAX_BUNDLE };
  Outcome outcome = { 0, 0 };
  drain(fd, &content, &outcome);
  close(fd);
  if (outcome.flags & CUT) reply_status(TOO_LARGE);
  else reply(OK, NULL, 0, content.data, content.length);
  free(content.data);
}

static void do_write(const unsigned char *body, size_t size) {
  if (size < 4 || get_u32(body) > size - 4) _exit(EXIT_BAD_FRAME);
  size_t path_size = get_u32(body);
  char *path = text_of(body + 4, path_size);
  if (path == NULL || !safe_path(path, 0)) { free(path); reply_status(BAD_PATH); return; }
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0644);
  free(path);
  if (fd < 0) { reply_status(FILE_ERROR); return; }
  int written = write_exact(fd, body + 4 + path_size, size - 4 - path_size);
  if (close(fd) != 0) written = 0;
  reply_status(written ? OK : FILE_ERROR);
}

static void do_bundle(const unsigned char *body, size_t size) {
  if (size < 4) _exit(EXIT_BAD_FRAME);
  char *path = text_of(body + 4, size - 4);
  if (path == NULL || !safe_path(path, 1)) { free(path); reply_status(BAD_PATH); return; }
  char *argv[] = { "/usr/bin/git", "-C", path, "bundle", "create", "-", "--all", NULL };
  Buffer bundle = { .limit = MAX_BUNDLE };
  Outcome outcome = { 0, 0 };
  int started = capture(argv, 0, limited_seconds(get_u32(body)), &bundle, &outcome);
  if (!started) reply_status(NO_START);
  else if (outcome.flags & CUT) reply_status(TOO_LARGE);
  else if (outcome.flags || outcome.exit_code != 0) reply_status(FAILED); /* a part of a bundle is never returned */
  else reply(OK, NULL, 0, bundle.data, bundle.length);
  free(bundle.data);
  free(path);
}

int main(void) {
#ifndef ALBERA_TEST_BUILD
  if (getpid() != 1) { dprintf(2, "albera-agent: this is not the sandbox\n"); return EXIT_NOT_SANDBOX; }
#endif
  signal(SIGPIPE, SIG_IGN);
  for (;;) {
    unsigned char start[4];
    int got = read_exact(0, start, sizeof start);
    if (got == 0) return 0;
    uint32_t size = got < 0 ? 0 : get_u32(start);
    if (size == 0 || size > MAX_FRAME) return EXIT_BAD_FRAME;
    unsigned char *request = malloc(size);
    if (request == NULL) return EXIT_FATAL;
    if (read_exact(0, request, size) != 1) return EXIT_BAD_FRAME;
    switch (request[0]) {
      case OP_RUN: do_run(request + 1, size - 1); break;
      case OP_READ: do_read(request + 1, size - 1); break;
      case OP_WRITE: do_write(request + 1, size - 1); break;
      case OP_BUNDLE: do_bundle(request + 1, size - 1); break;
      default: return EXIT_BAD_FRAME;
    }
    free(request);
  }
}
