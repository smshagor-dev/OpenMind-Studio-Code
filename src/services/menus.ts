/**
 * The title-bar menu structure, mirroring VS Code's (Windows) menu bar section
 * by section. Entries are pure data referencing command ids: an entry whose
 * command isn't registered (a feature from a later milestone — terminal,
 * debugging, search...) renders disabled rather than being backed by a stub,
 * and lights up automatically once that milestone registers the command.
 */
export type MenuEntry =
  | {
      kind: "command";
      label: string;
      command: string;
      args?: unknown[];
      /** Shown instead of `label` (and without a check mark) while the toggle command is on. */
      toggledLabel?: string;
    }
  | { kind: "submenu"; label: string; items: MenuEntry[] }
  | { kind: "separator" };

export interface TopLevelMenu {
  id: string;
  label: string;
  /** Alt+<mnemonic> opens this menu, as in VS Code. */
  mnemonic: string;
  items: MenuEntry[];
}

export interface RecentEntries {
  folders: { name: string; path: string }[];
  files: { path: string }[];
}

const SEPARATOR: MenuEntry = { kind: "separator" };

function cmd(label: string, command: string, args?: unknown[]): MenuEntry {
  return args ? { kind: "command", label, command, args } : { kind: "command", label, command };
}

function sub(label: string, items: MenuEntry[]): MenuEntry {
  return { kind: "submenu", label, items };
}

function openRecentMenu(recent: RecentEntries): MenuEntry {
  const folders = recent.folders.map((folder) =>
    cmd(folder.path, "file.openRecentFolder", [folder.path]),
  );
  const files = recent.files.map((file) => cmd(file.path, "file.openRecentFile", [file.path]));
  const items: MenuEntry[] = [cmd("Reopen Closed Editor", "file.reopenClosed"), SEPARATOR];
  if (folders.length > 0) items.push(...folders, SEPARATOR);
  if (files.length > 0) items.push(...files, SEPARATOR);
  // Only recent *files* have a clear operation in the backend so far, so the label says exactly that.
  items.push(cmd("Clear Recent Files", "file.clearRecent"));
  return sub("Open Recent", items);
}

function fileMenu(recent: RecentEntries): TopLevelMenu {
  return {
    id: "file",
    label: "File",
    mnemonic: "F",
    items: [
      cmd("New Text File", "file.new"),
      cmd("New File...", "file.newFilePicker"),
      cmd("New Window", "workbench.newWindow"),
      SEPARATOR,
      cmd("Open File...", "file.open"),
      cmd("Open Folder...", "file.openFolder"),
      cmd("Open Workspace from File...", "workspace.openFromFile"),
      openRecentMenu(recent),
      SEPARATOR,
      cmd("Add Folder to Workspace...", "workspace.addFolder"),
      cmd("Save Workspace As...", "workspace.saveAs"),
      cmd("Duplicate Workspace", "workspace.duplicate"),
      SEPARATOR,
      cmd("Save", "file.save"),
      cmd("Save As...", "file.saveAs"),
      cmd("Save All", "file.saveAll"),
      SEPARATOR,
      sub("Share", [cmd("Export Profile...", "profiles.export")]),
      SEPARATOR,
      cmd("Auto Save", "file.toggleAutoSave"),
      sub("Preferences", [
        cmd("Profiles", "profiles.manage"),
        cmd("Settings", "preferences.openSettings"),
        cmd("Extensions", "view.showExtensions"),
        cmd("Keyboard Shortcuts", "preferences.openKeybindings"),
        cmd("Configure Snippets", "preferences.configureSnippets"),
        cmd("Tasks", "tasks.configure"),
        sub("Themes", [
          cmd("Dark", "theme.setDark"),
          cmd("Light", "theme.setLight"),
          SEPARATOR,
          cmd("File Icon Theme", "preferences.fileIconTheme"),
          cmd("Product Icon Theme", "preferences.productIconTheme"),
        ]),
        SEPARATOR,
        cmd("Online Services Settings", "preferences.onlineServices"),
      ]),
      SEPARATOR,
      cmd("Revert File", "file.revert"),
      cmd("Close Editor", "file.closeActiveTab"),
      cmd("Close Folder", "file.closeFolder"),
      cmd("Close Window", "file.closeWindow"),
      SEPARATOR,
      cmd("Exit", "workbench.exit"),
    ],
  };
}

const EDIT_MENU: TopLevelMenu = {
  id: "edit",
  label: "Edit",
  mnemonic: "E",
  items: [
    cmd("Undo", "edit.undo"),
    cmd("Redo", "edit.redo"),
    SEPARATOR,
    cmd("Cut", "edit.cut"),
    cmd("Copy", "edit.copy"),
    cmd("Paste", "edit.paste"),
    SEPARATOR,
    cmd("Find", "edit.find"),
    cmd("Replace", "edit.replace"),
    SEPARATOR,
    cmd("Find in Files", "search.findInFiles"),
    cmd("Replace in Files", "search.replaceInFiles"),
    SEPARATOR,
    cmd("Toggle Line Comment", "edit.toggleLineComment"),
    cmd("Toggle Block Comment", "edit.toggleBlockComment"),
    cmd("Emmet: Expand Abbreviation", "emmet.expandAbbreviation"),
  ],
};

const SELECTION_MENU: TopLevelMenu = {
  id: "selection",
  label: "Selection",
  mnemonic: "S",
  items: [
    cmd("Select All", "selection.selectAll"),
    cmd("Expand Selection", "selection.expand"),
    cmd("Shrink Selection", "selection.shrink"),
    SEPARATOR,
    cmd("Copy Line Up", "selection.copyLineUp"),
    cmd("Copy Line Down", "selection.copyLineDown"),
    cmd("Move Line Up", "selection.moveLineUp"),
    cmd("Move Line Down", "selection.moveLineDown"),
    cmd("Duplicate Selection", "selection.duplicate"),
    SEPARATOR,
    cmd("Add Cursor Above", "selection.addCursorAbove"),
    cmd("Add Cursor Below", "selection.addCursorBelow"),
    cmd("Add Cursors to Line Ends", "selection.addCursorsToLineEnds"),
    cmd("Add Next Occurrence", "selection.addNextOccurrence"),
    cmd("Add Previous Occurrence", "selection.addPreviousOccurrence"),
    cmd("Select All Occurrences", "selection.selectAllOccurrences"),
    SEPARATOR,
    {
      kind: "command",
      label: "Switch to Ctrl+Click for Multi-Cursor",
      toggledLabel: "Switch to Alt+Click for Multi-Cursor",
      command: "selection.toggleMultiCursorModifier",
    },
    cmd("Column Selection Mode", "selection.toggleColumnSelection"),
  ],
};

const VIEW_MENU: TopLevelMenu = {
  id: "view",
  label: "View",
  mnemonic: "V",
  items: [
    cmd("Command Palette...", "workbench.commandPalette"),
    cmd("Open View...", "workbench.openView"),
    SEPARATOR,
    sub("Appearance", [
      cmd("Full Screen", "view.toggleFullScreen"),
      cmd("Zen Mode", "view.toggleZenMode"),
      cmd("Centered Layout", "view.toggleCenteredLayout"),
      SEPARATOR,
      cmd("Primary Side Bar", "view.toggleSidebar"),
      cmd("Secondary Side Bar", "view.toggleSecondarySidebar"),
      cmd("Status Bar", "view.toggleStatusBar"),
      cmd("Panel", "view.togglePanel"),
      SEPARATOR,
      {
        kind: "command",
        label: "Move Primary Side Bar Right",
        toggledLabel: "Move Primary Side Bar Left",
        command: "view.toggleSidebarPosition",
      },
      SEPARATOR,
      cmd("Minimap", "view.toggleMinimap"),
      cmd("Breadcrumbs", "view.toggleBreadcrumbs"),
      cmd("Sticky Scroll", "view.toggleStickyScroll"),
      cmd("Render Whitespace", "view.toggleRenderWhitespace"),
      cmd("Render Control Characters", "view.toggleRenderControlCharacters"),
      SEPARATOR,
      cmd("Zoom In", "view.zoomIn"),
      cmd("Zoom Out", "view.zoomOut"),
      cmd("Reset Zoom", "view.zoomReset"),
    ]),
    sub("Editor Layout", [
      cmd("Split Up", "editorLayout.splitUp"),
      cmd("Split Down", "editorLayout.splitDown"),
      cmd("Split Left", "editorLayout.splitLeft"),
      cmd("Split Right", "editorLayout.splitRight"),
      SEPARATOR,
      cmd("Single", "editorLayout.single"),
      cmd("Two Columns", "editorLayout.twoColumns"),
      cmd("Three Columns", "editorLayout.threeColumns"),
      cmd("Two Rows", "editorLayout.twoRows"),
      cmd("Grid (2x2)", "editorLayout.grid"),
    ]),
    SEPARATOR,
    cmd("Explorer", "view.showExplorer"),
    cmd("Search", "view.showSearch"),
    cmd("Source Control", "view.showSourceControl"),
    cmd("Run", "view.showRun"),
    cmd("Extensions", "view.showExtensions"),
    SEPARATOR,
    cmd("Problems", "view.showProblems"),
    cmd("Output", "view.showOutput"),
    cmd("Debug Console", "view.showDebugConsole"),
    cmd("Terminal", "terminal.toggle"),
    SEPARATOR,
    cmd("Word Wrap", "view.toggleWordWrap"),
  ],
};

const GO_MENU: TopLevelMenu = {
  id: "go",
  label: "Go",
  mnemonic: "G",
  items: [
    cmd("Back", "go.back"),
    cmd("Forward", "go.forward"),
    cmd("Last Edit Location", "go.lastEditLocation"),
    SEPARATOR,
    sub("Switch Editor", [
      cmd("Next Editor", "go.nextEditor"),
      cmd("Previous Editor", "go.previousEditor"),
      SEPARATOR,
      cmd("Next Used Editor", "go.nextUsedEditor"),
      cmd("Previous Used Editor", "go.previousUsedEditor"),
    ]),
    sub("Switch Group", [
      cmd("Group 1", "go.group1"),
      cmd("Group 2", "go.group2"),
      SEPARATOR,
      cmd("Next Group", "go.nextGroup"),
      cmd("Previous Group", "go.previousGroup"),
    ]),
    SEPARATOR,
    cmd("Go to File...", "go.toFile"),
    cmd("Go to Symbol in Workspace...", "go.toSymbolInWorkspace"),
    SEPARATOR,
    cmd("Go to Symbol in Editor...", "go.toSymbolInEditor"),
    cmd("Go to Definition", "go.toDefinition"),
    cmd("Go to Declaration", "go.toDeclaration"),
    cmd("Go to Type Definition", "go.toTypeDefinition"),
    cmd("Go to Implementations", "go.toImplementations"),
    cmd("Go to References", "go.toReferences"),
    SEPARATOR,
    cmd("Go to Line/Column...", "go.toLine"),
    cmd("Go to Bracket", "go.toBracket"),
    SEPARATOR,
    cmd("Next Problem", "go.nextProblem"),
    cmd("Previous Problem", "go.previousProblem"),
    SEPARATOR,
    cmd("Next Change", "go.nextChange"),
    cmd("Previous Change", "go.previousChange"),
  ],
};

const RUN_MENU: TopLevelMenu = {
  id: "run",
  label: "Run",
  mnemonic: "R",
  items: [
    cmd("Start Debugging", "debug.start"),
    cmd("Run Without Debugging", "debug.runWithoutDebugging"),
    cmd("Stop Debugging", "debug.stop"),
    cmd("Restart Debugging", "debug.restart"),
    SEPARATOR,
    cmd("Open Configurations", "debug.openConfigurations"),
    cmd("Add Configuration...", "debug.addConfiguration"),
    SEPARATOR,
    cmd("Step Over", "debug.stepOver"),
    cmd("Step Into", "debug.stepInto"),
    cmd("Step Out", "debug.stepOut"),
    cmd("Continue", "debug.continue"),
    SEPARATOR,
    cmd("Toggle Breakpoint", "debug.toggleBreakpoint"),
    sub("New Breakpoint", [
      cmd("Conditional Breakpoint...", "debug.newConditionalBreakpoint"),
      cmd("Edit Breakpoint", "debug.editBreakpoint"),
      cmd("Inline Breakpoint", "debug.newInlineBreakpoint"),
      cmd("Function Breakpoint...", "debug.newFunctionBreakpoint"),
      cmd("Logpoint...", "debug.newLogpoint"),
      cmd("Triggered Breakpoint...", "debug.newTriggeredBreakpoint"),
    ]),
    SEPARATOR,
    cmd("Enable All Breakpoints", "debug.enableAllBreakpoints"),
    cmd("Disable All Breakpoints", "debug.disableAllBreakpoints"),
    cmd("Remove All Breakpoints", "debug.removeAllBreakpoints"),
    SEPARATOR,
    cmd("Install Additional Debuggers...", "debug.installDebuggers"),
  ],
};

const TERMINAL_MENU: TopLevelMenu = {
  id: "terminal",
  label: "Terminal",
  mnemonic: "T",
  items: [
    cmd("New Terminal", "terminal.new"),
    cmd("Split Terminal", "terminal.split"),
    cmd("Clear Terminal", "terminal.clear"),
    cmd("Kill Terminal", "terminal.kill"),
    SEPARATOR,
    cmd("Run Task...", "tasks.run"),
    cmd("Run Build Task...", "tasks.runBuild"),
    cmd("Run Active File", "terminal.runActiveFile"),
    cmd("Run Selected Text", "terminal.runSelectedText"),
    SEPARATOR,
    cmd("Show Running Tasks...", "tasks.showRunning"),
    cmd("Restart Running Task...", "tasks.restartRunning"),
    cmd("Terminate Task...", "tasks.terminate"),
    SEPARATOR,
    cmd("Configure Tasks...", "tasks.configure"),
    cmd("Configure Default Build Task...", "tasks.configureDefaultBuild"),
  ],
};

const HELP_MENU: TopLevelMenu = {
  id: "help",
  label: "Help",
  mnemonic: "H",
  items: [
    cmd("Welcome", "help.welcome"),
    cmd("Show All Commands", "workbench.commandPalette"),
    cmd("Documentation", "help.documentation"),
    cmd("Editor Playground", "help.editorPlayground"),
    cmd("Show Release Notes", "help.releaseNotes"),
    SEPARATOR,
    cmd("Keyboard Shortcuts Reference", "help.keybindingsReference"),
    cmd("Video Tutorials", "help.videoTutorials"),
    cmd("Tips and Tricks", "help.tipsAndTricks"),
    SEPARATOR,
    cmd("Search Feature Requests", "help.featureRequests"),
    cmd("Report Issue", "help.reportIssue"),
    SEPARATOR,
    cmd("View License", "help.license"),
    cmd("Privacy Statement", "help.privacy"),
    SEPARATOR,
    cmd("Toggle Developer Tools", "help.toggleDevTools"),
    cmd("Open Process Explorer", "help.processExplorer"),
    SEPARATOR,
    cmd("Check for Updates...", "help.checkForUpdates"),
    SEPARATOR,
    cmd("About", "help.about"),
  ],
};

/** The activity bar's gear ("Manage") menu. */
export const MANAGE_MENU: MenuEntry[] = [
  cmd("Command Palette...", "workbench.commandPalette"),
  SEPARATOR,
  cmd("Profiles", "profiles.manage"),
  cmd("Settings", "preferences.openSettings"),
  cmd("Extensions", "view.showExtensions"),
  cmd("Keyboard Shortcuts", "preferences.openKeybindings"),
  cmd("Snippets", "preferences.configureSnippets"),
  cmd("Tasks", "tasks.configure"),
  sub("Themes", [cmd("Dark", "theme.setDark"), cmd("Light", "theme.setLight")]),
  SEPARATOR,
  cmd("Check for Updates...", "help.checkForUpdates"),
];

/** The explorer title's "..." menu: which explorer sections are shown. */
export const EXPLORER_VIEWS_MENU: MenuEntry[] = [cmd("Open Editors", "explorer.toggleOpenEditors")];

export function buildMenuBar(recent: RecentEntries): TopLevelMenu[] {
  return [
    fileMenu(recent),
    EDIT_MENU,
    SELECTION_MENU,
    VIEW_MENU,
    GO_MENU,
    RUN_MENU,
    TERMINAL_MENU,
    HELP_MENU,
  ];
}

/** Every command id referenced anywhere in `menus` (recursing into submenus). */
export function collectCommandIds(menus: TopLevelMenu[]): string[] {
  const ids = new Set<string>();
  const visit = (items: MenuEntry[]) => {
    for (const item of items) {
      if (item.kind === "command") ids.add(item.command);
      else if (item.kind === "submenu") visit(item.items);
    }
  };
  for (const menu of menus) visit(menu.items);
  return [...ids];
}
