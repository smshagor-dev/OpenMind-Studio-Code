#!/bin/sh
# OpenMind Studio launcher for the portable Linux package (OpenMind-Studio_<version>_linux_<arch>_portable.tar.gz).
# Keep it next to the OpenMindStudio program and run it: ./openmind-studio.sh [folder or files to open]
# No sudo is needed. The program keeps its data next to itself when this folder is writable, otherwise in
# ~/.local/share/openmind-studio.
set -eu

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
program="$dir/OpenMindStudio"

fail() {
  printf 'OpenMind Studio: %s\n' "$1" >&2
  exit 1
}

[ -f "$program" ] || fail "OpenMindStudio was not found in $dir. Keep this launcher in the extracted 'OpenMind Studio' folder."
if [ ! -x "$program" ]; then
  chmod u+x "$program" 2>/dev/null || fail "$program is not executable and its permissions can't be changed (read-only or noexec location?)."
fi

# The program's architecture (ELF header byte 4: 1 = 32-bit, 2 = 64-bit; machine at offset 18) against this machine.
machine=$(uname -m)
class=$(od -An -t u1 -j 4 -N 1 "$program" 2>/dev/null | tr -d ' ')
case "$class:$machine" in
  2:x86_64 | 1:i?86 | 1:x86_64) ;;
  2:*) fail "this is the 64-bit (x64) edition, but this machine is $machine." ;;
  1:*) fail "this is the 32-bit (x86) edition, but this machine is $machine." ;;
  *) fail "$program is not a Linux program (damaged download?)." ;;
esac

# System libraries the program needs (WebKitGTK 4.1, GTK 3, libsoup 3 ...): name the missing ones before starting.
if command -v ldd >/dev/null 2>&1; then
  missing=$(ldd "$program" 2>/dev/null | awk '/not found/ { print $1 }' | sort -u | tr '\n' ' ')
  if [ -n "$missing" ]; then
    printf 'OpenMind Studio: missing system libraries: %s\n' "$missing" >&2
    printf 'On Debian/Ubuntu install them with:\n  sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1 librsvg2-2\n' >&2
    exit 1
  fi
fi

cd "$dir"
exec "$program" "$@"
