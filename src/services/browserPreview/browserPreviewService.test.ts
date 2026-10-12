import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import { OutputService } from "../outputService";
import type { BrowserIpc } from "./browserIpc";
import {
  BROWSER_CHANNEL,
  BrowserPreviewService,
  MAX_CONSOLE_ENTRIES,
  RELOAD_DELAY_MS,
} from "./browserPreviewService";

const TARGET = {
  origin: "http://127.0.0.1:5123",
  url: "http://127.0.0.1:5123/site/index.html",
  path: "/site/index.html",
  root: "C:\\Work\\My Project",
};

function rig(overrides: Partial<BrowserIpc> = {}) {
  const ipc: BrowserIpc = {
    livePreviewOpen: vi.fn().mockResolvedValue(TARGET),
    openExternalUrl: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const events = new EventBus<AppEvents>();
  const errors: string[] = [];
  events.on("appError", ({ message }) => errors.push(message));
  const output = new OutputService();
  const show = vi.fn();
  const service = new BrowserPreviewService(ipc, events, output, show);
  return { ipc, events, errors, output, show, service };
}

const message = (body: Record<string, unknown>) => ({ __openmind: "browser", ...body });

describe("BrowserPreviewService", () => {
  it("opens a file: asks the backend, shows the browser and starts a fresh console", async () => {
    const r = rig();
    expect(await r.service.open("C:/Work/My Project/site/index.html")).toBe(true);

    expect(r.ipc.livePreviewOpen).toHaveBeenCalledWith("C:/Work/My Project/site/index.html");
    expect(r.show).toHaveBeenCalledTimes(1);
    expect(r.service.getState()).toMatchObject({
      target: { ...TARGET, file: "C:/Work/My Project/site/index.html" },
      address: "/site/index.html",
      loading: true,
      loadToken: 1,
      src: TARGET.url,
      entries: [],
    });
    expect(r.output.getLines(BROWSER_CHANNEL)).toEqual([`[Browser] ${TARGET.url}`]);
  });

  it("a failure is shown and nothing opens", async () => {
    const r = rig({
      livePreviewOpen: vi.fn().mockRejectedValue("The file path must be absolute."),
    });
    expect(await r.service.open("index.html")).toBe(false);
    expect(r.show).not.toHaveBeenCalled();
    expect(r.errors[0]).toContain("The file path must be absolute.");
    expect(r.service.getState().target).toBeNull();
  });

  it("takes console lines, errors, clears and the page's address; ignores anything else", async () => {
    const r = rig();
    await r.service.open("C:/Work/My Project/site/index.html");

    r.service.receive(message({ type: "console", level: "log", text: "hello 42" }));
    r.service.receive(
      message({ type: "console", level: "error", text: "Uncaught ReferenceError: x" }),
    );
    r.service.receive(message({ type: "console", level: "warn", text: "careful" }));
    r.service.receive(message({ type: "console", level: "evil", text: "odd level" }));
    r.service.receive({ type: "console", text: "no marker" });
    r.service.receive("text");
    r.service.receive(null);

    const entries = r.service.getState().entries;
    expect(entries.map((entry) => [entry.level, entry.text])).toEqual([
      ["log", "hello 42"],
      ["error", "Uncaught ReferenceError: x"],
      ["warn", "careful"],
      ["log", "odd level"],
    ]);
    expect(r.service.counts()).toEqual({ errors: 1, warnings: 1 });
    expect(r.output.getLines(BROWSER_CHANNEL)).toContain("[error] Uncaught ReferenceError: x");

    r.service.receive(message({ type: "loaded", href: "/site/about.html#team", title: "About" }));
    expect(r.service.getState()).toMatchObject({
      address: "/site/about.html#team",
      title: "About",
      loading: false,
    });

    r.service.receive(message({ type: "clear" }));
    expect(r.service.getState().entries).toEqual([]);
  });

  it("keeps at most the newest console entries", async () => {
    const r = rig();
    await r.service.open("C:/Work/My Project/site/index.html");
    for (let i = 0; i < MAX_CONSOLE_ENTRIES + 5; i++) {
      r.service.receive(message({ type: "console", level: "log", text: String(i) }));
    }
    const entries = r.service.getState().entries;
    expect(entries).toHaveLength(MAX_CONSOLE_ENTRIES);
    expect(entries[0]?.text).toBe("5");
  });

  it("saving a file of the served folder reloads the page; other files don't", async () => {
    vi.useFakeTimers();
    const r = rig();
    await r.service.open("C:/Work/My Project/site/index.html");
    r.service.receive(message({ type: "console", level: "log", text: "before" }));

    r.events.emit("documentSaved", { id: "d", path: "C:/Work/Other/x.html" });
    r.events.emit("documentSaved", { id: "d", path: "C:/Work/My Project-2/x.css" });
    vi.advanceTimersByTime(RELOAD_DELAY_MS);
    expect(r.service.getState().loadToken).toBe(1);

    r.service.receive(message({ type: "location", href: "/site/about.htm" }));
    r.events.emit("documentSaved", { id: "d", path: "c:/work/my project/site/style.css" });
    // The watcher sees the same save: one reload, not two.
    r.service.noteDiskChanges(["C:/Work/My Project/site/style.css"], false);
    vi.advanceTimersByTime(RELOAD_DELAY_MS);
    expect(r.service.getState()).toMatchObject({
      loadToken: 2,
      loading: true,
      entries: [],
      src: "http://127.0.0.1:5123/site/about.htm",
    });
    vi.useRealTimers();
  });

  it("running a file right after its save loads the page once", async () => {
    vi.useFakeTimers();
    const r = rig();
    await r.service.open("C:/Work/My Project/site/index.html");
    r.events.emit("documentSaved", { id: "d", path: "C:/Work/My Project/site/index.html" });
    await r.service.open("C:/Work/My Project/site/index.html");
    vi.advanceTimersByTime(RELOAD_DELAY_MS);
    expect(r.service.getState().loadToken).toBe(2);
    vi.useRealTimers();
  });

  it("files changed on disk inside the folder reload the page; outside ones and no page do nothing", async () => {
    vi.useFakeTimers();
    const r = rig();
    r.service.noteDiskChanges(["C:/Work/My Project/a.css"], true);
    vi.advanceTimersByTime(RELOAD_DELAY_MS);
    expect(r.service.getState().loadToken).toBe(0);

    await r.service.open("C:/Work/My Project/site/index.html");
    r.service.noteDiskChanges(["C:/Elsewhere/a.css"], false);
    vi.advanceTimersByTime(RELOAD_DELAY_MS);
    expect(r.service.getState().loadToken).toBe(1);

    r.service.noteDiskChanges(
      ["C:/Work/My Project/scss/_vars.scss", "C:/Work/My Project/x.js"],
      false,
    );
    vi.advanceTimersByTime(RELOAD_DELAY_MS);
    expect(r.service.getState().loadToken).toBe(2);

    r.service.noteDiskChanges([], true);
    vi.advanceTimersByTime(RELOAD_DELAY_MS);
    expect(r.service.getState().loadToken).toBe(3);
    vi.useRealTimers();
  });

  it("reload, console toggle and opening the page in the user's browser", async () => {
    const r = rig();
    r.service.reload();
    expect(r.service.getState().loadToken).toBe(0);

    await r.service.open("C:/Work/My Project/site/index.html");
    r.service.receive(message({ type: "location", href: "/site/index.html#x" }));
    await r.service.openExternal();
    expect(r.ipc.openExternalUrl).toHaveBeenCalledWith("http://127.0.0.1:5123/site/index.html#x");

    r.service.toggleConsole();
    expect(r.service.getState().consoleOpen).toBe(false);
    r.service.frameLoaded();
    expect(r.service.getState().loading).toBe(false);
  });
});
