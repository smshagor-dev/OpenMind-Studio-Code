; OpenMind Studio installer hooks (tauri.conf.json bundle.windows.nsis.installerHooks). Tauri's template includes this
; file before it declares its pages, so the page functions below attach to the first page, the Welcome page.
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
Var OmPathBox
Var OmMenuBox

; The starting state, once: the command-line switches, else what an earlier install of this folder recorded.
Function OmDefaults
  ${If} $OmInit == 1
    Return
  ${EndIf}
  StrCpy $OmInit 1
  StrCpy $OmAddPath 0
  StrCpy $OmAddMenu 0
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
  ; MUI's text label is 130u tall (to 175u); cut it to 100u so the check boxes below it are never painted over.
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
  IntOp $5 $5 * 100
  IntOp $5 $5 / 130
  ; SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
  System::Call "user32::SetWindowPos(p $mui.WelcomePage.Text, p 0, i 0, i 0, i $4, i $5, i 0x16)"
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  ${NSD_CreateCheckbox} 120u 152u 195u 12u "Add OpenMind Studio to PATH (the openmind command)"
  Pop $OmPathBox
  SetCtlColors $OmPathBox "" "FFFFFF"
  ${If} $OmAddPath == 1
    ${NSD_Check} $OmPathBox
  ${EndIf}
  ${NSD_CreateCheckbox} 120u 168u 195u 12u 'Add "Open with OpenMind Studio" to File Explorer'
  Pop $OmMenuBox
  SetCtlColors $OmMenuBox "" "FFFFFF"
  ${If} $OmAddMenu == 1
    ${NSD_Check} $OmMenuBox
  ${EndIf}
FunctionEnd

Function OmWelcomeLeave
  ${NSD_GetState} $OmPathBox $OmAddPath
  ${NSD_GetState} $OmMenuBox $OmAddMenu
FunctionEnd

!define MUI_PAGE_CUSTOMFUNCTION_SHOW OmWelcomeShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE OmWelcomeLeave

; After the files are in place: apply the choice (a cleared box removes only what OpenMind added before).
!macro NSIS_HOOK_POSTINSTALL
  Call OmDefaults
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

; Before the files go: take away what this copy added (not on an update, which reinstalls right after).
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --integration remove-all' $0
  ${EndIf}
!macroend
