import type { CommandRegistry } from "./commandRegistry";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { LayoutService, SideView } from "./layoutService";
import type { OutputService } from "./outputService";
import type { PanelService, PanelTab } from "./panelService";
import type { SearchService } from "./searchService";

export interface ViewCommandDeps {
  commands: CommandRegistry;
  events: EventBus<AppEvents>;
  layout: LayoutService;
  panel: PanelService;
  output: OutputService;
  search: SearchService;
}

/** Side bar views and the command that shows each. Explorer/Search do real work; the rest are honest empty states. */
const SIDE_VIEW_COMMANDS: readonly [string, SideView][] = [
  ["view.showExplorer", "explorer"],
  ["view.showSearch", "search"],
  ["view.showSourceControl", "scm"],
  ["view.showRun", "debug"],
  ["view.showExtensions", "extensions"],
  ["view.showPhpServer", "php"],
];

const PANEL_TAB_COMMANDS: readonly [string, PanelTab][] = [
  ["view.showProblems", "problems"],
  ["view.showOutput", "output"],
  ["view.showDebugConsole", "debugConsole"],
  ["view.showPorts", "ports"],
];

/**
 * Commands that move around the workbench shell: which side bar view is
 * showing, which bottom-panel tab, panel visibility, Find in Files. The
 * Terminal tab's own commands (`terminal.toggle`, `terminal.new`) live with the
 * terminal because they also start sessions.
 */
export function registerViewCommands(deps: ViewCommandDeps): void {
  const { commands, events, layout, panel, output, search } = deps;

  for (const [id, view] of SIDE_VIEW_COMMANDS) {
    commands.register(id, async () => {
      await layout.showView(view);
      if (view === "explorer") events.emit("focusExplorer", undefined);
    });
  }

  commands.register("search.findInFiles", async () => {
    await layout.showView("search");
    events.emit("focusSearch", undefined);
  });
  commands.register("search.clear", () => {
    search.clear();
  });
  commands.register(
    "search.cancel",
    () => {
      search.cancel();
    },
    { enabled: () => search.getState().status === "searching" },
  );

  commands.register("view.togglePanel", () => panel.toggle(), {
    checked: () => panel.getState().visible,
  });
  for (const [id, tab] of PANEL_TAB_COMMANDS) {
    commands.register(id, () => panel.show(tab));
  }
  commands.register("output.clear", () => {
    output.clear(output.getState().selected);
  });
}
