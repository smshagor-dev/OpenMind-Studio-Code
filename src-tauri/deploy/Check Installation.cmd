@echo off
rem OpenMind Studio - show where the program and your data are, what you may change, whether your Desktop shortcut
rem starts this installation, and what to do about anything that is off. It changes nothing.
setlocal
chcp 65001 >nul
set "OM_EXE=%~dp0..\OpenMindStudio.exe"
if exist "%OM_EXE%" goto run
echo OpenMind Studio was not found next to this folder: "%OM_EXE%"
echo The shared folder may be unreachable (network disconnected, drive not mapped) or this file was moved.
goto end
:run
set "OM_OUT=%TEMP%\openmind-check-%RANDOM%%RANDOM%.txt"
"%OM_EXE%" --integration check >"%OM_OUT%" 2>&1
type "%OM_OUT%"
del "%OM_OUT%" >nul 2>&1
:end
echo.
pause
