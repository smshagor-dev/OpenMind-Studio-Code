import type { CommandRegistry } from "../commandRegistry";
import { t } from "../../i18n";
import { neighbour, type Bookmark, type BookmarkService } from "./bookmarkService";

export interface BookmarkCommandDeps {
  commands: CommandRegistry;
  bookmarks: BookmarkService;
  /** The saved file of the active text tab and the cursor's line, or `null` (no editor, untitled, a preview). */
  here: () => { path: string; line: number } | null;
  /** The open folder (bookmarks outside it are not navigated), or `null`. */
  root: () => string | null;
  open: (bookmark: Bookmark) => Promise<void>;
  showView: () => Promise<void>;
  askLabel: (current: string) => Promise<string | null>;
  confirmClear: (count: number) => Promise<boolean>;
}

/** Registers the Bookmarks commands (Go > Bookmarks, their shortcuts and the palette). */
export function registerBookmarkCommands(deps: BookmarkCommandDeps): void {
  const { commands, bookmarks } = deps;
  const needFile = {
    enabled: () => deps.here() !== null,
    disabledReason: () => (deps.here() === null ? t("bookmarks.reason.noFile") : undefined),
  };
  const scoped = () => bookmarks.scoped(deps.root());
  const needAny = {
    enabled: () => scoped().length > 0,
    disabledReason: () => (scoped().length > 0 ? undefined : t("bookmarks.reason.none")),
  };

  commands.register(
    "bookmarks.toggle",
    () => {
      const here = deps.here();
      if (here) bookmarks.toggle(here.path, here.line);
    },
    needFile,
  );
  commands.register(
    "bookmarks.toggleLabeled",
    async () => {
      const here = deps.here();
      if (!here) return;
      const existing = bookmarks.at(here.path, here.line);
      const label = await deps.askLabel(existing?.label ?? "");
      if (label === null) return;
      if (existing) bookmarks.setLabel(existing.id, label);
      else bookmarks.toggle(here.path, here.line, label);
    },
    needFile,
  );
  const jump = async (direction: 1 | -1) => {
    const target = neighbour(scoped(), deps.here(), direction);
    if (target) await deps.open(target);
  };
  commands.register("bookmarks.jumpToNext", () => jump(1), needAny);
  commands.register("bookmarks.jumpToPrevious", () => jump(-1), needAny);
  commands.register("bookmarks.list", () => deps.showView());
  commands.register(
    "bookmarks.clearFile",
    () => {
      const here = deps.here();
      if (here) bookmarks.clearFile(here.path);
    },
    {
      enabled: () => {
        const here = deps.here();
        return here !== null && bookmarks.forFile(here.path).length > 0;
      },
      disabledReason: () => {
        const here = deps.here();
        if (here === null) return t("bookmarks.reason.noFile");
        return bookmarks.forFile(here.path).length > 0 ? undefined : t("bookmarks.reason.noneInFile");
      },
    },
  );
  commands.register(
    "bookmarks.clearAll",
    async () => {
      const count = scoped().length;
      if (count > 0 && (await deps.confirmClear(count))) bookmarks.clearScope(deps.root());
    },
    needAny,
  );
}
