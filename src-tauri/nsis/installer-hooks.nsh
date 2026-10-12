; OpenMind Studio installer hooks (tauri.conf.json bundle.windows.nsis.installerHooks). Tauri's template includes this
; file before it declares its pages, so the page functions below attach to the first page, the Welcome page.
;
; "Installation type" (one choice, on the Welcome page; the labels are presentation only — the stored values stay
; `per-user` / `network` and the switch stays /NETWORK):
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

!define OM_RECORD_KEY "Software\OpenMind\OpenMind Studio Integration"

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

Function OmWelcomeShow
  Call OmDefaults
  ; MUI's text label is 130u tall (to 175u); cut it to 76u so the choices below it are never painted over.
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
  IntOp $5 $5 * 76
  IntOp $5 $5 / 130
  ; SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
  System::Call "user32::SetWindowPos(p $mui.WelcomePage.Text, p 0, i 0, i 0, i $4, i $5, i 0x16)"
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
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
  ${NSD_GetState} $OmAllRadio $OmNetwork
  ${NSD_GetState} $OmPathBox $OmAddPath
  ${NSD_GetState} $OmMenuBox $OmAddMenu
  ${If} $OmNetwork == 1
    MessageBox MB_OK|MB_ICONINFORMATION "Recommended for All Users installs OpenMind Studio once into a shared network folder that several computers run it from.$\r$\n$\r$\nOn the next page, choose that folder (for example \\server\apps\OpenMind Studio). You need permission to write there; the other computers' users only need to read it.$\r$\n$\r$\nEach computer and Windows user keeps their own database, settings and logs on their own disk. Runtimes and tools installed into the shared folder are available on every computer.$\r$\n$\r$\nThis setup does not change other computers and does not change any Windows permissions. It puts a shortcut on your own Desktop only; shortcuts on other computers are added by your IT administrator with the tools you are allowed to use (see docs\deployment.md)."
  ${EndIf}
FunctionEnd

!define MUI_PAGE_CUSTOMFUNCTION_SHOW OmWelcomeShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE OmWelcomeLeave

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
