#!/bin/sh
# OpenMind Studio launcher for macOS. Keep it in the same folder as "OpenMind Studio.app" (the ZIP and the disk image
# have it there) and double-click it, or run it from Terminal with folders or files to open.
# It never removes the quarantine flag or changes Gatekeeper: a download that macOS hasn't approved yet is opened the
# way macOS asks for (Control-click the app > Open, or System Settings > Privacy & Security > Open Anyway).
set -eu

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
app="$dir/OpenMind Studio.app"
program="$app/Contents/MacOS/OpenMindStudio"

fail() {
  printf 'OpenMind Studio: %s\n' "$1" >&2
  osascript -e "display alert \"OpenMind Studio\" message \"$1\"" >/dev/null 2>&1 || true
  exit 1
}

[ -d "$app" ] || fail "\"OpenMind Studio.app\" was not found next to this launcher ($dir)."
[ -f "$program" ] || fail "The app bundle is incomplete ($program is missing). Download it again."

# The program's architectures (arm64, x86_64) against this Mac's; an Intel build on Apple silicon needs Rosetta 2.
archs=$(lipo -archs "$program" 2>/dev/null || echo "")
machine=$(uname -m)
case " $archs " in
  *" $machine "*) ;;
  *" x86_64 "*)
    if [ "$machine" = "arm64" ] && ! arch -x86_64 /usr/bin/true >/dev/null 2>&1; then
      fail "This is the Intel (x64) edition. Install Rosetta 2 (softwareupdate --install-rosetta) or download the Apple silicon (arm64) edition."
    fi
    ;;
  *" arm64 "*) fail "This is the Apple silicon (arm64) edition, but this Mac has an Intel processor. Download the x64 edition." ;;
  *) ;;
esac

if xattr -p com.apple.quarantine "$app" >/dev/null 2>&1; then
  printf '%s\n' "macOS may ask you to confirm opening OpenMind Studio the first time (the app is not notarized)." \
    "If it is blocked: Control-click \"OpenMind Studio.app\" > Open, or System Settings > Privacy & Security > Open Anyway."
fi

if [ "$#" -gt 0 ]; then
  exec open -a "$app" --args "$@"
fi
exec open -a "$app"
