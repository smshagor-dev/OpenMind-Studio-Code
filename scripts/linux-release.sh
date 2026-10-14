#!/usr/bin/env bash
# usage: bash scripts/linux-release.sh
#
# Builds the Linux release (deb, AppImage, portable tar.gz) of this checkout for the machine's architecture and puts it
# into the project's own release folder, `release/v<version>/linux/<arch>/` (git-ignored), under the release names
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

fail() { echo "BUILD FAILED: $*" >&2; exit 1; }
trap 'echo "BUILD FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The version, the same in tauri.conf.json, package.json and the workspace Cargo.toml (Node isn't available in the
# 32-bit container, so scripts/build-info.mjs can't be used here). A Windows checkout mounted in WSL or a container has
# CRLF line endings: the carriage return is removed, or "1.0.4" and "1.0.4\r" would differ.
version="$(grep -m1 '"version"' "$root/src-tauri/tauri.conf.json" | sed -E 's/.*"version": *"([^"]+)".*/\1/' | tr -d '\r')"
package_version="$(grep -m1 '"version"' "$root/package.json" | sed -E 's/.*"version": *"([^"]+)".*/\1/' | tr -d '\r')"
cargo_version="$(sed -n '/^\[workspace.package\]/,/^\[/{s/^version = "\([^"]*\)"/\1/p}' "$root/Cargo.toml" | head -1 | tr -d '\r')"
[ -n "$version" ] && [ "$version" = "$package_version" ] && [ "$version" = "$cargo_version" ] ||
  fail "the version differs: tauri.conf.json '$version', package.json '$package_version', Cargo.toml '$cargo_version'."

# Prerequisites: the architecture, the tools and the WebKitGTK/GTK development files the build links against.
command -v dpkg >/dev/null || fail "dpkg is missing (a Debian or Ubuntu system is expected)."
case "$(dpkg --print-architecture)" in
  amd64) arch=x64; elf_machine=62 ;;
  i386) arch=x86; elf_machine=3 ;;
  *) fail "unsupported architecture: $(dpkg --print-architecture) (x64 = amd64, x86 = i386)." ;;
esac
for tool in cargo pkg-config tar gzip od; do
  command -v "$tool" >/dev/null || fail "$tool is missing."
done
cargo tauri --version >/dev/null 2>&1 || fail "cargo tauri is missing: cargo install tauri-cli --version <@tauri-apps/cli in package.json> --locked"
for lib in webkit2gtk-4.1 gtk+-3.0 librsvg-2.0 ayatana-appindicator3-0.1; do
  pkg-config --exists "$lib" || fail "the $lib development files are missing (docs/release.md, 'Linux')."
done
[ -f "$root/dist/index.html" ] || fail "dist/ is missing: run 'pnpm build' first."
echo "OpenMind Studio $version, Linux $arch ($(dpkg --print-architecture)), $(ldd --version | head -1)"

# The ELF machine of a program (62 = x86-64, 3 = i386), read from its header.
elf_machine_of() { od -An -tu2 -j18 -N2 "$1" | tr -d ' '; }

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
[ -x "$built/OpenMindStudio" ] || fail "the program was not built ($built/OpenMindStudio)."
[ "$(elf_machine_of "$built/OpenMindStudio")" = "$elf_machine" ] ||
  fail "the built program is not a $arch program (ELF machine $(elf_machine_of "$built/OpenMindStudio"))."
out="$root/release/v$version/linux/$arch"
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
[ -f "$root/licenses/THIRD-PARTY-LICENSES.txt" ] || { echo "licenses/THIRD-PARTY-LICENSES.txt is missing: run 'pnpm build'." >&2; exit 1; }
install -m 644 "$root/LICENSE" "$stage/OpenMind Studio/LICENSE"
install -m 644 "$root/licenses/THIRD-PARTY-LICENSES.txt" "$stage/OpenMind Studio/THIRD-PARTY-LICENSES.txt"
[ -f "$root/licenses/legal/PRIVACY-POLICY.md" ] || { echo "licenses/legal/ is missing: run 'pnpm build'." >&2; exit 1; }
mkdir -p "$stage/OpenMind Studio/legal"
install -m 644 "$root"/licenses/legal/* "$stage/OpenMind Studio/legal/"
install -m 755 "$root/scripts/launchers/linux/openmind-studio.sh" "$stage/OpenMind Studio/openmind-studio.sh"
label=$([ "$arch" = x64 ] && echo "x86_64" || echo "x86, 32-bit")
build_system="$(. /etc/os-release && echo "$PRETTY_NAME")"
glibc="glibc $(ldd --version | head -1 | grep -oE '[0-9]+\.[0-9]+$')"
cat > "$stage/OpenMind Studio/README.txt" <<README
OpenMind Studio $version - portable (Linux $label)

Unpack (keeps the executable bits): tar -xzf ${name}_portable.tar.gz
Run: ./openmind-studio.sh  (from this folder; it checks the architecture and the system libraries first)
  or ./OpenMindStudio
Built on $build_system with $glibc: older systems (an older glibc) are not supported. Tested distributions are
listed in the release notes; other distributions may work but are not verified.
License Agreement, Privacy Policy and Terms of Use: legal/
Data is kept next to the program when this folder is writable, otherwise in ~/.local/share/openmind-studio.
Needs the system libraries WebKitGTK 4.1, GTK 3, libsoup 3, librsvg2 and libayatana-appindicator3
(Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1 librsvg2-2).
Not available on Linux: the offline language-server/formatter/Python bundles and the Runtime Manager's downloads.
README
tar -C "$stage" --owner=0 --group=0 -czf "$out/${name}_portable.tar.gz" "OpenMind Studio"
rm -rf "$stage"

# Check what was written: every file present and not empty, the deb's architecture, the AppImage's and the portable
# program's ELF machine, and the executable bits inside the tarball.
for file in "$name.deb" "$name.AppImage" "${name}_portable.tar.gz"; do
  [ -s "$out/$file" ] || fail "$out/$file is missing or empty."
done
deb_arch="$(dpkg-deb -f "$out/$name.deb" Architecture)"
[ "$deb_arch" = "$(dpkg --print-architecture)" ] || fail "the deb is for '$deb_arch', not $(dpkg --print-architecture)."
[ "$(dpkg-deb -f "$out/$name.deb" Version)" = "$version" ] || fail "the deb's version is not $version."
[ "$(elf_machine_of "$out/$name.AppImage")" = "$elf_machine" ] || fail "the AppImage is not a $arch program."
listing="$(tar -tvzf "$out/${name}_portable.tar.gz")"
for exe in "OpenMind Studio/OpenMindStudio" "OpenMind Studio/openmind-studio.sh"; do
  grep -qE "^-rwxr-xr-x .* $exe\$" <<<"$listing" || fail "$exe is not executable inside the tarball."
done
check="$(mktemp -d)"
tar -C "$check" -xzf "$out/${name}_portable.tar.gz" "OpenMind Studio/OpenMindStudio"
[ "$(elf_machine_of "$check/OpenMind Studio/OpenMindStudio")" = "$elf_machine" ] ||
  fail "the program in the tarball is not a $arch program."
rm -rf "$check"

echo "Linux $arch release files in $out (all checked):"
ls -l "$out"
echo "Then, on Windows: node scripts/release-checksums.mjs   (rewrites release/v$version/metadata/SHA256SUMS.txt)"
