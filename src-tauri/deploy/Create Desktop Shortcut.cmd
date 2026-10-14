@echo off
rem OpenMind Studio - create or repair the OpenMind Studio shortcut on YOUR Desktop.
rem Double-click it from the shared folder (or a mapped drive). No administrator rights are needed and nothing outside
rem your own Desktop is changed. On a network share the shortcut points at the \\server\share path, so it works on
rem every computer that can reach the share, whatever drive letter it maps.
setlocal
chcp 65001 >nul
set "OM_EXE=%~dp0..\OpenMindStudio.exe"
if exist "%OM_EXE%" goto run
echo OpenMind Studio was not found next to this folder: "%OM_EXE%"
echo Keep this file in the "deploy" folder of the OpenMind Studio installation.
goto end
:run
set "OM_OUT=%TEMP%\openmind-shortcut-%RANDOM%%RANDOM%.txt"
"%OM_EXE%" --integration desktop-shortcut >"%OM_OUT%" 2>&1
set "OM_CODE=%ERRORLEVEL%"
type "%OM_OUT%"
del "%OM_OUT%" >nul 2>&1
echo.
if "%OM_CODE%"=="0" goto done
echo The shortcut could not be created (exit code %OM_CODE%).
echo Run "Check Installation" in this folder for details and the manual steps.
goto end
:done
echo Done. Start OpenMind Studio from the shortcut on your Desktop.
:end
echo.
pause
