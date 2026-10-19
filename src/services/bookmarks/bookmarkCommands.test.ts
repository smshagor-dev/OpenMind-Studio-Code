import { describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../commandRegistry";
import { registerBookmarkCommands } from "./bookmarkCommands";
import { BookmarkService, type Bookmark } from "./bookmarkService";

function setup(start: { path: string; line: number } | null = { path: "C:/p/a.ts", line: 3 }) {
  const commands = new CommandRegistry();
  const bookmarks = new BookmarkService({
    load: () => Promise.resolve([]),
    save: () => Promise.resolve(),
  });
  let here = start;
  const opened: Bookmark[] = [];
  const askLabel = vi.fn<(current: string) => Promise<string | null>>(() =>
    Promise.resolve("entry"),
  );
  const confirmClear = vi.fn<(count: number) => Promise<boolean>>(() => Promise.resolve(true));
  const showView = vi.fn(() => Promise.resolve());
  registerBookmarkCommands({
    commands,
    bookmarks,
    here: () => here,
    root: () => "C:/p",
    open: (bookmark) => {
      opened.push(bookmark);
      here = { path: bookmark.path, line: bookmark.line };
      return Promise.resolve();
    },
    showView,
    askLabel,
    confirmClear,
  });
  return {
    commands,
    bookmarks,
    opened,
    askLabel,
    confirmClear,
    showView,
    moveTo: (place: typeof here) => {
      here = place;
    },
  };
}

describe("bookmark commands", () => {
  it("toggles a bookmark on the cursor's line", async () => {
    const { commands, bookmarks } = setup();
    await commands.execute("bookmarks.toggle");
    expect(bookmarks.at("C:/p/a.ts", 3)).toBeDefined();
    await commands.execute("bookmarks.toggle");
    expect(bookmarks.at("C:/p/a.ts", 3)).toBeUndefined();
  });

  it("is disabled with a reason without a saved text file", () => {
    const { commands } = setup(null);
    expect(commands.isEnabled("bookmarks.toggle")).toBe(false);
    expect(commands.reasonFor("bookmarks.toggle")).toBe("Open a saved text file to use bookmarks.");
    expect(commands.reasonFor("bookmarks.jumpToNext")).toBe("There are no bookmarks in this folder.");
  });

  it("adds a labelled bookmark, edits its label, and does nothing when cancelled", async () => {
    const { commands, bookmarks, askLabel } = setup();
    await commands.execute("bookmarks.toggleLabeled");
    expect(bookmarks.at("C:/p/a.ts", 3)?.label).toBe("entry");
    askLabel.mockResolvedValueOnce("renamed");
    await commands.execute("bookmarks.toggleLabeled");
    expect(askLabel).toHaveBeenLastCalledWith("entry");
    expect(bookmarks.at("C:/p/a.ts", 3)?.label).toBe("renamed");
    askLabel.mockResolvedValueOnce(null);
    await commands.execute("bookmarks.toggleLabeled");
    expect(bookmarks.at("C:/p/a.ts", 3)?.label).toBe("renamed");
  });

  it("jumps to the next and previous bookmark in the open folder only", async () => {
    const { commands, bookmarks, opened } = setup();
    bookmarks.toggle("C:/p/a.ts", 10);
    bookmarks.toggle("C:/p/b.ts", 1);
    bookmarks.toggle("C:/other/c.ts", 5);
    await commands.execute("bookmarks.jumpToNext");
    await commands.execute("bookmarks.jumpToNext");
    await commands.execute("bookmarks.jumpToNext");
    expect(opened.map((b) => `${b.path}:${String(b.line)}`)).toEqual([
      "C:/p/a.ts:10",
      "C:/p/b.ts:1",
      "C:/p/a.ts:10",
    ]);
    await commands.execute("bookmarks.jumpToPrevious");
    expect(opened.at(-1)?.path).toBe("C:/p/b.ts");
  });

  it("clears the file's bookmarks and, after confirming, the folder's", async () => {
    const { commands, bookmarks, confirmClear } = setup();
    bookmarks.toggle("C:/p/a.ts", 1);
    bookmarks.toggle("C:/p/b.ts", 2);
    bookmarks.toggle("C:/other/c.ts", 5);
    await commands.execute("bookmarks.clearFile");
    expect(bookmarks.forFile("C:/p/a.ts")).toEqual([]);
    expect(commands.reasonFor("bookmarks.clearFile")).toBe("This file has no bookmarks.");
    confirmClear.mockResolvedValueOnce(false);
    await commands.execute("bookmarks.clearAll");
    expect(bookmarks.forFile("C:/p/b.ts")).toHaveLength(1);
    await commands.execute("bookmarks.clearAll");
    expect(confirmClear).toHaveBeenLastCalledWith(1);
    expect(bookmarks.getState().bookmarks.map((b) => b.path)).toEqual(["C:/other/c.ts"]);
  });

  it("shows the Bookmarks view", async () => {
    const { commands, showView } = setup();
    await commands.execute("bookmarks.list");
    expect(showView).toHaveBeenCalled();
  });
});
