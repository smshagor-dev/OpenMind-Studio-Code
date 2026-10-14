#!/usr/bin/env bash
# OpenMind Studio - macOS build (disk image and app ZIP), for macOS only. Double-click it in Finder, or run:
#   scripts/build-macos.command [arm64|x64|all]     (default: this Mac's own architecture)
#
# Checks the prerequisites (macOS, Xcode command line tools, node, pnpm, cargo, rustup, cargo tauri, the Rust target of
# each architecture) and that the version is the same everywhere, builds the frontend (pnpm build), then runs
# scripts/macos-release.sh for each architecture, which writes release/v<version>/macos/<arch>/ and checks the app's
# architecture, version and signature. Then it rewrites release/v<version>/metadata/SHA256SUMS.txt.
#
# The app is ad-hoc signed only: that is not Developer ID signing or notarization, so Gatekeeper asks the user to
# confirm the first start (scripts/macos-release.sh). macOS packages are not part of every release; see docs/release.md.
# Stops at the first failing step with a nonzero exit code; never deletes release files of another version.
set -euo pipefail
trap 'echo "BUILD FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR
fail() { echo "BUILD FAILED: $*" >&2; exit 1; }

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
[ -f package.json ] && [ -f src-tauri/tauri.conf.json ] || fail "$root is not the OpenMind Studio project folder."
[ "$(uname -s)" = "Darwin" ] || fail "this script builds the macOS editions and runs on macOS only."

case "${1:-native}" in
  native) [ "$(uname -m)" = "arm64" ] && arches=(arm64) || arches=(x64) ;;
  arm64) arches=(arm64) ;;
  x64) arches=(x64) ;;
  all) arches=(arm64 x64) ;;
  *) fail "unknown architecture '$1' (arm64, x64 or all)." ;;
esac

xcode-select -p >/dev/null 2>&1 || fail "the Xcode command line tools are missing: xcode-select --install"
for tool in node pnpm cargo rustup; do
  command -v "$tool" >/dev/null || fail "$tool is missing."
done
cargo tauri --version >/dev/null 2>&1 || fail "cargo tauri is missing: cargo install tauri-cli --version <@tauri-apps/cli in package.json> --locked"
version="$(node scripts/build-info.mjs version)" || fail "the version could not be read or isn't the same everywhere."
for arch in "${arches[@]}"; do
  triple=$([ "$arch" = arm64 ] && echo aarch64-apple-darwin || echo x86_64-apple-darwin)
  rustup target list --installed | grep -qx "$triple" || fail "the Rust target $triple is missing: rustup target add $triple"
done
echo "OpenMind Studio $version for macOS ${arches[*]}"

pnpm install --frozen-lockfile
pnpm build
for arch in "${arches[@]}"; do
  triple=$([ "$arch" = arm64 ] && echo aarch64-apple-darwin || echo x86_64-apple-darwin)
  bash scripts/macos-release.sh "$triple"
done
node scripts/release-checksums.mjs
echo "Done: release/v$version/macos/ (${arches[*]})."
