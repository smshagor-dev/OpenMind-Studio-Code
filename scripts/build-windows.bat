@echo off
rem OpenMind Studio - Windows release build: setup EXE, MSI and portable ZIP for each architecture.
rem
rem usage: scripts\build-windows.bat [x64^|x86^|all] [--skip-checks] [--replace]
rem   x64, x86, all    the architectures to build (default: all)
rem   --skip-checks    don't run the lint, type, test and Rust checks first
rem   --replace        allow replacing files already in release\v^<version^>\windows\^<arch^>\ (refused otherwise)
rem
rem Runs from any folder (it changes to the project folder). Needs node, pnpm, cargo and rustup on PATH, the Rust target
rem of each architecture, NASM on PATH for x86 (docs\release.md), and the offline bundles (pnpm lsp:bundle, python:bundle).
rem Output: release\v<version>\windows\<arch>\ under the release names (scripts\release.mjs), metadata\SHA256SUMS.txt.
rem Updater signatures (.sig files: automatic updates and LAN deployment need them): when TAURI_SIGNING_PRIVATE_KEY_PASSWORD
rem is set in this console, or %USERPROFILE%\.tauri\openmind-updater.password.dpapi exists, "pnpm release:sign" signs the
rem files at the end. Otherwise the build has none and this script says so. The password is never printed or written.
rem Authenticode signing is separate (SIGNING_CERT_PATH etc., docs\release.md). Stops at the first failing step with a
rem nonzero exit code. Never deletes release files.
setlocal EnableExtensions

pushd "%~dp0.." || (echo Can't enter the project folder. & exit /b 1)
if not exist "package.json" (echo %CD% is not the OpenMind Studio project folder. & goto fail)
if not exist "src-tauri\tauri.conf.json" (echo %CD% is not the OpenMind Studio project folder. & goto fail)

set "ARCHES=x64 x86"
set "CHECKS=1"
set "REPLACE=0"
:args
if "%~1"=="" goto args_done
if /i "%~1"=="x64" (set "ARCHES=x64" & shift & goto args)
if /i "%~1"=="x86" (set "ARCHES=x86" & shift & goto args)
if /i "%~1"=="all" (set "ARCHES=x64 x86" & shift & goto args)
if /i "%~1"=="--skip-checks" (set "CHECKS=0" & shift & goto args)
if /i "%~1"=="--replace" (set "REPLACE=1" & shift & goto args)
echo Unknown argument: %~1
echo usage: scripts\build-windows.bat [x64^|x86^|all] [--skip-checks] [--replace]
goto fail
:args_done

echo == Prerequisites
for %%T in (node pnpm cargo rustup) do (
  where %%T >nul 2>nul || (echo %%T was not found on PATH. & goto fail)
)
for /f "delims=" %%V in ('node scripts\build-info.mjs version') do set "VERSION=%%V"
if not defined VERSION (echo The version could not be read or isn't the same everywhere. & goto fail)
for /f "delims=" %%D in ('node scripts\build-info.mjs target-dir') do set "TARGET_DIR=%%D"
if not defined TARGET_DIR (echo Cargo's target folder could not be read. & goto fail)
echo OpenMind Studio %VERSION%, architectures: %ARCHES%, cargo target folder: %TARGET_DIR%
set "OUT=release\v%VERSION%\windows"
for %%A in (%ARCHES%) do (
  call :check_arch %%A || goto fail
)
node scripts\prepare-lsp-bundle.mjs --check || goto fail
node scripts\prepare-python-bundle.mjs --check || goto fail

if "%CHECKS%"=="1" goto checks
echo == Checks skipped (--skip-checks)
goto build
:checks
echo == Checks
call pnpm lint || goto fail
call pnpm exec tsc -b || goto fail
call pnpm test || goto fail
cargo fmt --all -- --check || goto fail
cargo clippy --workspace --all-targets -- -D warnings || goto fail
cargo test --workspace || goto fail

:build
rem The installers are built without updater signatures; release:sign signs the final files below.
set "NO_UPDATER=%TEMP%\openmind-build-no-updater.json"
> "%NO_UPDATER%" echo {"bundle":{"createUpdaterArtifacts":false}}
set "TRIPLES="
set "PORTABLES="
for %%A in (%ARCHES%) do (
  call :build_arch %%A || goto fail
)

echo == Collecting into %OUT%
node scripts\release.mjs --target-dir "%TARGET_DIR%" --targets %TRIPLES% %PORTABLES% || goto fail

echo == Updater signatures
set "SIGN=0"
if defined TAURI_SIGNING_PRIVATE_KEY_PASSWORD set "SIGN=1"
if exist "%USERPROFILE%\.tauri\openmind-updater.password.dpapi" set "SIGN=1"
if "%SIGN%"=="1" (
  call pnpm release:sign || goto fail
) else (
  echo NOT SIGNED: no key password in this console. The files have no .sig: automatic updates and LAN deployment
  echo will not accept them. Sign later with: pnpm release:sign
)

echo == Verifying
node scripts\release-metadata.mjs || goto fail
call pnpm release:checksums || goto fail
call pnpm release:verify || goto fail
node scripts\verify-architecture.mjs || goto fail
if "%SIGN%"=="1" (node scripts\verify-updater-signatures.mjs || goto fail)
echo.
echo Done: OpenMind Studio %VERSION% for %ARCHES% in %CD%\%OUT%
popd
exit /b 0

:check_arch
if /i "%~1"=="x64" (set "TRIPLE=x86_64-pc-windows-msvc") else (set "TRIPLE=i686-pc-windows-msvc")
rustup target list --installed | findstr /b /c:"%TRIPLE%" >nul || (echo The Rust target %TRIPLE% is missing: rustup target add %TRIPLE% & exit /b 1)
if /i "%~1"=="x86" (
  where nasm >nul 2>nul || (echo The x86 build needs NASM on PATH ^(docs\release.md^). & exit /b 1)
)
if "%REPLACE%"=="0" if exist "%OUT%\%~1\*" (
  echo %OUT%\%~1 already has files. Move them away, or pass --replace to replace them.
  exit /b 1
)
exit /b 0

:build_arch
if /i "%~1"=="x64" (set "TRIPLE=x86_64-pc-windows-msvc") else (set "TRIPLE=i686-pc-windows-msvc")
echo == Building %~1 (%TRIPLE%)
call pnpm tauri build --target %TRIPLE% --bundles nsis,msi --config "%NO_UPDATER%" || exit /b 1
set "EXE=%TARGET_DIR%\%TRIPLE%\release\OpenMindStudio.exe"
if not exist "%EXE%" (echo The program was not built: %EXE% & exit /b 1)
node scripts\package-portable.mjs --no-build --exe "%EXE%" --out "release\staging\portable-%~1" || exit /b 1
set "ZIP=release\staging\portable-%~1\OpenMindStudio-%VERSION%-portable-win-x64.zip"
if not exist "%ZIP%" (echo The portable ZIP was not made: %ZIP% & exit /b 1)
if defined TRIPLES (set "TRIPLES=%TRIPLES%,%TRIPLE%") else (set "TRIPLES=%TRIPLE%")
if /i "%~1"=="x64" (set "PORTABLES=%PORTABLES% --portable %ZIP%") else (set "PORTABLES=%PORTABLES% --portable-x86 %ZIP%")
exit /b 0

:fail
echo.
echo BUILD FAILED (see the step above).
popd
exit /b 1
