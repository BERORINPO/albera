#!/bin/bash
# Root's second step, inside the namespaces enter.sh made (ADR-012, decisions 7 and 8). It builds a minimal root and drops to the job user.
# Root never opens a path the job can touch: /work is a new, empty tmpfs here, and everything in it is done as the job.
# Started any other way, it fails: albera-launcher checks that it really is in a sandbox before anything runs.
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

JOB_UID=1000
ROOT=/var/tmp/albera-root
mkdir -p "$ROOT"
mount -t tmpfs -o size=64m,mode=755,nosuid,nodev tmpfs "$ROOT"
mkdir -p "$ROOT"/usr "$ROOT"/opt/albera "$ROOT"/proc "$ROOT"/dev "$ROOT"/tmp "$ROOT"/work "$ROOT"/etc "$ROOT"/old
mount -t tmpfs -o size=512m,mode=1777,nosuid,nodev tmpfs "$ROOT/tmp"
mount -t tmpfs -o size=2g,mode=755,nosuid,nodev tmpfs "$ROOT/work"
chown "$JOB_UID:$JOB_UID" "$ROOT/work"
mount --bind /usr "$ROOT/usr"
mount -o remount,ro,bind,nosuid,nodev "$ROOT/usr"
mount --bind /opt/albera "$ROOT/opt/albera"
mount -o remount,ro,bind,nosuid,nodev "$ROOT/opt/albera"
ln -s usr/bin "$ROOT/bin"; ln -s usr/sbin "$ROOT/sbin"; ln -s usr/lib "$ROOT/lib"; ln -s usr/lib64 "$ROOT/lib64"
mount -t proc -o nosuid,nodev,noexec proc "$ROOT/proc"
mount -t tmpfs -o size=1m,mode=755,nosuid,noexec tmpfs "$ROOT/dev"
for name in null zero urandom; do
  touch "$ROOT/dev/$name"
  mount --bind "/dev/$name" "$ROOT/dev/$name"
done
printf 'job:x:%s:%s:job:/work:/bin/bash\n' "$JOB_UID" "$JOB_UID" > "$ROOT/etc/passwd"
printf 'job:x:%s:\n' "$JOB_UID" > "$ROOT/etc/group"

cd "$ROOT"
pivot_root . old
cd /
umount -l /old
rmdir /old

program="/opt/albera/bin/$1"
shift
cd /work
exec setpriv --reuid="$JOB_UID" --regid="$JOB_UID" --clear-groups --no-new-privs --bounding-set=-all --inh-caps=-all \
  /usr/bin/env -i HOME=/work PATH=/usr/bin:/bin LC_ALL=C.UTF-8 /opt/albera/bin/albera-launcher "$program" "$@"
