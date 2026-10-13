@echo off
rem OpenMind Studio - remove the OpenMind Studio shortcut from YOUR Desktop (only one that starts this installation;
rem a shortcut to another copy is left alone). No administrator rights are needed.
setlocal
chcp 65001 >nul
set "OM_EXE=%~dp0..\OpenMindStudio.exe"
if exist "%OM_EXE%" goto run
echo OpenMind Studio was not found next to this folder: "%OM_EXE%"
goto end
:run
set "OM_OUT=%TEMP%\openmind-shortcut-%RANDOM%%RANDOM%.txt"
"%OM_EXE%" --integration remove-desktop-shortcut >"%OM_OUT%" 2>&1
type "%OM_OUT%"
del "%OM_OUT%" >nul 2>&1
:end
echo.
pause
