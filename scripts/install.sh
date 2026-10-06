#!/bin/sh
set -e
# Usage: curl -fsSL https://raw.githubusercontent.com/Spring-Silicon/oh-my-pi/v18.6.1-spring.1/scripts/install.sh | sh
REPO="Spring-Silicon/oh-my-pi"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
TAG="${PI_RELEASE_TAG:-}"
while [ $# -gt 0 ]; do case "$1" in --binary) ;; --ref|-r) [ $# -ge 2 ] || exit 1; TAG="$2"; shift;; *) echo "Unknown option: $1" >&2; exit 1;; esac; shift; done
host_arch() {
  if [ "$(uname -s)" = Darwin ] && [ "$(sysctl -in hw.optional.arm64 2>/dev/null || true)" = 1 ]; then echo arm64; else
    case "$(uname -m)" in x86_64|amd64) echo x64;; arm64|aarch64) echo arm64;; *) uname -m;; esac
  fi
}
if [ "$(uname -s)" = Linux ] && command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then echo "musl Linux is not published by Spring-Silicon" >&2; exit 1; fi
case "$(uname -s)-$(host_arch)" in Linux-x64) BINARY=omp-linux-x64;; Darwin-arm64) BINARY=omp-darwin-arm64;; *) echo "No Spring-Silicon binary for this platform (supported: Linux x64, macOS arm64)" >&2; exit 1;; esac
if [ -z "$TAG" ]; then TAG=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1); fi
printf '%s\n' "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+-spring\.[0-9]+$' || { echo "Invalid Spring release tag: $TAG" >&2; exit 1; }
mkdir -p "$INSTALL_DIR"; tmp=$(mktemp "$INSTALL_DIR/.omp.XXXXXX"); trap 'rm -f "$tmp" "$tmp.sha"' EXIT
base="https://github.com/$REPO/releases/download/$TAG"
curl -fsSL --connect-timeout 10 --max-time 900 "$base/$BINARY" -o "$tmp"
curl -fsSL --connect-timeout 10 --max-time 60 "$base/SHA256SUMS.txt" -o "$tmp.sha"
expected=$(awk -v n="$BINARY" '$2 == n || $2 == "*" n {print $1}' "$tmp.sha")
actual=$( { sha256sum "$tmp" 2>/dev/null || shasum -a 256 "$tmp"; } | awk '{print $1}' )
[ "${#expected}" = 64 ] && [ "$actual" = "$expected" ] || { echo "Checksum verification failed" >&2; exit 1; }
chmod 755 "$tmp"
"$tmp" --version >/dev/null || { echo "Downloaded omp cannot start" >&2; exit 1; }
mv -f "$tmp" "$INSTALL_DIR/omp"
echo "Installed Spring-Silicon omp to $INSTALL_DIR/omp"
