OpenMind Studio - PascalABC.NET compiler bundle (pascalabc-bundle\)

  PABCNETC.zip        the official PascalABC.NET console compiler from https://pascalabc.net/downloads/PABCNETC.zip,
                      byte for byte (PascalABC.NET 4.0.0.3883). OpenMind Studio never modifies it.
  bundle.json         its version, size and SHA-256 (the same the Runtime Manager manifest pins)
  License_en.txt      PascalABC.NET's licence terms (GNU LGPL v3 with the authors' clarifications)
  copyright.txt       PascalABC.NET's copyright line
  LGPL-3.0.txt        the GNU Lesser General Public License v3
  GPL-3.0.txt         the GNU General Public License v3
  PT4-license-en.txt  the licence of the Programming Taskbook interface units inside the archive (Lib\PT4*.pcu)
  NOTICE.txt          where the archive and PascalABC.NET's source code come from

OpenMind Studio installs PascalABC.NET from this archive without a download: once by itself after the first start of
a new installation or update (unless you removed PascalABC.NET in the Runtime Manager), and whenever you press Install
or Repair on its Runtime Manager card. It is unpacked into runtimes\pascalabc\versions\<version>\; your system PATH,
the Registry and the .NET Framework are never changed. PascalABC.NET needs .NET Framework 4.7.2 or later, which
Windows 10 (1803 and later) and Windows 11 include.

Choose the compiler Run Code uses for .pas files in Settings > Pascal > Compiler (Free Pascal is the default).

Built by: pnpm pascalabc:bundle -- --zip <PABCNETC.zip>   (checked by: pnpm pascalabc:bundle -- --check)
