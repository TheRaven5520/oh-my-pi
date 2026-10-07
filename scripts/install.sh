#!/bin/sh
# Spring-Silicon/oh-my-pi is private: install with a GitHub CLI login that has access to the org.
# Usage: gh api repos/Spring-Silicon/oh-my-pi/contents/scripts/install.sh -H 'Accept: application/vnd.github.raw' | sh
set -eu
REPO=Spring-Silicon/oh-my-pi
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
TAG="${PI_RELEASE_TAG:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --binary) ;;
    --ref|-r) [ $# -ge 2 ] || exit 1; TAG=$2; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done
host_arch() {
  if [ "$(uname -s)" = Darwin ] && [ "$(sysctl -in hw.optional.arm64 2>/dev/null || /usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null || :)" = 1 ]; then
    echo arm64
  else
    case "$(uname -m)" in
      x86_64|amd64) echo x64 ;;
      arm64|aarch64) echo arm64 ;;
      *) uname -m ;;
    esac
  fi
}
if [ "$(uname -s)" = Linux ] && command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
  echo "musl Linux is not published by Spring Silicon" >&2; exit 1
fi
case "$(uname -s)-$(host_arch)" in
  Linux-x64) BINARY=omp-linux-x64 ;;
  Darwin-arm64) BINARY=omp-darwin-arm64 ;;
  *) echo "No Spring Silicon binary for this platform (supported: Linux x64, Apple Silicon)" >&2; exit 1 ;;
esac
[ ! -d "$INSTALL_DIR/omp" ] || { echo "$INSTALL_DIR/omp is a directory; refusing to replace" >&2; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "GitHub CLI (gh) is required: $REPO is private" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' with an account that can access $REPO" >&2; exit 1; }
if [ -z "$TAG" ]; then
  TAG=$(gh release view -R "$REPO" --json tagName -q .tagName)
fi
printf '%s\n' "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+-spring\.[0-9]+$' || { echo "Invalid Spring release tag: $TAG" >&2; exit 1; }
mkdir -p "$INSTALL_DIR"
stage=$(mktemp -d "$INSTALL_DIR/.omp-install.XXXXXX")
probe=""; watchdog=""
trap '[ -z "$watchdog" ] || kill "$watchdog" 2>/dev/null || :; [ -z "$probe" ] || kill -TERM "$probe" 2>/dev/null || :; rm -rf "$stage"' 0
trap 'exit 1' HUP INT TERM
gh release download "$TAG" -R "$REPO" -p "$BINARY" -p SHA256SUMS.txt -D "$stage"
mv "$stage/$BINARY" "$stage/omp"
expected=$(awk -v n="$BINARY" '{name=$2; sub(/^\*/, "", name)} name == n {count++; if (NF != 2 || length($1) != 64 || $1 ~ /[^0-9a-fA-F]/) bad=1; hash=tolower($1)} END {if(count != 1 || bad) exit 1; print hash}' "$stage/SHA256SUMS.txt")
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$stage/omp"); else actual=$(shasum -a 256 "$stage/omp"); fi
[ "${actual%% *}" = "$expected" ] || { echo 'Checksum verification failed' >&2; exit 1; }
chmod 755 "$stage/omp"
mkdir "$stage/home"
(
  unset OMP_LAUNCHER_OWNS_CLI
  HOME="$stage/home"; PI_CODING_AGENT_DIR="$stage/home/agent"; export HOME PI_CODING_AGENT_DIR
  exec "$stage/omp" --version
) </dev/null > "$stage/version" &
probe=$!
(
  sleep 30 & sleeper=$!
  trap 'kill "$sleeper" 2>/dev/null || :; exit 0' HUP INT TERM
  wait "$sleeper"
  : > "$stage/timed-out"
  children=$(ps -axo pid=,ppid= | awk -v parent="$probe" '$2 == parent {print $1}')
  kill -TERM "$probe" 2>/dev/null || :
  sleep 2 & sleeper=$!; wait "$sleeper"
  for child in $children; do kill -KILL "$child" 2>/dev/null || :; done
  kill -KILL "$probe" 2>/dev/null || :
) >/dev/null 2>&1 &
watchdog=$!
status=0; wait "$probe" || status=$?; probe=""
if [ ! -e "$stage/timed-out" ]; then kill "$watchdog" 2>/dev/null || :; fi
wait "$watchdog" 2>/dev/null || :; watchdog=""
[ "$status" = 0 ] && [ ! -e "$stage/timed-out" ] && [ -s "$stage/version" ] || { echo 'Downloaded omp cannot start (30s limit)' >&2; exit 1; }
mv -f "$stage/omp" "$INSTALL_DIR/omp"
echo "Installed Spring Silicon omp to $INSTALL_DIR/omp"
