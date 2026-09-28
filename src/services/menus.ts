import { t } from "../i18n";

/**
 * The title-bar menu structure, mirroring VS Code's (Windows) menu bar section
 * by section. Entries are pure data referencing command ids. Every VS Code entry is listed; one whose feature
 * OpenMind hasn't built is shown **disabled with the reason** (`unbuiltReason`), never as a click that does nothing,
 * and it lights up the moment its command is registered. Only the AI panel item follows the AI provider rule
 * (`HIDDEN_WHEN_UNREGISTERED`), and a shell item exists only for a shell that was found. A registered command that
 * can't run right now stays visible with its reason.
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

/** A project command (from the language support) offered under Run > Project ... Commands. */
export interface ProjectMenuCommand {
  category: "run" | "dev" | "build" | "test";
  label: string;
  projectRoot: string;
  projectName: string;
  commandId: string;
}

/** What the menus need beyond the fixed structure: recent items, the shells found here, the project's commands. */
export interface MenuContext {
  recent: RecentEntries;
  shells: { kind: string; label: string }[];
  projectCommands: ProjectMenuCommand[];
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
  items.push(cmd("Clear Recently Opened", "file.clearRecent"));
  return sub("Open Recent", items);
}

function fileMenu(recent: RecentEntries): TopLevelMenu {
  return {
    id: "file",
    label: "File",
    mnemonic: "F",
    items: [
      cmd("New File", "file.new"),
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
      sub("Share", [
        cmd("Export Profile...", "profiles.export"),
        cmd("Import Profile...", "profiles.import"),
      ]),
      SEPARATOR,
      cmd("Auto Save", "file.toggleAutoSave"),
      sub("Preferences", [
        cmd("Profiles", "profiles.manage"),
        cmd("Settings", "preferences.openSettings"),
        cmd("Workspace Settings", "preferences.openWorkspaceSettings"),
        cmd("Open Settings (JSON)", "preferences.openSettingsJson"),
        cmd("Open Workspace Settings (JSON)", "preferences.openWorkspaceSettingsJson"),
        cmd("Extensions", "view.showExtensions"),
        cmd("Keyboard Shortcuts", "preferences.openKeybindings"),
        cmd("Open Keyboard Shortcuts (JSON)", "preferences.openKeybindingsJson"),
        cmd("Configure Snippets", "preferences.configureSnippets"),
        cmd("Tasks", "tasks.configure"),
        sub("Themes", [
          cmd("Color Theme...", "preferences.colorTheme"),
          SEPARATOR,
          cmd("System", "theme.setSystem"),
          cmd("Dark", "theme.setDark"),
          cmd("Light", "theme.setLight"),
          cmd("High Contrast", "theme.setHighContrast"),
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
    cmd("Refresh Workspace Index", "search.refreshIndex"),
    cmd("Rebuild Workspace Index", "search.rebuildIndex"),
    cmd("Clear Search Index", "search.clearIndex"),
    SEPARATOR,
    cmd("Toggle Line Comment", "edit.toggleLineComment"),
    cmd("Toggle Block Comment", "edit.toggleBlockComment"),
    cmd("Emmet: Expand Abbreviation", "emmet.expandAbbreviation"),
    SEPARATOR,
    cmd("Rename Symbol", "edit.renameSymbol"),
    cmd("Format Document", "edit.formatDocument"),
    cmd("Format Document With...", "edit.formatDocumentWith"),
    cmd("Format Selection", "edit.formatSelection"),
    cmd("Configure Default Formatter...", "edit.configureDefaultFormatter"),
    cmd("Formatter Status", "format.showStatus"),
    cmd("Format on Save", "format.toggleOnSave"),
    cmd("Format Saved File With Tool (Terminal)", "language.formatWithTool"),
    cmd("Run Linter", "language.runLinter"),
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
    cmd("AI Panel", "ai.openChat"),
    SEPARATOR,
    cmd("Problems", "view.showProblems"),
    cmd("Output", "view.showOutput"),
    cmd("Debug Console", "view.showDebugConsole"),
    cmd("Ports", "view.showPorts"),
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

const PROJECT_MENU_TITLES: { categories: string[]; title: string }[] = [
  { categories: ["run", "dev"], title: "Project Run Commands" },
  { categories: ["build"], title: "Project Build Commands" },
  { categories: ["test"], title: "Project Test Commands" },
];

/** Run > Project Run / Build / Test Commands: the commands the language support found, one entry each. */
function projectCommandMenus(commands: ProjectMenuCommand[]): MenuEntry[] {
  const menus: MenuEntry[] = [];
  const several = new Set(commands.map((c) => c.projectRoot)).size > 1;
  for (const group of PROJECT_MENU_TITLES) {
    const items = commands
      .filter((c) => group.categories.includes(c.category))
      .map((c) =>
        cmd(several ? `${c.label} — ${c.projectName}` : c.label, "language.runProjectCommand", [
          c.projectRoot,
          c.commandId,
        ]),
      );
    if (items.length > 0) menus.push(sub(group.title, items));
  }
  return menus.length > 0 ? [SEPARATOR, ...menus] : [];
}

function runMenu(projectCommands: ProjectMenuCommand[]): TopLevelMenu {
  return {
    id: "run",
    label: "Run",
    mnemonic: "R",
    items: [
      cmd("Run Code", "run.code"),
      cmd("Run Code in Terminal", "run.codeInTerminal"),
      cmd("Run Code and Show Output", "run.codeShowOutput"),
      cmd("Stop Running Code", "run.stop"),
      cmd("Configure Run Command...", "run.configure"),
      cmd("Select Runtime...", "run.selectRuntime"),
      ...projectCommandMenus(projectCommands),
      SEPARATOR,
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
}

function terminalMenu(shells: { kind: string; label: string }[]): TopLevelMenu {
  return {
    id: "terminal",
    label: "Terminal",
    mnemonic: "T",
    items: [
      cmd("New Terminal", "terminal.new"),
      ...(shells.length > 0
        ? [
            sub(
              "New Terminal With Profile",
              shells.map((shell) => cmd(shell.label, "terminal.new", [shell.kind])),
            ),
          ]
        : []),
      cmd("Split Terminal", "terminal.split"),
      cmd("Clear Terminal", "terminal.clear"),
      cmd("Kill Terminal", "terminal.kill"),
      cmd("Kill All Terminals", "terminal.killAll"),
      SEPARATOR,
      cmd("Run Active File", "terminal.runActiveFile"),
      cmd("Run Selected Text", "terminal.runSelectedText"),
      SEPARATOR,
      cmd("Run Task...", "tasks.run"),
      cmd("Run Build Task...", "tasks.runBuild"),
      cmd("Run Test Task...", "tasks.runTest"),
      cmd("Show Running Tasks...", "tasks.showRunning"),
      cmd("Restart Running Task...", "tasks.restartRunning"),
      cmd("Terminate Task...", "tasks.terminate"),
      SEPARATOR,
      cmd("Configure Tasks...", "tasks.configure"),
      cmd("Configure Default Build Task...", "tasks.configureDefaultBuild"),
      SEPARATOR,
      cmd("Manage Runtimes...", "runtime.manage"),
      cmd("Workloads...", "workloads.open"),
      cmd("Language Tools...", "lsp.manage"),
      cmd("Restart Language Server", "lsp.restart"),
      cmd("Show LSP Output", "lsp.openOutput"),
      SEPARATOR,
      sub("Network", [
        cmd("Proxy Settings...", "network.openSettings"),
        cmd("Test Connection", "network.testConnection"),
        cmd("Show Current Terminal Proxy Environment", "network.showTerminalEnv"),
        cmd("Clear Proxy Credentials", "network.clearCredentials"),
        SEPARATOR,
        cmd("Import Offline Package...", "network.importOffline"),
        cmd("Open Package Cache Folder", "network.openCacheFolder"),
      ]),
    ],
  };
}

const HELP_MENU: TopLevelMenu = {
  id: "help",
  label: "Help",
  mnemonic: "H",
  items: [
    cmd("Welcome", "help.welcome"),
    cmd("Documentation", "help.documentation"),
    cmd("Show Release Notes", "help.releaseNotes"),
    cmd("Editor Playground", "help.editorPlayground"),
    cmd("Show All Commands", "workbench.commandPalette"),
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
    cmd("Show Logs", "help.showLogs"),
    cmd("Open Logs Folder", "help.openLogsFolder"),
    cmd("Toggle Developer Tools", "help.toggleDevTools"),
    cmd("Open Process Explorer", "help.processExplorer"),
    SEPARATOR,
    cmd("Check for Updates...", "help.checkForUpdates"),
    cmd("About OpenMind Studio", "help.about"),
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
  cmd("Open Settings (JSON)", "preferences.openSettingsJson"),
  cmd("Snippets", "preferences.configureSnippets"),
  cmd("Runtimes", "runtime.manage"),
  cmd("Language Tools", "lsp.manage"),
  cmd("Project & Language Status...", "language.showStatus"),
  cmd("AI Providers...", "ai.manageProviders"),
  cmd("Tasks", "tasks.configure"),
  sub("Themes", [
    cmd("Color Theme...", "preferences.colorTheme"),
    SEPARATOR,
    cmd("System", "theme.setSystem"),
    cmd("Dark", "theme.setDark"),
    cmd("Light", "theme.setLight"),
    cmd("High Contrast", "theme.setHighContrast"),
  ]),
];

/** The explorer title's "..." menu: which explorer sections are shown. */
export const EXPLORER_VIEWS_MENU: MenuEntry[] = [cmd("Open Editors", "explorer.toggleOpenEditors")];

export function buildMenuBar(
  recent: RecentEntries,
  context: Pick<MenuContext, "shells" | "projectCommands"> = { shells: [], projectCommands: [] },
): TopLevelMenu[] {
  return [
    fileMenu(recent),
    EDIT_MENU,
    SELECTION_MENU,
    VIEW_MENU,
    GO_MENU,
    runMenu(context.projectCommands),
    terminalMenu(context.shells),
    HELP_MENU,
  ];
}

/**
 * Drops every entry that would do nothing: a command that isn't registered, a submenu left with no entries, and
 * separators that would sit at the start, at the end or twice in a row. A registered command that is unavailable
 * right now is kept (it shows its reason).
 */
/** Commands whose entry is hidden (not shown disabled) while nothing registers them. */
export const HIDDEN_WHEN_UNREGISTERED: ReadonlySet<string> = new Set(["ai.openChat"]);

const UNBUILT: [RegExp, string][] = [
  [
    /^help\.(documentation|releaseNotes|editorPlayground|videoTutorials|tipsAndTricks|featureRequests|reportIssue|privacy|checkForUpdates)$/,
    "menu.unbuilt.noOnline",
  ],
  [
    /^help\.(toggleDevTools|processExplorer)$/,
    "menu.unbuilt.devTools",
  ],
  [
    /^tasks\.configureDefaultBuild$/,
    "menu.unbuilt.defaultBuild",
  ],
  [
    /^workspace\./,
    "menu.unbuilt.workspaces",
  ],
  [
    /^preferences\.productIconTheme$/,
    "menu.unbuilt.productIcons",
  ],
  [/^preferences\.onlineServices$/, "menu.unbuilt.onlineServices"],
  [
    /^preferences\.configureSnippets$/,
    "menu.unbuilt.snippets",
  ],
  [
    /^debug\.(newFunctionBreakpoint|newInlineBreakpoint|newTriggeredBreakpoint)$/,
    "menu.unbuilt.breakpointKinds",
  ],
  [
    /^editorLayout\./,
    "menu.unbuilt.editorLayout",
  ],
  [/^go\.(lastEditLocation|nextChange|previousChange)$/, "menu.unbuilt.notBuilt"],
  [
    /^go\.(nextUsedEditor|previousUsedEditor)$/,
    "menu.unbuilt.usedEditors",
  ],
  [
    /^search\.replaceInFiles$/,
    "menu.unbuilt.replaceInFiles",
  ],
  [/^emmet\./, "menu.unbuilt.emmet"],
  [/^workbench\.openView$/, "menu.unbuilt.openView"],
];

/** Why a menu entry whose command isn't registered is unavailable (in the UI language). */
export function unbuiltReason(command: string): string {
  return t(UNBUILT.find(([pattern]) => pattern.test(command))?.[1] ?? "menu.unbuilt.generic");
}

export function pruneMenuEntries(
  items: MenuEntry[],
  has: (command: string) => boolean,
): MenuEntry[] {
  const kept: MenuEntry[] = [];
  for (const item of items) {
    if (item.kind === "command") {
      if (has(item.command)) kept.push(item);
    } else if (item.kind === "submenu") {
      const inner = pruneMenuEntries(item.items, has);
      if (inner.length > 0) kept.push({ ...item, items: inner });
    } else if (kept.length > 0 && kept[kept.length - 1]?.kind !== "separator") {
      kept.push(item);
    }
  }
  while (kept[kept.length - 1]?.kind === "separator") kept.pop();
  return kept;
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

/** The Run > Project ... Commands entries from the language support's projects (only run/dev/build/test). */
export function projectMenuCommands(
  projects: {
    root: string;
    name: string;
    commandStatus: { id: string; label: string; category: string }[];
  }[],
): ProjectMenuCommand[] {
  const out: ProjectMenuCommand[] = [];
  for (const project of projects) {
    for (const command of project.commandStatus) {
      if (
        command.category === "run" ||
        command.category === "dev" ||
        command.category === "build" ||
        command.category === "test"
      ) {
        out.push({
          category: command.category,
          label: command.label,
          projectRoot: project.root,
          projectName: project.name,
          commandId: command.id,
        });
      }
    }
  }
  return out;
}
