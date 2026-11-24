#!/bin/bash
# Builds the image every WSL2 run imports (ADR-012, decisions 6 to 9). Run it as root in a throwaway distribution made from the same Ubuntu Base: it
# needs chroot and the network, installs a compiler on that distribution, and runs the package scripts of what it installs. The result has no
# network use of its own, and the bridge checks its SHA-256. The two programs are compiled here from these sources, with fixed flags, so no test
# build can get in by being handed over.
#
# Usage: build-image.sh <ubuntu-base tar.gz> <output .tar>
# Writes <output .tar>, <output .tar>.sha256 and <output .tar>.packages. Exit codes: 80 usage, 82 wrong base, 83 not root, 84 the result is missing
# something a run needs.
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

BASE_SHA256=e77b6f10c2590cef872b33ee9f635a0e3fd1f57fb074c0e52b5c7f56147a0c86 # ubuntu-base-24.04.5-base-amd64.tar.gz, from cdimage.ubuntu.com SHA256SUMS
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ "$#" -eq 2 ] || { echo "build-image: usage: build-image.sh <base> <output>" >&2; exit 80; }
base="$1"; output="$2"
[ "$(sha256sum "$base" | cut -d' ' -f1)" = "$BASE_SHA256" ] || { echo "build-image: the base is not the pinned file" >&2; exit 82; }
[ "$(id -u)" = "0" ] || { echo "build-image: must run as root" >&2; exit 83; }

root="$(mktemp -d /var/tmp/albera-image.XXXXXX)"
binaries="$(mktemp -d /var/tmp/albera-binaries.XXXXXX)"
trap 'rm -rf --one-file-system "$root" "$binaries"' EXIT

if ! command -v gcc > /dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends gcc libc6-dev
fi
gcc -O2 -static -Wall -Wextra -Werror -o "$binaries/albera-launcher" "$HERE/launcher.c"
gcc -O2 -static -Wall -Wextra -Werror -o "$binaries/albera-agent" "$HERE/agent.c"

tar -xzf "$base" -C "$root" --numeric-owner

# Packages. git for the job and for bundles; the network is used here and never again.
cp /etc/resolv.conf "$root/etc/resolv.conf"
chroot "$root" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get update -qq
chroot "$root" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git
chroot "$root" /usr/bin/dpkg-query -W -f '${Package} ${Version}\n' > "$output.packages"
{
  gcc --version | head -1
  (cd "$HERE" && sha256sum launcher.c agent.c enter.sh sandbox-root.sh)
  (cd "$binaries" && sha256sum albera-launcher albera-agent)
} >> "$output.packages"
chroot "$root" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get clean

# The job user is 1000. The base may already give that number to its own user.
if chroot "$root" /usr/bin/getent passwd 1000 > /dev/null; then chroot "$root" /usr/sbin/userdel -r "$(chroot "$root" /usr/bin/getent passwd 1000 | cut -d: -f1)" 2> /dev/null || true; fi
chroot "$root" /usr/sbin/useradd --uid 1000 --user-group --home-dir /work --no-create-home --shell /bin/bash job

# wsl.conf is not a boundary (ADR-012, "Measured"). It keeps an honest start quiet.
cat > "$root/etc/wsl.conf" <<'CONF'
[automount]
enabled=false
mountFsTab=false
[interop]
enabled=false
appendWindowsPath=false
[user]
default=job
CONF

install -d -o 0 -g 0 -m 755 "$root/opt/albera" "$root/opt/albera/bin"
install -o 0 -g 0 -m 755 "$HERE/enter.sh" "$HERE/sandbox-root.sh" "$root/opt/albera/"
install -o 0 -g 0 -m 755 "$binaries/albera-launcher" "$binaries/albera-agent" "$root/opt/albera/bin/"

# The sandbox has its own small /etc, so a link through /etc/alternatives (awk, for one) would dangle there. Point them straight at the program.
find "$root/usr/bin" "$root/usr/sbin" -type l -lname '/etc/alternatives/*' | while read -r link; do
  target="$(chroot "$root" /usr/bin/readlink -f "${link#"$root"}")"
  ln -sf "$target" "$link"
done

# Nothing the job can reach may raise privileges. no_new_privs already ignores these bits; this is the second line. The tar below takes no xattrs,
# so file capabilities are left out with them.
find "$root" -xdev -type f -perm /6000 -exec chmod ug-s {} +
rm -rf "$root/var/lib/apt/lists"/* "$root/var/cache/apt"/* "$root/var/log"/* "$root/tmp"/* "$root/root/.cache"
: > "$root/etc/resolv.conf"
: > "$root/etc/machine-id"

for need in usr/bin/bash usr/bin/git usr/bin/unshare usr/bin/setpriv usr/bin/env usr/bin/mount usr/bin/umount usr/sbin/pivot_root opt/albera/enter.sh; do
  [ -e "$root/$need" ] || { echo "build-image: the result has no /$need" >&2; exit 84; }
done

chmod 755 "$root" # mktemp made it 700, and the tar keeps that: outside the sandbox no user could enter /
tar --numeric-owner --sort=name --mtime=@0 -C "$root" -cf "$output" .
(cd "$(dirname "$output")" && sha256sum "$(basename "$output")") > "$output.sha256"
cat "$output.sha256"
