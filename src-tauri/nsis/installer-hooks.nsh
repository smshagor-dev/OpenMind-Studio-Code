; OpenMind Studio installer hooks (tauri.conf.json bundle.windows.nsis.installerHooks). Tauri's template includes this
; file before it declares its pages and its own variables, so the page functions below attach to the first page, the
; Welcome page, and they can't name the template's variables ($UpdateMode, $PassiveMode): only the hook macros, which
; are expanded inside the template's Install section, can.
;
; Existing installations (see docs/installer.md, "Updating an existing installation"):
;   The setup first looks for an installation of OpenMind Studio: the folder on the command line (/D=), the folder this
;   Windows user installed before (HKCU "Software\OpenMind\OpenMind Studio"), then the folders installed copies noted
;   when they started (HKCU "Software\OpenMind\OpenMind Studio Installations": a shared network folder someone else
;   installed is found this way). A folder counts only when it holds OpenMindStudio.exe and its install.json or
;   uninstall.exe. Nothing on the network is searched.
;   - found, older       -> the Welcome page becomes "OpenMind Studio Update" (installed version, new version, location,
;                           installation type) with one button, Update. No installation type, no folder, no uninstall
;                           of the old version: the files are replaced in place and every choice made before is kept.
;   - found, same        -> the same page, Repair.
;   - found, newer       -> refused (nothing is changed); /ALLOWDOWNGRADE allows it on purpose.
;   - an MSI install     -> refused: update it with the MSI, or this setup would make a second installation.
;   Before anything is replaced: OpenMind Studio must be closed (it is never closed for the user on this page), its
;   program files must not be in use (on another computer that runs a shared folder, or by another Windows user), and
;   the setup takes an exclusive lock file in the folder, so two setups never update one folder at once. A problem is
;   explained and nothing is changed. Silent and passive installs (/S, /P, the app's own updater) follow the same rules
;   in NSIS_HOOK_PREINSTALL and fail with a non-zero exit code instead of asking.
;
; "Installation type" (a fresh install only, on the Welcome page; the labels are presentation only — the stored values
; stay `per-user` / `network` and the switch stays /NETWORK):
;   - For Me                      -> this Windows user's copy (the default; no administrator rights).
;   - Recommended for All Users   -> one installation in a shared network folder (chosen on the next page, e.g.
;                                    \\server\apps\OpenMind Studio): runtimes and tools installed there are shared,
;                                    and every computer keeps its own database, settings and logs on its own disk.
;   The choice is written next to the program as install.json (`--integration set-layout per-user|network`); the app
;   reads it and never asks again. Silent installs: /NETWORK. An update keeps the earlier choice.
;
; Two optional check boxes, both OFF unless chosen (or, on an update, chosen before):
;   - Add OpenMind Studio to PATH       -> <install>\bin (the `openmind` launchers) on the user's own PATH
;   - Add "Open with OpenMind Studio"   -> File Explorer entries for folders, folder backgrounds and files (HKCU)
; Silent installs: /ADDTOPATH and /EXPLORERMENU. The work is done by the app itself
; (`OpenMindStudio.exe --integration <action>`), which records what it added and removes only that; the uninstaller
; runs `--integration remove-all` (skipped for an update, so the choice survives it).

!include LogicLib.nsh
!include nsDialogs.nsh
!include FileFunc.nsh
!include WordFunc.nsh

!define OM_RECORD_KEY "Software\OpenMind\OpenMind Studio Integration"
!define OM_INSTALLATIONS_KEY "Software\OpenMind\OpenMind Studio Installations"
!define OM_PRODUCT_KEY "Software\OpenMind\OpenMind Studio"
!define OM_EXE "OpenMindStudio.exe"
!define OM_LOCK_FILE ".openmind-setup.lock"
; From the Welcome page to the Installing page: License, the template's reinstall page, Directory, Start Menu.
!define OM_PAGES_TO_INSTALL 5

; The Welcome page's own variables, declared the way MUI2 declares them (same guard, so MUI skips its copy): the page
; functions below are compiled before MUI inserts the page and need $mui.WelcomePage.Text.
!ifndef MUI_WELCOMEPAGE_INTERFACE
  !define MUI_WELCOMEPAGE_INTERFACE
  Var mui.WelcomePage
  Var mui.WelcomePage.Image
  Var mui.WelcomePage.Image.Bitmap
  Var mui.WelcomePage.Title
  Var mui.WelcomePage.Title.Font
  Var mui.WelcomePage.Text
!endif

Var OmInit
Var OmAddPath
Var OmAddMenu
Var OmNetwork
Var OmPathBox
Var OmMenuBox
Var OmMeRadio
Var OmAllRadio
; fresh | update | repair | downgrade | msi
Var OmState
Var OmDetected
Var OmOldVersion
Var OmNewVersion
Var OmMsiLocation
Var OmAllowDowngrade
; The open handle of the lock file (deleted by Windows when the setup ends), empty before it is taken.
Var OmLock
; Why the installation can't be changed now (empty: it can).
Var OmProblem
; The Next button's place and size on the Welcome page (it is widened for "Update OpenMind Studio" and put back).
Var OmNextX
Var OmNextY
Var OmNextW
Var OmNextH

; "a.b.c" of an executable's version resource (empty when it has none).
!macro OmExeVersion FILE OUT
  Push $R7
  Push $R8
  Push $R9
  ClearErrors
  GetDllVersion "${FILE}" $R8 $R9
  ${If} ${Errors}
    StrCpy ${OUT} ""
  ${Else}
    IntOp $R7 $R8 / 0x00010000
    IntOp $R8 $R8 & 0x0000FFFF
    IntOp $R9 $R9 / 0x00010000
    StrCpy ${OUT} "$R7.$R8.$R9"
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
!macroend

; Whether FOLDER holds an installation of OpenMind Studio: its program and the file every installer writes beside it.
!macro OmIsInstall FOLDER OUT
  StrCpy ${OUT} 0
  ${If} "${FOLDER}" != ""
  ${AndIf} ${FileExists} "${FOLDER}\${OM_EXE}"
    ${If} ${FileExists} "${FOLDER}\install.json"
    ${OrIf} ${FileExists} "${FOLDER}\uninstall.exe"
      StrCpy ${OUT} 1
    ${EndIf}
  ${EndIf}
!macroend

; Whether an earlier install of this folder was a network installation: its install.json names the layout (written by
; the app as pretty JSON, so "network" appears as a quoted word on the layout's line).
Function OmEarlierNetwork
  StrCpy $OmNetwork 0
  ClearErrors
  FileOpen $0 "$INSTDIR\install.json" r
  ${If} ${Errors}
    Return
  ${EndIf}
  ${Do}
    ClearErrors
    FileRead $0 $1
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    StrLen $2 $1
    StrCpy $3 0
    ${DoWhile} $3 < $2
      StrCpy $4 $1 9 $3
      ${If} $4 == '"network"'
        StrCpy $OmNetwork 1
      ${EndIf}
      IntOp $3 $3 + 1
    ${Loop}
  ${Loop}
  FileClose $0
FunctionEnd

; An installation made by the per-machine MSI package (Windows Installer keeps it under a product code, in the 64-bit
; view of HKLM). Sets $OmMsiLocation (its folder, or "-" when the record names none); empty when there is none.
Function OmFindMsi
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $OmMsiLocation ""
  SetRegView 64
  StrCpy $0 0
  ${Do}
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    ${If} $1 == ""
      ${Break}
    ${EndIf}
    IntOp $0 $0 + 1
    ReadRegStr $2 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $3 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
    ${If} "$2|$3" == "OpenMind Studio|OpenMind"
      ReadRegDWORD $2 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "WindowsInstaller"
      ${If} $2 == 1
        ReadRegStr $OmMsiLocation HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "InstallLocation"
        ${If} $OmMsiLocation == ""
          StrCpy $OmMsiLocation "-"
        ${EndIf}
        ${Break}
      ${EndIf}
    ${EndIf}
  ${Loop}
  SetRegView lastused
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Compares the installation in $INSTDIR (when there is one) with this setup: sets $OmState and $OmOldVersion.
Function OmExamine
  Push $0
  StrCpy $OmState "fresh"
  StrCpy $OmOldVersion ""
  !insertmacro OmIsInstall "$INSTDIR" $0
  ${If} $0 == 1
    !insertmacro OmExeVersion "$INSTDIR\${OM_EXE}" $OmOldVersion
    ${If} $OmOldVersion == ""
    ${OrIf} $OmNewVersion == ""
      StrCpy $OmState "update"
    ${Else}
      ${VersionCompare} "$OmNewVersion" "$OmOldVersion" $0
      ${If} $0 == 0
        StrCpy $OmState "repair"
      ${ElseIf} $0 == 1
        StrCpy $OmState "update"
      ${Else}
        StrCpy $OmState "downgrade"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $0
FunctionEnd

; Finds the installation this setup should update (once): see the top of this file for the order. Moves $INSTDIR to it.
Function OmDetect
  ${If} $OmDetected == 1
    Return
  ${EndIf}
  StrCpy $OmDetected 1
  Push $0
  Push $1
  Push $2
  Push $3
  !insertmacro OmExeVersion "$EXEPATH" $OmNewVersion
  ClearErrors
  ${GetOptions} $CMDLINE "/ALLOWDOWNGRADE" $0
  ${IfNot} ${Errors}
    StrCpy $OmAllowDowngrade 1
  ${EndIf}

  !insertmacro OmIsInstall "$INSTDIR" $0
  ; A folder named on the command line (/D=) is used as it is. NSIS removes /D= from $CMDLINE, so it shows as a
  ; $INSTDIR that is neither the template's default nor the folder this user installed before; only then is the
  ; folder an installed copy noted looked at.
  ReadRegStr $1 HKCU "${OM_PRODUCT_KEY}" ""
  ${If} $INSTDIR == "$LOCALAPPDATA\OpenMind Studio"
  ${OrIf} $INSTDIR == $1
    StrCpy $1 ""
  ${Else}
    StrCpy $1 "given"
  ${EndIf}
  ${If} $0 != 1
  ${AndIf} $1 == ""
    ReadRegStr $2 HKCU "${OM_INSTALLATIONS_KEY}" ""
    !insertmacro OmIsInstall "$2" $0
    StrCpy $3 0
    ${DoWhile} $0 != 1
      EnumRegValue $2 HKCU "${OM_INSTALLATIONS_KEY}" $3
      ${If} $2 == ""
        ${Break}
      ${EndIf}
      IntOp $3 $3 + 1
      !insertmacro OmIsInstall "$2" $0
    ${Loop}
    ${If} $0 == 1
      StrCpy $INSTDIR $2
    ${EndIf}
  ${EndIf}

  Call OmExamine
  ${If} $OmState == "fresh"
    Call OmFindMsi
    ${If} $OmMsiLocation != ""
      StrCpy $OmState "msi"
    ${EndIf}
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; The starting state, once: the command-line switches, else what an earlier install of this folder recorded.
Function OmDefaults
  ${If} $OmInit == 1
    Return
  ${EndIf}
  StrCpy $OmInit 1
  StrCpy $OmAddPath 0
  StrCpy $OmAddMenu 0
  Call OmEarlierNetwork
  ClearErrors
  ${GetOptions} $CMDLINE "/NETWORK" $0
  ${IfNot} ${Errors}
  ${AndIf} $OmState == "fresh"
    StrCpy $OmNetwork 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/ADDTOPATH" $0
  ${IfNot} ${Errors}
    StrCpy $OmAddPath 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/EXPLORERMENU" $0
  ${IfNot} ${Errors}
    StrCpy $OmAddMenu 1
  ${EndIf}
  ; The record's value names are the PATH entries in lower case (see src-tauri/src/integration/mod.rs).
  ${StrCase} $1 "$INSTDIR\bin" "L"
  ReadRegStr $0 HKCU "${OM_RECORD_KEY}" "$1"
  ${If} $0 != ""
    StrCpy $OmAddPath 1
  ${EndIf}
  ReadRegStr $0 HKCU "${OM_RECORD_KEY}" "Explorer"
  ${If} $0 != ""
    StrCpy $OmAddMenu 1
  ${EndIf}
FunctionEnd

; Whether FILE (in the installation) is open by a running program anywhere: a program that runs keeps its file open
; without write sharing, on this computer and, for a shared folder, on every computer that runs it. Retries $1 times,
; a second apart (a program that is closing). Sets $OmProblem.
Function OmCheckInUse
  Exch $0
  Push $2
  Push $3
  Push $4
  StrCpy $4 0
  ${Do}
    ${IfNot} ${FileExists} "$0"
      ${Break}
    ${EndIf}
    ; GENERIC_WRITE, every share mode, OPEN_EXISTING: opens without changing anything.
    System::Call "kernel32::CreateFileW(w '$0', i 0x40000000, i 7, p 0, i 3, i 0x80, p 0) p .r2 ?e"
    Pop $3
    ${If} $2 <> -1
      System::Call "kernel32::CloseHandle(p r2)"
      ${Break}
    ${EndIf}
    ${If} $3 <> 32
    ${AndIf} $3 <> 33
      ${Break}
    ${EndIf}
    IntOp $4 $4 + 1
    ${If} $4 >= $1
      StrCpy $OmProblem "OpenMind Studio in $INSTDIR is in use — on another computer that runs this shared folder, or by another Windows user on this computer.$\r$\n$\r$\nAsk them to close OpenMind Studio, then run this setup again. Nothing has been changed. (Programs on other computers are never closed by this setup.)"
      ${Break}
    ${EndIf}
    Sleep 1000
  ${Loop}
  Pop $4
  Pop $3
  Pop $2
  Pop $0
FunctionEnd

; Whether an OpenMind Studio program runs on this computer (any Windows user): $2 = 1 / 0. A Toolhelp snapshot through
; the System plugin (the template's own process plugin is not available to these functions).
Function OmLocalRunning
  Push $3
  Push $4
  Push $5
  StrCpy $2 0
  ; TH32CS_SNAPPROCESS
  System::Call "kernel32::CreateToolhelp32Snapshot(i 2, i 0) p .r3"
  ${If} $3 <> -1
    ; PROCESSENTRY32W of a 32-bit process: nine 32-bit fields, then the 260-character file name (556 bytes).
    System::Call "*(i 556, i, i, i, i, i, i, i, i, &w260) p .r4"
    System::Call "kernel32::Process32FirstW(p r3, p r4) i .r5"
    ${DoWhile} $5 <> 0
      System::Call "*$4(i, i, i, i, i, i, i, i, i, &w260 .r5)"
      ${If} $5 == "${OM_EXE}"
        StrCpy $2 1
        ${Break}
      ${EndIf}
      System::Call "kernel32::Process32NextW(p r3, p r4) i .r5"
    ${Loop}
    System::Free $4
    System::Call "kernel32::CloseHandle(p r3)"
  ${EndIf}
  Pop $5
  Pop $4
  Pop $3
FunctionEnd

; Everything that must hold before the installation's files are replaced; sets $OmProblem (empty: go ahead). $0 = 1
; when it may ask the user (the Welcome page), 0 for silent/passive installs (they wait a little for closing programs).
Function OmClaim
  Push $1
  Push $2
  Push $3
  StrCpy $OmProblem ""
  Call OmLocalRunning
  ${If} $0 == 1
    ; Never closed for the user here: unsaved work stays theirs to save.
    ${If} $2 == 1
      StrCpy $OmProblem "OpenMind Studio is open on this computer. Save your work and close OpenMind Studio (every window, also another Windows user's), then press the button again. Nothing has been changed."
    ${EndIf}
    StrCpy $1 1
  ${Else}
    StrCpy $1 15
  ${EndIf}
  ${If} $OmProblem == ""
    Push "$INSTDIR\${OM_EXE}"
    Call OmCheckInUse
  ${EndIf}
  ${If} $OmProblem == ""
    Push "$INSTDIR\lsp\node\node.exe"
    Call OmCheckInUse
  ${EndIf}
  ; A silent or passive setup (the app's own updater) leaves a copy running on this computer to the template, which
  ; closes this user's OpenMind Studio as it always did; a program that runs only elsewhere stops it.
  ${If} $OmProblem != ""
  ${AndIf} $0 != 1
    Call OmLocalRunning
    ${If} $2 == 1
      StrCpy $OmProblem ""
    ${EndIf}
  ${EndIf}
  ${If} $OmProblem == ""
  ${AndIf} $OmLock == ""
    CreateDirectory "$INSTDIR"
    ; GENERIC_WRITE | DELETE, no sharing, OPEN_ALWAYS, hidden + delete on close: Windows removes it when this setup
    ; ends, even after a crash; a second setup can't open it meanwhile.
    System::Call "kernel32::CreateFileW(w '$INSTDIR\${OM_LOCK_FILE}', i 0x40010000, i 0, p 0, i 4, i 0x04000002, p 0) p .r2 ?e"
    Pop $3
    ${If} $2 <> -1
      StrCpy $OmLock $2
    ${ElseIf} $3 = 32
      StrCpy $OmProblem "Another OpenMind Studio setup is already changing $INSTDIR. Wait for it to finish, then run this setup again if it is still needed. Nothing has been changed."
    ${Else}
      StrCpy $OmProblem "This setup can't write to $INSTDIR (Windows error $3). Run it as a user who may change that folder — for a shared network folder, the person who manages it. Nothing has been changed."
    ${EndIf}
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
FunctionEnd

; Before the first page (not for silent installs, which have no pages): find the installation, and stop a passive
; install that would downgrade or duplicate it.
Function OmGuiInit
  Call OmDetect
  Call OmDefaults
  ClearErrors
  ${GetOptions} $CMDLINE "/P" $0
  ${If} ${Errors}
    Return
  ${EndIf}
  ${If} $OmState == "msi"
    MessageBox MB_OK|MB_ICONSTOP "OpenMind Studio is installed for all users with the Windows Installer package (MSI). Update it with the new .msi package; this setup would make a second installation." /SD IDOK
    Quit
  ${EndIf}
  ${If} $OmState == "downgrade"
  ${AndIf} $OmAllowDowngrade != 1
    MessageBox MB_OK|MB_ICONSTOP "A newer OpenMind Studio ($OmOldVersion) is installed in $INSTDIR. This setup ($OmNewVersion) won't replace it. Nothing has been changed." /SD IDOK
    Quit
  ${EndIf}
FunctionEnd
!define MUI_CUSTOMFUNCTION_GUIINIT OmGuiInit

; MUI's text label is 130u tall (to 175u); cut it to $0 dialog units so the controls below it are never painted over.
Function OmCutWelcomeText
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  System::Call "*(i, i, i, i) p .r1"
  System::Call "user32::GetWindowRect(p $mui.WelcomePage.Text, p r1)"
  System::Call "*$1(i .r2, i .r3, i .r4, i .r5)"
  System::Free $1
  IntOp $4 $4 - $2
  IntOp $5 $5 - $3
  IntOp $5 $5 * $0
  IntOp $5 $5 / 130
  ; SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
  System::Call "user32::SetWindowPos(p $mui.WelcomePage.Text, p 0, i 0, i 0, i $4, i $5, i 0x16)"
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
FunctionEnd

; The Next button's text; it grows to the left to fit (the Back button is hidden on the Welcome page) and
; OmRestoreNext puts it back before the next page.
Function OmSetNextText
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  GetDlgItem $1 $HWNDPARENT 1
  SendMessage $1 ${WM_SETTEXT} 0 "STR:$0"
  System::Call "*(i 0, i 0, i 0, i 0) p .r2"
  System::Call "user32::GetWindowRect(p r1, p r2)"
  System::Call "user32::MapWindowPoints(p 0, p $HWNDPARENT, p r2, i 2)"
  System::Call "*$2(i .r3, i .r4, i .r5, i .r6)"
  System::Free $2
  StrCpy $OmNextX $3
  StrCpy $OmNextY $4
  IntOp $OmNextW $5 - $3
  IntOp $OmNextH $6 - $4
  IntOp $2 $OmNextW * 2
  IntOp $3 $5 - $2
  ; SWP_NOZORDER | SWP_NOACTIVATE
  System::Call "user32::SetWindowPos(p r1, p 0, i r3, i r4, i r2, i $OmNextH, i 0x14)"
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function OmRestoreNext
  ${If} $OmNextW != ""
    GetDlgItem $0 $HWNDPARENT 1
    System::Call "user32::SetWindowPos(p r0, p 0, i $OmNextX, i $OmNextY, i $OmNextW, i $OmNextH, i 0x14)"
  ${EndIf}
FunctionEnd

; One "Name: value" line of the update page.
!macro OmFact TOP NAME VALUE HEIGHT
  ${NSD_CreateLabel} 120u ${TOP} 62u 10u "${NAME}"
  Pop $0
  SetCtlColors $0 "" "FFFFFF"
  ${NSD_CreateLabel} 184u ${TOP} 131u ${HEIGHT} "${VALUE}"
  Pop $0
  SetCtlColors $0 "" "FFFFFF"
!macroend

; The Welcome page of an existing installation: what is installed, what replaces it, where — and one button.
Function OmUpdatePage
  ${If} $OmState == "repair"
    SendMessage $mui.WelcomePage.Title ${WM_SETTEXT} 0 "STR:Repair OpenMind Studio"
    SendMessage $mui.WelcomePage.Text ${WM_SETTEXT} 0 "STR:This version of OpenMind Studio is already installed. Repair puts its program files back in place.$\r$\n$\r$\nYour projects, settings, databases, runtimes, language servers and extensions are kept."
  ${ElseIf} $OmState == "msi"
    SendMessage $mui.WelcomePage.Title ${WM_SETTEXT} 0 "STR:OpenMind Studio is already installed"
    SendMessage $mui.WelcomePage.Text ${WM_SETTEXT} 0 "STR:OpenMind Studio is installed for all users with the Windows Installer package (MSI). Update it with the new .msi package (OpenMind-Studio-$OmNewVersion-x64.msi).$\r$\n$\r$\nThis setup would make a second, separate installation, so it stops here. Nothing has been changed."
  ${ElseIf} $OmState == "downgrade"
    SendMessage $mui.WelcomePage.Title ${WM_SETTEXT} 0 "STR:A newer version is installed"
    ${If} $OmAllowDowngrade == 1
      SendMessage $mui.WelcomePage.Text ${WM_SETTEXT} 0 "STR:OpenMind Studio $OmOldVersion is installed here, and this setup has the older $OmNewVersion. You started it with /ALLOWDOWNGRADE: the program files will be replaced by the older version. Your data is kept, but data an older version doesn't know may not be usable until you update again."
    ${Else}
      SendMessage $mui.WelcomePage.Text ${WM_SETTEXT} 0 "STR:OpenMind Studio $OmOldVersion is installed here, and this setup has the older $OmNewVersion. It won't replace a newer version, so nothing has been changed.$\r$\n$\r$\nUse the latest setup, or uninstall first if you really need the older version."
    ${EndIf}
  ${Else}
    SendMessage $mui.WelcomePage.Title ${WM_SETTEXT} 0 "STR:OpenMind Studio Update"
    SendMessage $mui.WelcomePage.Text ${WM_SETTEXT} 0 "STR:OpenMind Studio is already installed. This setup updates it in place.$\r$\n$\r$\nYour projects, settings, databases, runtimes, language servers and extensions are kept, and nothing has to be set up again. Close OpenMind Studio before you continue."
  ${EndIf}
  StrCpy $0 80
  Call OmCutWelcomeText

  ${If} $OmState == "msi"
    ${If} $OmMsiLocation != "-"
      !insertmacro OmFact 128u "Location:" "$OmMsiLocation" 20u
    ${EndIf}
  ${Else}
    StrCpy $1 "For Me"
    ${If} $OmNetwork == 1
      StrCpy $1 "Recommended for All Users"
    ${EndIf}
    StrCpy $2 $OmOldVersion
    ${If} $2 == ""
      StrCpy $2 "unknown"
    ${EndIf}
    !insertmacro OmFact 120u "Installed version:" "$2" 10u
    !insertmacro OmFact 132u "New version:" "$OmNewVersion" 10u
    !insertmacro OmFact 144u "Installation type:" "$1" 10u
    !insertmacro OmFact 156u "Location:" "$INSTDIR" 20u
  ${EndIf}

  ${If} $OmState == "repair"
    Push "Repair OpenMind Studio"
    Call OmSetNextText
  ${ElseIf} $OmState == "update"
    Push "Update OpenMind Studio"
    Call OmSetNextText
  ${ElseIf} $OmAllowDowngrade == 1
  ${AndIf} $OmState == "downgrade"
    Push "Install older version"
    Call OmSetNextText
  ${Else}
    GetDlgItem $0 $HWNDPARENT 1
    EnableWindow $0 0
  ${EndIf}
FunctionEnd

Function OmWelcomeShow
  Call OmDetect
  Call OmDefaults
  ${If} $OmState != "fresh"
    Call OmUpdatePage
    Return
  ${EndIf}
  StrCpy $0 76
  Call OmCutWelcomeText
  ${NSD_CreateLabel} 120u 124u 195u 10u "Installation type:"
  Pop $0
  SetCtlColors $0 "" "FFFFFF"
  ${NSD_CreateFirstRadioButton} 128u 135u 187u 11u "For Me"
  Pop $OmMeRadio
  SetCtlColors $OmMeRadio "" "FFFFFF"
  ${NSD_CreateRadioButton} 128u 147u 187u 11u "Recommended for All Users"
  Pop $OmAllRadio
  SetCtlColors $OmAllRadio "" "FFFFFF"
  ${If} $OmNetwork == 1
    ${NSD_Check} $OmAllRadio
  ${Else}
    ${NSD_Check} $OmMeRadio
  ${EndIf}
  ${NSD_CreateCheckbox} 120u 163u 195u 11u "Add OpenMind Studio to PATH (the openmind command)"
  Pop $OmPathBox
  SetCtlColors $OmPathBox "" "FFFFFF"
  ${If} $OmAddPath == 1
    ${NSD_Check} $OmPathBox
  ${EndIf}
  ${NSD_CreateCheckbox} 120u 176u 195u 11u 'Add "Open with OpenMind Studio" to File Explorer'
  Pop $OmMenuBox
  SetCtlColors $OmMenuBox "" "FFFFFF"
  ${If} $OmAddMenu == 1
    ${NSD_Check} $OmMenuBox
  ${EndIf}
FunctionEnd

Function OmWelcomeLeave
  ${If} $OmState != "fresh"
    ; Update / Repair (/ an allowed downgrade): checked here, so a problem is explained on this page.
    StrCpy $0 1
    Call OmClaim
    ${If} $OmProblem != ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "$OmProblem"
      Abort
    ${EndIf}
    ; Straight to Installing: no license (accepted when it was installed), no uninstall of the old version, no folder or
    ; Start Menu choice — the installation stays where and how it is.
    Call OmRestoreNext
    SendMessage $HWNDPARENT 0x408 ${OM_PAGES_TO_INSTALL} ""
    Abort
  ${EndIf}
  ${NSD_GetState} $OmAllRadio $OmNetwork
  ${NSD_GetState} $OmPathBox $OmAddPath
  ${NSD_GetState} $OmMenuBox $OmAddMenu
  ${If} $OmNetwork == 1
    MessageBox MB_OK|MB_ICONINFORMATION "Recommended for All Users installs OpenMind Studio once into a shared network folder that several computers run it from.$\r$\n$\r$\nOn the next page, choose that folder (for example \\server\apps\OpenMind Studio). You need permission to write there; the other computers' users only need to read it.$\r$\n$\r$\nEach computer and Windows user keeps their own database, settings and logs on their own disk. Runtimes and tools installed into the shared folder are available on every computer.$\r$\n$\r$\nThis setup does not change other computers and does not change any Windows permissions. It puts a shortcut on your own Desktop only; shortcuts on other computers are added by your IT administrator with the tools you are allowed to use (see docs\deployment.md)."
  ${EndIf}
FunctionEnd

!define MUI_PAGE_CUSTOMFUNCTION_SHOW OmWelcomeShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE OmWelcomeLeave

; Before any file is written (every kind of install: interactive, passive, silent, the app's own updater): the same
; rules as the Welcome page, then the template's update mode, so the existing Start Menu and Desktop shortcuts stay as
; they are and nothing is uninstalled.
!macro NSIS_HOOK_PREINSTALL
  Call OmDetect
  ${If} $OmState == "fresh"
    ; A folder chosen on the Directory page may hold an installation nobody ran on this computer yet.
    Call OmExamine
    ${If} $OmState != "fresh"
      Call OmEarlierNetwork
    ${EndIf}
  ${EndIf}
  Call OmDefaults
  SetOutPath $INSTDIR
  ${If} $OmState == "msi"
    StrCpy $OmProblem "OpenMind Studio is installed for all users with the Windows Installer package (MSI). Update it with the new .msi package; this setup would make a second installation."
  ${ElseIf} $OmState == "downgrade"
  ${AndIf} $OmAllowDowngrade != 1
    StrCpy $OmProblem "A newer OpenMind Studio ($OmOldVersion) is installed in $INSTDIR. This setup ($OmNewVersion) won't replace it (use /ALLOWDOWNGRADE to do it on purpose). Nothing has been changed."
  ${Else}
    StrCpy $0 0
    Call OmClaim
  ${EndIf}
  ${If} $OmProblem != ""
    DetailPrint "$OmProblem"
    System::Call 'kernel32::AttachConsole(i -1)i.r0'
    ${If} $0 <> 0
      System::Call 'kernel32::GetStdHandle(i -11)i.r0'
      FileWrite $0 "$OmProblem$\r$\n"
    ${EndIf}
    MessageBox MB_OK|MB_ICONSTOP "$OmProblem" /SD IDOK
    SetErrorLevel 3
    Abort "$OmProblem"
  ${EndIf}
  ${If} $OmState != "fresh"
    StrCpy $UpdateMode 1
    DetailPrint "Updating OpenMind Studio $OmOldVersion to $OmNewVersion in $INSTDIR (data and settings are kept)."
  ${EndIf}
!macroend

; After the files are in place: record how this copy was installed, then apply the choice (a cleared box removes only
; what OpenMind added before).
!macro NSIS_HOOK_POSTINSTALL
  Call OmDefaults
  ${If} $OmNetwork == 1
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --integration set-layout network' $0
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --integration desktop-shortcut' $0
  ${Else}
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --integration set-layout per-user' $0
  ${EndIf}
  ${If} $OmAddPath == 1
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --integration add-path' $0
  ${Else}
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --integration remove-path' $0
  ${EndIf}
  ${If} $OmAddMenu == 1
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --integration add-explorer' $0
  ${Else}
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --integration remove-explorer' $0
  ${EndIf}
!macroend

; Before the files go: take away what this copy added (not on an update, which reinstalls right after). The install
; record goes with the program; every computer's own data (in its local folder) is kept.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --integration remove-desktop-shortcut' $0
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --integration remove-all' $0
    Delete "$INSTDIR\install.json"
  ${EndIf}
!macroend
