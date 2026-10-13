#!/usr/bin/env bash
# usage: bash scripts/linux-release.sh
#
# Builds the Linux release (deb, AppImage, portable tar.gz) of this checkout for the machine's architecture and puts it
# into the project's own release folder, `release/v<version>/linux/` (git-ignored), under the release names
# (scripts/releaseTools.mjs releaseName). Run it on the project itself — no clone or copy of the source:
#
#   x64: in WSL, `cd "/mnt/e/Code Editor" && bash scripts/linux-release.sh`
#   x86: in a Debian trixie i386 container with the project mounted at /src (docs/release.md, "Linux"):
#        `docker run --platform linux/386 -v "E:\Code Editor:/src" -v openmind-linux-cache:/cache ... bash /src/scripts/linux-release.sh`
#
# Needs: the frontend already built into dist/ (`pnpm build` on Windows: Node has no 32-bit Linux build and the
# Windows node_modules must not be replaced), `cargo tauri` (cargo install tauri-cli --version <@tauri-apps/cli> --locked)
# and the WebKitGTK 4.1 development packages. The cargo target folder is a cache outside the project
# (CARGO_TARGET_DIR, default ~/.cache/openmind-studio/target-linux-<arch>); `--locked` keeps Cargo.lock untouched.
# With TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD) set, the deb and AppImage get updater .sig files; without it none are made.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(grep -m1 '"version"' "$root/src-tauri/tauri.conf.json" | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
case "$(dpkg --print-architecture)" in
  amd64) arch=x64 ;;
  i386) arch=x86 ;;
  *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;;
esac
[ -f "$root/dist/index.html" ] || { echo "dist/ is missing: run 'pnpm build' first." >&2; exit 1; }

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/openmind-studio/target-linux-$arch}"
export APPIMAGE_EXTRACT_AND_RUN=1
config='{"build":{"beforeBuildCommand":""}}'
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "TAURI_SIGNING_PRIVATE_KEY is not set: no updater signatures."
  config='{"build":{"beforeBuildCommand":""},"bundle":{"createUpdaterArtifacts":false}}'
fi

cd "$root"
rm -rf "$CARGO_TARGET_DIR/release/bundle"
cargo tauri build --bundles deb,appimage --config "$config" -- --locked

built="$CARGO_TARGET_DIR/release"
out="$root/release/v$version/linux"
mkdir -p "$out"
name="OpenMind-Studio_${version}_linux_${arch}"
copy_with_sig() { # <source> <destination>
  cp "$1" "$2"
  if [ -f "$1.sig" ]; then cp "$1.sig" "$2.sig"; else rm -f "$2.sig"; fi
}
copy_with_sig "$(ls "$built"/bundle/deb/*.deb | head -1)" "$out/$name.deb"
copy_with_sig "$(ls "$built"/bundle/appimage/*.AppImage | head -1)" "$out/$name.AppImage"
chmod 755 "$out/$name.AppImage"

stage="$CARGO_TARGET_DIR/portable-stage"
rm -rf "$stage"
mkdir -p "$stage/OpenMind Studio"
install -m 755 "$built/OpenMindStudio" "$stage/OpenMind Studio/OpenMindStudio"
label=$([ "$arch" = x64 ] && echo "x86_64" || echo "x86, 32-bit")
cat > "$stage/OpenMind Studio/README.txt" <<README
OpenMind Studio $version - portable (Linux $label)

Run: ./OpenMindStudio  (from this folder)
Data is kept next to the program when this folder is writable, otherwise in ~/.local/share/openmind-studio.
Needs the system libraries WebKitGTK 4.1, GTK 3, libsoup 3, librsvg2 and libayatana-appindicator3
(Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1 librsvg2-2).
Not available on Linux: the offline language-server/formatter/Python bundles and the Runtime Manager's downloads.
README
tar -C "$stage" --owner=0 --group=0 -czf "$out/${name}_portable.tar.gz" "OpenMind Studio"
rm -rf "$stage"

echo "Linux $arch release files in $out:"
ls -l "$out"
echo "Then, on Windows: node scripts/release-checksums.mjs   (rewrites release/v$version/SHA256SUMS.txt)"
