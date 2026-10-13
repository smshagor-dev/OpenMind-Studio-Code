#!/usr/bin/env bash
# usage: bash scripts/macos-release.sh <aarch64-apple-darwin | x86_64-apple-darwin>
#
# Builds the macOS release (disk image, app ZIP) of this checkout for one architecture, on a Mac (GitHub's macos-15 for
# Apple silicon, macos-15-intel for Intel), into `release/v<version>/macos/<arch>/` under the release names
# (scripts/releaseTools.mjs releaseName): OpenMind-Studio_<v>_macos_<arm64|x64>.dmg and .app.zip. The app ZIP holds
# "OpenMind Studio.app", the launcher "Start OpenMind Studio.command" and legal/.
#
# Signing: the app is ad-hoc signed (tauri.macos.conf.json signingIdentity "-"), which Apple silicon needs to run it at
# all. That is NOT Developer ID signing and NOT notarization: Gatekeeper asks the user to confirm the first start.
# With APPLE_SIGNING_IDENTITY (+ the certificate in the keychain) Tauri signs with it instead; notarization needs
# APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID (or APPLE_API_KEY...) and is only claimed when `xcrun stapler validate` passes.
# With TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD) the app ZIP gets an updater .sig bound to the version; macOS copies only
# use it to learn about new versions (they never update themselves).
#
# Needs: the frontend built into dist/ (pnpm build), `cargo tauri` (the project's @tauri-apps/cli version) and the
# target's Rust standard library (rustup target add <triple>).
set -euo pipefail

triple="${1:?usage: macos-release.sh <aarch64-apple-darwin|x86_64-apple-darwin>}"
case "$triple" in
  aarch64-apple-darwin) arch=arm64 ;;
  x86_64-apple-darwin) arch=x64 ;;
  *) echo "Unsupported target: $triple" >&2; exit 1 ;;
esac
[ "$(uname -s)" = "Darwin" ] || { echo "macOS builds need a Mac (or a GitHub macOS runner)." >&2; exit 1; }

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(grep -m1 '"version"' "$root/src-tauri/tauri.conf.json" | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
[ -f "$root/dist/index.html" ] || { echo "dist/ is missing: run 'pnpm build' first." >&2; exit 1; }
[ -f "$root/licenses/legal/PRIVACY-POLICY.md" ] || { echo "licenses/legal/ is missing: run 'pnpm build' first." >&2; exit 1; }

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/openmind-studio/target-macos}"
# The updater's .app.tar.gz isn't published (macOS copies don't update themselves); the app ZIP is signed below.
config='{"build":{"beforeBuildCommand":""},"bundle":{"createUpdaterArtifacts":false}}'

cd "$root"
rm -rf "$CARGO_TARGET_DIR/$triple/release/bundle"
cargo tauri build --target "$triple" --bundles app,dmg --config "$config" -- --locked

bundle="$CARGO_TARGET_DIR/$triple/release/bundle"
app="$bundle/macos/OpenMind Studio.app"
[ -d "$app" ] || { echo "The app bundle was not built ($app)." >&2; exit 1; }
dmg="$(ls "$bundle"/dmg/*.dmg | head -1)"

# What was built: architecture, bundle id, version, signature.
lipo -archs "$app/Contents/MacOS/OpenMindStudio"
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist"
codesign --verify --deep --strict --verbose=2 "$app"

out="$root/release/v$version/macos/$arch"
mkdir -p "$out"
name="OpenMind-Studio_${version}_macos_${arch}"
cp "$dmg" "$out/$name.dmg"
rm -f "$out/$name.dmg.sig"

stage="$CARGO_TARGET_DIR/$triple/zip-stage"
rm -rf "$stage"
mkdir -p "$stage/OpenMind Studio/legal"
ditto "$app" "$stage/OpenMind Studio/OpenMind Studio.app"
install -m 755 "$root/scripts/launchers/macos/Start OpenMind Studio.command" "$stage/OpenMind Studio/Start OpenMind Studio.command"
install -m 644 "$root"/licenses/legal/* "$stage/OpenMind Studio/legal/"
install -m 644 "$root/licenses/THIRD-PARTY-LICENSES.txt" "$stage/OpenMind Studio/THIRD-PARTY-LICENSES.txt"
rm -f "$out/$name.app.zip"
# ditto keeps the bundle's symlinks, permissions and extended attributes (a plain zip would break the signature).
(cd "$stage" && ditto -c -k --sequesterRsrc --keepParent "OpenMind Studio" "$out/$name.app.zip")
rm -rf "$stage"

rm -f "$out/$name.app.zip.sig"
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  cargo tauri signer sign --app-version "$version" "$out/$name.app.zip"
else
  echo "TAURI_SIGNING_PRIVATE_KEY is not set: no updater signature for the app ZIP."
fi

echo "macOS $arch release files in $out:"
ls -l "$out"
