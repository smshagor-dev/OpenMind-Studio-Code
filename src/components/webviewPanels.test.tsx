import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WebviewService } from "../services/webviewService";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { WebviewPanels } from "./WebviewPanels";

function mount(readResource = vi.fn().mockResolvedValue("data:image/png;base64,AAAA")) {
  const sent: [string, unknown][] = [];
  const webviews = new WebviewService({
    notifyHost: (method, params) => sent.push([method, params]),
    readResource,
  });
  harness.current = { extensions: { webviews } };
  render(<WebviewPanels />);
  const open = (n: number, extra: Record<string, unknown> = {}) => {
    const id = `t.sample#wv-${String(n)}`;
    webviews.handleEvent("webview/create", {
      extension: "t.sample",
      id,
      viewType: "x",
      title: `Panel ${String(n)}`,
      roots: [],
      ...extra,
    });
    return id;
  };
  return { webviews, sent, open };
}

beforeEach(() => {
  harness.current = null;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("WebviewPanels", () => {
  it("shows nothing without panels; a panel opens as a titled tab in a frame that has no same-origin and no scripts by default", async () => {
    const { webviews, open } = mount();
    expect(screen.queryByLabelText("Extension webviews")).toBeNull();
    const id = open(1);
    webviews.handleEvent("webview/html", { extension: "t.sample", id, html: "<h1>Hi</h1>" });
    expect(await screen.findByRole("tab", { name: /Panel 1/ })).toBeTruthy();
    const frame = await waitFor(() => {
      const el = document.querySelector("iframe.webview-frame");
      if (!(el instanceof HTMLIFrameElement)) throw new Error("no frame yet");
      expect(el.getAttribute("srcdoc")).toContain("Hi");
      return el;
    });
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("srcdoc")).toContain("script-src 'none'");
  });

  it("scripts get allow-scripts and only that: never allow-same-origin, top navigation or popups", async () => {
    const { webviews, open } = mount();
    const id = open(1, { enableScripts: true });
    webviews.handleEvent("webview/html", { extension: "t.sample", id, html: "<script>1</script>" });
    const frame = await waitFor(() => {
      const el = document.querySelector("iframe.webview-frame");
      if (!(el instanceof HTMLIFrameElement)) throw new Error("no frame yet");
      return el;
    });
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("same-origin");
    expect(frame.getAttribute("sandbox")).not.toContain("top-navigation");
    expect(frame.getAttribute("sandbox")).not.toContain("popups");
    await waitFor(() => {
      expect(document.querySelector("iframe")?.getAttribute("srcdoc")).toContain(
        "acquireVsCodeApi",
      );
    });
  });

  it("only a message from this frame with its token reaches the extension", async () => {
    const { webviews, sent, open } = mount();
    const id = open(1, { enableScripts: true });
    webviews.handleEvent("webview/html", { extension: "t.sample", id, html: "<p>x</p>" });
    const frame = await waitFor(() => {
      const el = document.querySelector("iframe.webview-frame");
      if (!(el instanceof HTMLIFrameElement)) throw new Error("no frame yet");
      expect(el.getAttribute("srcdoc")).toContain("acquireVsCodeApi");
      return el;
    });
    const token = /var token="([0-9a-f]+)"/.exec(frame.getAttribute("srcdoc") ?? "")?.[1] ?? "";
    expect(token).toHaveLength(32);
    const before = sent.length;
    // Wrong source (the app window itself), and right source with a wrong token: dropped.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { omWebview: token, type: "message", message: '{"a":1}' },
        source: window,
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { omWebview: "nope", type: "message", message: '{"a":1}' },
        source: frame.contentWindow,
      }),
    );
    expect(sent).toHaveLength(before);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { omWebview: token, type: "message", message: '{"a":1}' },
        source: frame.contentWindow,
      }),
    );
    expect(sent.at(-1)).toEqual(["host/webviewMessage", { id, message: '{"a":1}' }]);
  });

  it("closing a tab disposes the panel and tells the extension; the Editors button hides without closing", async () => {
    const { webviews, sent, open } = mount();
    const a = open(1);
    open(2);
    fireEvent.click(await screen.findByRole("button", { name: "Editors" }));
    expect(webviews.getState().panels).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Webviews \(2\)/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Webviews \(2\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Close Panel 1" }));
    expect(webviews.find(a)).toBeUndefined();
    expect(sent).toContainEqual(["host/webviewDisposed", { id: a }]);
    expect(screen.queryByRole("tab", { name: /Panel 1/ })).toBeNull();
  });

  it("shows a notice for blocked content and drops the panel when its extension goes", async () => {
    const { webviews, open } = mount();
    const id = open(1);
    webviews.handleEvent("webview/html", {
      extension: "t.sample",
      id,
      html: '<img src="https://example.com/a.png">',
    });
    expect(await screen.findByText(/Some content was blocked/)).toBeTruthy();
    expect(screen.getByText(/Remote content blocked: https:\/\/example.com\/a.png/)).toBeTruthy();
    webviews.keepOnly(new Set());
    await waitFor(() => {
      expect(screen.queryByLabelText("Extension webviews")).toBeNull();
    });
  });
});
