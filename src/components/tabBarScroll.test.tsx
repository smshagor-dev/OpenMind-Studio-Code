import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EditorTabView } from "../services/workspaceService";
import { TabBar } from "./TabBar";

// The collaboration dots read the app's live services; these tests are about the component alone.
vi.mock("./collab/CollabDots", () => ({ CollabDots: () => null }));

/** jsdom has no layout: every tab is TAB px wide, placed by its index; the row is `rowWidth` wide. */
const TAB = 120;
let rowWidth = 300;
const scrolls = new WeakMap<Element, number>();
let resize: (() => void) | null = null;

function isRow(element: Element): boolean {
  return element.classList.contains("tab-bar");
}

function tabIndex(element: Element): number {
  return [...(element.parentElement?.children ?? [])].filter((child) => child.classList.contains("tab")).indexOf(element);
}

beforeEach(() => {
  rowWidth = 300;
  resize = null;
  const define = (name: string, get: (this: HTMLElement) => number, set?: (this: HTMLElement, value: number) => void) => {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get, set });
  };
  define("offsetLeft", function () {
    return this.classList.contains("tab") ? tabIndex(this) * TAB : 0;
  });
  define("offsetWidth", function () {
    return this.classList.contains("tab") ? TAB : 0;
  });
  define("clientWidth", function () {
    return isRow(this) ? rowWidth : 0;
  });
  define("scrollWidth", function () {
    return isRow(this) ? this.querySelectorAll(".tab").length * TAB : 0;
  });
  define(
    "scrollLeft",
    function () {
      return scrolls.get(this) ?? 0;
    },
    function (value) {
      const max = isRow(this) ? Math.max(0, this.querySelectorAll(".tab").length * TAB - rowWidth) : 0;
      scrolls.set(this, Math.min(Math.max(0, value), max));
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const name of ["offsetLeft", "offsetWidth", "clientWidth", "scrollWidth", "scrollLeft"]) {
    Reflect.deleteProperty(HTMLElement.prototype, name);
  }
});

const NAMES = [
  "streams.f90",
  "main program.f90",
  "deep run.f90",
  "input.f90",
  "input.pas",
  "args.f90",
  "args.pas",
  "hello.f90",
  "hello.pas",
  "constants.f90",
  "report.f90",
  "shapes.f90",
];

function tabs(count = NAMES.length): EditorTabView[] {
  return NAMES.slice(0, count).map(
    (title) =>
      ({
        id: title,
        docId: title,
        title,
        path: `C:/w/${title}`,
        dirty: false,
        kind: "text",
        preview: false,
        external: "none",
      }) as unknown as EditorTabView,
  );
}

function bar(props: Partial<Parameters<typeof TabBar>[0]> = {}) {
  const handlers = { onSelect: vi.fn(), onClose: vi.fn(), onKeepOpen: vi.fn() };
  const element = <TabBar tabs={tabs()} activeId="streams.f90" {...handlers} {...props} />;
  const view = render(element);
  const row = screen.getByRole("tablist");
  return { ...view, ...handlers, row };
}

describe("editor tab row scrolling", () => {
  it("scrolls sideways with the wheel when the tabs overflow, without letting the page scroll", () => {
    const { row } = bar();
    expect(row.scrollWidth).toBeGreaterThan(row.clientWidth);
    const notPrevented = fireEvent.wheel(row, { deltaY: 100 });
    expect(notPrevented).toBe(false);
    expect(row.scrollLeft).toBe(100);
    fireEvent.wheel(row, { deltaY: -40 });
    expect(row.scrollLeft).toBe(60);
  });

  it("moves once (not twice) for Shift+wheel and a trackpad's sideways swipe, and stops at the ends", () => {
    const { row } = bar();
    fireEvent.wheel(row, { deltaY: 50, shiftKey: true });
    expect(row.scrollLeft).toBe(50);
    fireEvent.wheel(row, { deltaX: 30, deltaY: 2 });
    expect(row.scrollLeft).toBe(80);
    fireEvent.wheel(row, { deltaY: -10_000 });
    expect(row.scrollLeft).toBe(0);
    fireEvent.wheel(row, { deltaY: 10_000 });
    expect(row.scrollLeft).toBe(NAMES.length * TAB - rowWidth);
  });

  it("leaves the wheel alone when everything fits, and when Ctrl is held (zoom)", () => {
    const { row } = bar({ tabs: tabs(2) });
    expect(fireEvent.wheel(row, { deltaY: 100 })).toBe(true);
    expect(row.scrollLeft).toBe(0);
    cleanup();
    const overflowing = bar().row;
    expect(fireEvent.wheel(overflowing, { deltaY: 100, ctrlKey: true })).toBe(true);
    expect(overflowing.scrollLeft).toBe(0);
  });

  it("shows the active tab when a session is restored with a tab past the edge", () => {
    const { row } = bar({ activeId: "shapes.f90" });
    expect(row.scrollLeft).toBe(NAMES.length * TAB - rowWidth);
  });

  it("reveals a hidden tab when it becomes active (a click, a shortcut, Go to File, the Explorer)", () => {
    const { row, rerender, onSelect, onClose, onKeepOpen } = bar();
    expect(row.scrollLeft).toBe(0);
    rerender(<TabBar tabs={tabs()} activeId="hello.pas" {...{ onSelect, onClose, onKeepOpen }} />);
    expect(row.scrollLeft).toBe(9 * TAB - rowWidth);
    // Back to the first tab: scrolled to the start again; an already visible tab doesn't move the row.
    rerender(<TabBar tabs={tabs()} activeId="streams.f90" {...{ onSelect, onClose, onKeepOpen }} />);
    expect(row.scrollLeft).toBe(0);
    rerender(<TabBar tabs={tabs()} activeId="main program.f90" {...{ onSelect, onClose, onKeepOpen }} />);
    expect(row.scrollLeft).toBe(0);
  });

  it("reveals a newly opened file's tab", () => {
    const { row, rerender, onSelect, onClose, onKeepOpen } = bar({ tabs: tabs(3), activeId: "deep run.f90" });
    expect(row.scrollLeft).toBe(60);
    rerender(<TabBar tabs={tabs()} activeId="shapes.f90" {...{ onSelect, onClose, onKeepOpen }} />);
    expect(row.scrollLeft).toBe(NAMES.length * TAB - rowWidth);
  });

  it("keeps the active tab in view when the window or group gets narrower", () => {
    const { row } = bar({ activeId: "input.f90" });
    expect(row.scrollLeft).toBe(4 * TAB - 300);
    rowWidth = 150;
    resize?.();
    expect(row.scrollLeft).toBe(4 * TAB - 150);
  });

  it("keeps selecting, closing, middle-click closing and keeping a preview open working", () => {
    const { onSelect, onClose } = bar();
    const tab = screen.getByRole("tab", { name: /hello\.pas/ });
    fireEvent.mouseDown(tab, { button: 0 });
    expect(onSelect).toHaveBeenCalledWith("hello.pas");
    fireEvent.click(screen.getByRole("button", { name: /hello\.pas/ }));
    expect(onClose).toHaveBeenCalledWith("hello.pas");
    fireEvent(tab, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(onClose).toHaveBeenCalledTimes(2);
    // Scrolling never selects or closes anything.
    fireEvent.wheel(screen.getByRole("tablist"), { deltaY: 200 });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("editor header layout", () => {
  const css = readFileSync(join(process.cwd(), "src/styles/editor.css"), "utf8");

  it("scrolls only the tab row: the editor actions beside it keep their place", () => {
    expect(css).toMatch(/\.editor-group__header > \.tab-bar \{\s*flex: 1 1 auto;\s*min-width: 0;/);
    expect(css).toMatch(/\.editor-header-actions \{\s*flex: 0 0 auto;/);
  });

  it("has no visible scrollbar (the header keeps its height) and never scrolls the page past its ends", () => {
    const rule = /\.tab-bar \{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(rule).toMatch(/overflow-x: auto;/);
    expect(rule).toMatch(/scrollbar-width: none;/);
    expect(rule).toMatch(/overscroll-behavior: contain;/);
    expect(rule).toMatch(/position: relative;/);
    expect(css).toMatch(/\.tab-bar::-webkit-scrollbar \{\s*display: none;/);
  });
});

describe("one row of tabs", () => {
  it("puts a leading tab (the Welcome page's) first in the same row as the file tabs", () => {
    const { container } = bar({
      tabs: tabs(2),
      activeId: null,
      leading: (
        <div className="tab tab--welcome" role="tab" aria-selected>
          Welcome
        </div>
      ),
    });
    expect(container.querySelectorAll(".tab-bar")).toHaveLength(1);
    expect(container.querySelectorAll(".tab-bar__filler")).toHaveLength(1);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent.trim())).toEqual([
      "Welcome",
      "streams.f90",
      "main program.f90",
    ]);
  });

  it("is how the editor group shows the Welcome tab beside open files", () => {
    const source = readFileSync(join(process.cwd(), "src/components/EditorGroupView.tsx"), "utf8");
    expect(source).toContain("leading={welcomeTab ? <WelcomeTab active /> : null}");
    expect(source).not.toMatch(/\{welcomeTab \? <WelcomeTab \/> : null\}/);
    const welcome = readFileSync(join(process.cwd(), "src/components/WelcomeEditor.tsx"), "utf8");
    expect(welcome).not.toContain('className="tab-bar"');
  });
});
