OpenMind Studio - deployment package for a shared installation
===============================================================

This folder ships with OpenMind Studio. In a shared network installation
(setup: "Recommended for All Users") it lets every user, and the IT
administrators, put an OpenMind Studio shortcut on Desktops without
administrator rights on the user computers and without changing any Windows
policy. Nothing here installs software on a computer, raises privileges or
works around Group Policy, AppLocker, Smart App Control or antivirus.

Everything below uses the path of the shared folder, for example
    \fs01\apps\OpenMind Studio
Use the \server\share path (not a drive letter) wherever you can: drive
letters differ between computers (one maps R:, another Z:). OpenMind Studio
always converts a mapped drive to its \server\share path for shortcuts and
for each user's local data folder, so a user who starts it once from R: and
once from Z: keeps one set of settings.


FOR USERS
---------
Nothing is needed in most cases: the first time you start OpenMind Studio
from the shared folder on a computer, it puts "OpenMind Studio" on YOUR
Desktop (only if no shortcut to it is there yet; if you delete it, it stays
deleted).

  Create Desktop Shortcut.cmd   create or repair your Desktop shortcut
  Remove Desktop Shortcut.cmd   remove it (only one that starts this installation)
  Check Installation.cmd        where the program and your data are, what you
                                may change, the shortcut's state, what to do

If Windows won't let you change your Desktop (some locked-down labs), Check
Installation prints the manual way: start "OpenMindStudio.exe" in the shared
folder from File Explorer or Win+R, or ask IT to deploy the shortcut.


FOR IT ADMINISTRATORS
---------------------
Requirements
  - A share every user computer can READ. Whoever installs runtimes and tools
    (you, a teacher) needs WRITE access; users need only read access.
  - 64-bit Windows 10/11 with the Microsoft Edge WebView2 Runtime
    (built into Windows 11).
  - %LOCALAPPDATA% on the computer's own disk (the default). Each computer and
    Windows user keeps the OpenMind Studio database, settings, logs and caches
    in %LOCALAPPDATA%\OpenMind\Studio\Installations\<key>\ - SQLite never runs
    over the network and two computers never open the same database.
  - The program is not code-signed yet: SmartScreen may warn when it is first
    downloaded, and Windows 11 Smart App Control (if on) blocks unsigned
    programs. Allow it with your usual application-control process
    (AppLocker/WDAC path rule for the share, for example).

Pick one way to give users a shortcut (all use rights you already have):

1. Do nothing: per-user shortcuts at first start (default)
   Each user gets a Desktop shortcut the first time they start OpenMind
   Studio on a computer. Turn it off if you deploy shortcuts yourself:
       "\fs01\apps\OpenMind Studio\OpenMindStudio.exe" --integration user-desktop-shortcuts off
   (or install with /NOUSERSHORTCUTS). "on" turns it back on.

2. Group Policy Preferences (recommended in a domain)
   User Configuration > Preferences > Windows Settings > Shortcuts > New:
     Action: Update
     Name: OpenMind Studio
     Target type: File System Object
     Location: Desktop          (or "All Users Desktop" in Computer Configuration)
     Target path: \fs01\apps\OpenMind Studio\OpenMindStudio.exe
     Start in: \fs01\apps\OpenMind Studio
     Icon file path: \fs01\apps\OpenMind Studio\OpenMindStudio.exe, index 0
   To remove later: the same item with Action: Delete.

3. Logon script (Group Policy or any approved logon script)
   User Configuration > Policies > Windows Settings > Scripts > Logon:
       \fs01\apps\OpenMind Studio\deploy\OpenMindStudio-Logon.cmd
   Creates or repairs the signed-in user's shortcut; silent; exit code 0;
   log in %LOCALAPPDATA%\OpenMind\Studio\logon-shortcut.log.
   Parameter "remove" takes the shortcut away (use it before uninstalling).

4. Push now with PowerShell remoting
   Deploy-OpenMindShortcuts.ps1 (this folder) writes the shortcut to the
   Public Desktop of each listed computer, verifies it and writes a CSV
   report. Needs administrator rights on the targets and WinRM enabled on
   them; it reports, never works around, computers you may not manage.
       .\Deploy-OpenMindShortcuts.ps1 -SharedExe "\fs01\apps\OpenMind Studio\OpenMindStudio.exe" `
           -ComputerListPath .\lab1.txt -WhatIf
   Drop -WhatIf to apply; -Remove takes the shortcuts away.

5. One computer by hand (administrator on that computer)
       "\fs01\apps\OpenMind Studio\OpenMindStudio.exe" --integration desktop-shortcut --all-users

Checking a computer
   Run Check Installation.cmd as the user (or OpenMindStudio.exe
   --integration check): program and network path, installation type, the
   user's data folder and whether it is on this computer, administrator or
   standard rights, whether the share and the Desktop are writable for the
   user, and the shortcut's state.

Updates (centralised)
   Users' copies never change the shared folder. In a maintenance window,
   with OpenMind Studio closed everywhere, run the new setup on one computer
   that may write to the share (or pass /D=\fs01\apps\OpenMind Studio). It
   finds the installation, shows "OpenMind Studio Update", keeps the
   installation type, refuses while a computer still runs the program from
   the share, and every computer starts the new version next time.

Uninstalling
   Remove the users' shortcuts first (GPP Delete, the logon script with
   "remove", or Deploy-OpenMindShortcuts.ps1 -Remove), then run the
   uninstaller on the computer that installed it. Each user's local data
   folder is left in place.

Network drive disconnected
   OpenMind Studio's database and settings are on each computer, so a lost
   connection can't damage them. The program itself, runtimes and tools are
   read from the share: while it is unreachable, OpenMind Studio can't start
   (Windows says the shortcut's target is unavailable) and runtimes stop
   working; restart OpenMind Studio once the share is back.

Command line (OpenMindStudio.exe --integration ...)
   set-layout portable|per-user|per-machine|network
   layout
   desktop-shortcut [--all-users]
   remove-desktop-shortcut [--all-users]
   user-desktop-shortcuts on|off
   check
   Exit code 0 = done, 1 = failed (the reason is printed), 2 = unknown action.
   The program is a window program: redirect its output to see it
   (OpenMindStudio.exe --integration check > report.txt) or use the .cmd
   files above.
