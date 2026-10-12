import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BrowserState } from "../services/browserPreview/browserPreviewService";
import type { SecondarySideBarState } from "../services/secondarySideBarService";

/** Small observable stores standing in for the services the side bar reads. */
function store<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (patch: Partial<T>) => {
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    },
  };
}

const bar = store<SecondarySideBarState>({
  visible: true,
  half: true,
  width: 420,
  channel: "Run Code",
  view: "browser",
});
const browser = store<BrowserState>({
  target: {
    origin: "http://127.0.0.1:5000",
    url: "http://127.0.0.1:5000/index.html",
    path: "/index.html",
    root: "C:/site",
    file: "C:/site/index.html",
  },
  address: "/index.html",
  title: "Home",
  loading: false,
  loadToken: 1,
  src: "http://127.0.0.1:5000/index.html",
  entries: [],
  consoleOpen: true,
});
const output = store({ channels: ["Run Code"] });
const LINES = ["line one"];

vi.mock("../services/container", () => ({
  container: {
    keybindings: { labelFor: () => "Ctrl+F5" },
    secondarySideBar: {
      ...bar,
      setView: (view: SecondarySideBarState["view"]) => {
        bar.set({ view });
        return Promise.resolve();
      },
      setChannel: () => Promise.resolve(),
      hide: () => Promise.resolve(),
      previewWidth: () => undefined,
      commitWidth: () => Promise.resolve(),
    },
    output: { ...output, getLines: () => LINES, clear: () => undefined },
    browser: {
      ...browser,
      counts: () => ({ errors: 0, warnings: 0 }),
      receive: () => undefined,
      reload: () => undefined,
      toggleConsole: () => undefined,
      clearConsole: () => undefined,
      frameLoaded: () => undefined,
      openExternal: () => Promise.resolve(),
    },
  },
}));

const { SecondarySideBar } = await import("./SecondarySideBar");

describe("SecondarySideBar with the built-in browser", () => {
  it("switching to Output and back keeps the same page (only hidden), so what was typed into it stays", () => {
    render(<SecondarySideBar onLeft={false} />);
    const frame = screen.getByTitle("Home");
    expect(frame.closest(".browser-view")?.hasAttribute("hidden")).toBe(false);

    fireEvent.click(screen.getByRole("tab", { name: "Output" }));
    expect(screen.getByText("line one")).toBeTruthy();
    expect(screen.getByTitle("Home")).toBe(frame);
    expect(frame.closest(".browser-view")?.hasAttribute("hidden")).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: "Browser" }));
    expect(screen.getByTitle("Home")).toBe(frame);
    expect(frame.closest(".browser-view")?.hasAttribute("hidden")).toBe(false);
    expect(screen.queryByText("line one")).toBeNull();
  });

  it("without a page there are no tabs and nothing of the browser", () => {
    act(() => {
      browser.set({ target: null });
      bar.set({ view: "output" });
    });
    render(<SecondarySideBar onLeft={false} />);
    expect(screen.queryByRole("tab")).toBeNull();
    expect(document.querySelector(".browser-view")).toBeNull();
  });
});
