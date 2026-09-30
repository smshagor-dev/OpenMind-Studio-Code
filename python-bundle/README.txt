OpenMind Studio - offline Python package bundle (python-bundle\)

These Python modules work as soon as a portable Python 3.14 is installed from the Runtime Manager; nothing is
downloaded:

  standard library   os, sys, pathlib, shutil, subprocess, json, csv, datetime, time, re, logging, asyncio,
                     sqlite3, collections, typing, dataclasses, random, math
  tkinter            python.org's Tcl/Tk package (tcltk.msi), added to the install as the "Tcl/Tk GUI support" add-on
  packages           requests, httpx, python-dotenv, numpy, pandas, matplotlib, Pillow, opencv-python,
                     python-telegram-bot, telethon, Flask (and their dependencies)

  bundle.json        what is in this folder, with a SHA-256 for every file
  packages.zip       the wheels (Windows x64, CPython 3.14)
  requirements.txt   every wheel pinned with its SHA-256 (pip --require-hashes)
  tcltk.msi          python.org's Tcl/Tk for Python 3.14.7

Right after the Runtime Manager installs Python 3.14, OpenMind Studio checks packages.zip against bundle.json, unpacks
it to a temporary folder and runs that Python's own pip with --no-index --require-hashes: everything goes into that
Python install only. Your own Python, PATH and pip settings are never touched. Command Palette > "Python: Install
Bundled Packages" does the same again for the active Python (for example after a repair).

Built by: pnpm python:bundle   (checked by: pnpm python:bundle -- --check)
