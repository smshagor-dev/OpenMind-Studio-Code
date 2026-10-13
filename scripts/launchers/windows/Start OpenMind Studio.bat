@echo off
rem OpenMind Studio launcher for the portable Windows package.
rem Put this file next to OpenMindStudio.exe (the portable ZIP already has it there) and double-click it, or run it
rem from a command prompt; any arguments (folders or files to open) are passed on. It needs no administrator rights,
rem works from any folder (also one with spaces or non-English characters in its name) and starts the program in its
rem own folder, so the portable copy keeps its data next to itself.
setlocal EnableExtensions DisableDelayedExpansion

set "OM_DIR=%~dp0"
set "OM_EXE=%OM_DIR%OpenMindStudio.exe"

if not exist "%OM_EXE%" (
  echo.
  echo OpenMind Studio could not be started: OpenMindStudio.exe was not found in
  echo   %OM_DIR%
  echo.
  echo Keep this launcher in the "OpenMind Studio" folder of the portable package, next to OpenMindStudio.exe.
  echo If the folder is still inside the ZIP file, extract the whole ZIP first ^(right-click, Extract All^).
  echo.
  pause
  exit /b 1
)

start "OpenMind Studio" /D "%OM_DIR%" "%OM_EXE%" %*
if errorlevel 1 (
  echo.
  echo Windows could not start "%OM_EXE%".
  echo If Windows SmartScreen or Smart App Control blocked it, see README.txt.
  echo.
  pause
  exit /b 1
)
endlocal
exit /b 0
