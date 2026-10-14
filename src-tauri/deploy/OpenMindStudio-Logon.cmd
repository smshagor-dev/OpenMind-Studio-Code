@echo off
rem OpenMind Studio - logon script for IT administrators (Group Policy: User Configuration > Policies > Windows Settings >
rem Scripts (Logon/Logoff) > Logon, or any approved logon script). Point it at this file in the shared folder:
rem     "\\server\share\OpenMind Studio\deploy\OpenMindStudio-Logon.cmd"           creates or repairs the user's shortcut
rem     "\\server\share\OpenMind Studio\deploy\OpenMindStudio-Logon.cmd" remove    removes it (before uninstalling)
rem It runs as the signed-in user, changes only that user's Desktop, needs no administrator rights, shows nothing and
rem always ends with exit code 0 so a logon never waits on it. Each run adds two lines to
rem %LOCALAPPDATA%\OpenMind\Studio\logon-shortcut.log (cleared when it passes 100 KB).
setlocal
set "OM_EXE=%~dp0..\OpenMindStudio.exe"
set "OM_DIR=%LOCALAPPDATA%\OpenMind\Studio"
set "OM_LOG=%OM_DIR%\logon-shortcut.log"
if not exist "%OM_DIR%" mkdir "%OM_DIR%" >nul 2>&1
if exist "%OM_LOG%" for %%F in ("%OM_LOG%") do if %%~zF GTR 102400 del "%OM_LOG%" >nul 2>&1
set "OM_ACTION=desktop-shortcut"
if /i "%~1"=="remove" set "OM_ACTION=remove-desktop-shortcut"
>>"%OM_LOG%" echo [%DATE% %TIME%] %COMPUTERNAME% %USERNAME%: %OM_ACTION%
if exist "%OM_EXE%" goto run
>>"%OM_LOG%" echo   OpenMind Studio is not reachable at "%OM_EXE%"; nothing was changed.
exit /b 0
:run
"%OM_EXE%" --integration %OM_ACTION% >>"%OM_LOG%" 2>&1
exit /b 0
