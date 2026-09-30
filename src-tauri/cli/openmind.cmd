@echo off
rem OpenMind Studio command-line launcher: openmind [folder or file ...]
rem It lives in <OpenMind Studio>\bin, the only folder "Add to PATH" adds (never the install folder itself).
start "" "%~dp0..\OpenMindStudio.exe" %*
