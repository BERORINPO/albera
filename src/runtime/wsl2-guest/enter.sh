#!/bin/bash
# Root's first step in a WSL2 run (docs/architecture/decisions/ADR-012-wsl2-provider.md, decisions 7 and 8): limits, then namespaces.
# sandbox-root.sh continues inside them. Fixed arguments only, and every failure stops the run.
#
# Usage: enter.sh <program under /opt/albera/bin> [args...]
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

[ "$(id -u)" = "0" ] || { echo "enter: must start as root" >&2; exit 80; }
[ "$#" -ge 1 ] || { echo "enter: no program" >&2; exit 80; }
case "$1" in *[!a-z0-9-]*) echo "enter: bad program name" >&2; exit 80 ;; esac

# The kernel is shared with the owner's other distributions, so a runaway job must stop at its own limits.
GROUP="/sys/fs/cgroup/albera-run-$$"
echo "+memory +pids" > /sys/fs/cgroup/cgroup.subtree_control
mkdir "$GROUP"
echo $((4 * 1024 * 1024 * 1024)) > "$GROUP/memory.max"
echo 0 > "$GROUP/memory.swap.max"
echo 1024 > "$GROUP/pids.max"
echo $$ > "$GROUP/cgroup.procs"

exec unshare --net --mount --pid --ipc --uts --cgroup --fork --propagation private /bin/bash /opt/albera/sandbox-root.sh "$@"
