# Manual smoke testing: safety rules

Manual smoke tests run a **test copy** of the app (a portable folder such as `E:\omm222`), never `E:\Code Editor` itself.
They must leave the tester's computer exactly as it was: PATH, Windows' and WinHTTP's proxy, the global git/npm/pip/cargo/go/
Composer configuration, the certificate store and the user's own Python environment. Take a baseline before and compare after.

## Python packages in a test copy

**Never run a test copy's Python package cleanup from an external PowerShell in normal mode.**

A portable Python run directly (outside an OpenMind terminal) doesn't get OpenMind's environment (`PYTHONNOUSERSITE=1`), so it
also sees the user's personal site-packages (`%APPDATA%\Python\Python3xx\site-packages`) — and those come *before* the interpreter's
own `site-packages` on `sys.path`. `pip uninstall` then removes the first copy it finds: the user's. This happened once during the
Milestone 22.2 merge smoke (numpy, pandas, python-dateutil, six and tzdata were removed from the user's site-packages and had to be
reinstalled; the old versions could not be recovered, pip keeps no record).

Allowed ways, in order of preference:

1. **Use an OpenMind terminal.** It runs the portable Python with the runtime's environment (`PYTHONNOUSERSITE=1`), so pip there sees
   only the test copy's packages.
2. **Outside OpenMind, isolate first and check.** Set `PYTHONNOUSERSITE=1`, run the interpreter with `-s`, never pass `--user`, and run
   `scripts/check-python-isolation.py` with exactly that interpreter and those flags:

   ```powershell
   $env:PYTHONNOUSERSITE = "1"
   & "E:\omm222\OpenMind Studio\runtimes\python\versions\3.14.7\python.exe" -s scripts\check-python-isolation.py
   ```

   It prints `sys.executable`, `USER_SITE`, whether `USER_SITE` is on `sys.path` and whether `PYTHONNOUSERSITE` is set, and exits
   with 1 (**STOP**) when the user site is visible. Run `pip uninstall` only after it says `OK`.
3. **Prefer deleting the test copy's own folders** (`runtimes\python\versions\<v>\Lib\site-packages\<package>`, `cache\offline\wheels`,
   the whole test copy) over running pip at all.
4. **Never uninstall from `%APPDATA%\Python` or the user's Python** (`C:\Python3xx`) without the user's explicit approval.

## Other rules

- pip downloads through OpenMind terminals land in pip's own cache (`%LOCALAPPDATA%\pip\cache`); note what a test adds and remove only
  those files, or pass `--no-cache-dir`.
- Test proxies, HTTP servers and certificates created for a test are local (`127.0.0.1`), temporary, and stopped/removed afterwards.
- The .NET SDK's first run can edit the User PATH and create an HTTPS development certificate; OpenMind's .NET environment switches
  that off (see `docs/workloads.md`) — check both after any .NET test.
- A process check after closing the app must find nothing started from the test copy (and no shell whose command line names it).
