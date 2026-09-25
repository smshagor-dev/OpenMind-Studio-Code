import { describe, expect, it, vi } from "vitest";

import { MAX_MESSAGE_BYTES, MAX_PANELS, resourcePath, WebviewService } from "./webviewService";

function rig() {
  const sent: [string, unknown][] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  const readResource = vi.fn().mockResolvedValue("data:image/png;base64,AAAA");
  const service = new WebviewService({
    notifyHost: (method, params) => sent.push([method, params]),
    readResource,
    log: (line) => logs.push(line),
    onError: (message) => errors.push(message),
  });
  const create = (n = 1, extension = "t.sample", extra: Record<string, unknown> = {}) => {
    service.handleEvent("webview/create", {
      extension,
      id: `${extension}#wv-${String(n)}`,
      viewType: "x",
      title: `Panel ${String(n)}`,
      enableScripts: false,
      retain: false,
      roots: ["C:/ext"],
      ...extra,
    });
    return `${extension}#wv-${String(n)}`;
  };
  return { service, sent, errors, logs, readResource, create };
}

describe("WebviewService", () => {
  it("opens a panel as the active tab, with its title, scripts off unless asked, and the host told it is visible", () => {
    const { service, sent, create } = rig();
    const id = create();
    expect(service.getState().panels).toMatchObject([
      { id, title: "Panel 1", enableScripts: false, html: "" },
    ]);
    expect(service.getState().activeId).toBe(id);
    expect(sent.at(-1)).toEqual(["host/webviewViewState", { id, visible: true, active: true }]);
  });

  it("sets html and title, and only for the extension that owns the panel", () => {
    const { service, create } = rig();
    const id = create();
    service.handleEvent("webview/html", { extension: "t.sample", id, html: "<p>x</p>" });
    service.handleEvent("webview/title", { extension: "t.sample", id, title: "New" });
    expect(service.find(id)).toMatchObject({ html: "<p>x</p>", title: "New" });
    // Another extension can't touch it, and an id that doesn't start with the sender is ignored.
    service.handleEvent("webview/html", { extension: "evil.ext", id, html: "<p>evil</p>" });
    service.handleEvent("webview/create", {
      extension: "evil.ext",
      id: "t.sample#wv-9",
      viewType: "x",
      title: "spoof",
    });
    expect(service.find(id)?.html).toBe("<p>x</p>");
    expect(service.find("t.sample#wv-9")).toBeUndefined();
  });

  it("delivers extension messages to the page's listener and page messages to the host as JSON only", () => {
    const { service, sent, errors, create } = rig();
    const id = create();
    const toPage: [string, string][] = [];
    const off = service.onMessageToPage((panel, json) => toPage.push([panel, json]));
    service.handleEvent("webview/postMessage", {
      extension: "t.sample",
      id,
      message: '{"reply":1}',
    });
    service.handleEvent("webview/postMessage", {
      extension: "evil.ext",
      id,
      message: '{"reply":"stolen"}',
    });
    expect(toPage).toEqual([[id, '{"reply":1}']]);
    off();

    service.receive(id, '{"command":"ping"}');
    expect(sent.at(-1)).toEqual(["host/webviewMessage", { id, message: '{"command":"ping"}' }]);
    const count = sent.length;
    service.receive(id, "not json");
    service.receive("t.sample#wv-404", "{}");
    service.receive(id, JSON.stringify({ big: "x".repeat(MAX_MESSAGE_BYTES) }));
    expect(sent).toHaveLength(count);
    expect(errors.some((message) => message.includes("larger than 1 MB"))).toBe(true);
  });

  it("closing a tab tells the extension; the extension disposing does not echo back", () => {
    const { service, sent, create } = rig();
    const a = create(1);
    const b = create(2);
    service.close(b);
    expect(sent).toContainEqual(["host/webviewDisposed", { id: b }]);
    expect(service.getState().activeId).toBe(a);
    const count = sent.filter(([m]) => m === "host/webviewDisposed").length;
    service.handleEvent("webview/dispose", { extension: "t.sample", id: a });
    expect(service.getState().panels).toEqual([]);
    expect(sent.filter(([m]) => m === "host/webviewDisposed")).toHaveLength(count);
  });

  it("disabling an extension removes its panels, a host restart removes all, and too many panels are refused", () => {
    const { service, sent, errors, create } = rig();
    const mine = create(1, "t.sample");
    create(1, "other.ext");
    service.keepOnly(new Set(["other.ext"]));
    expect(service.find(mine)).toBeUndefined();
    expect(service.getState().panels.map((p) => p.extension)).toEqual(["other.ext"]);
    service.handleEvent("webview/reset", {});
    expect(service.getState()).toMatchObject({ panels: [], activeId: null });

    for (let n = 1; n <= MAX_PANELS; n += 1) create(n, "many.ext");
    create(MAX_PANELS + 1, "many.ext");
    expect(service.getState().panels).toHaveLength(MAX_PANELS);
    expect(errors[0]).toContain("more than 20 webview panels");
    expect(sent.at(-1)).toEqual([
      "host/webviewDisposed",
      { id: `many.ext#wv-${String(MAX_PANELS + 1)}` },
    ]);
  });

  it("the Editors button hides the panels without closing them, and revealing brings one back", () => {
    const { service, sent, create } = rig();
    const a = create(1);
    create(2);
    service.hideOverlay();
    expect(service.getState().overlay).toBe(false);
    expect(service.getState().panels).toHaveLength(2);
    expect(sent.at(-1)).toMatchObject(["host/webviewViewState", { visible: false, active: false }]);
    service.handleEvent("webview/reveal", { extension: "t.sample", id: a });
    expect(service.getState()).toMatchObject({ overlay: true, activeId: a });
  });

  it("reads local resources through the backend with the panel's own roots, decoding the address", async () => {
    const { service, readResource, create } = rig();
    const id = create(1, "t.sample", { roots: ["C:/ext", "C:/more"] });
    const encoded = btoa("C:/ext/media/logo.png")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const uri = `openmind-webview-resource://panel/${encoded}`;
    expect(resourcePath(uri)).toBe("C:/ext/media/logo.png");
    await expect(service.readResource(id, uri)).resolves.toContain("data:image/png");
    expect(readResource).toHaveBeenCalledWith("t.sample", "C:/ext/media/logo.png", [
      "C:/ext",
      "C:/more",
    ]);
    await expect(service.readResource(id, "https://x.test/a.png")).rejects.toThrow(
      "Not a webview resource address",
    );
    await expect(service.readResource("t.sample#wv-404", uri)).rejects.toThrow("closed");
    expect(resourcePath("openmind-webview-resource://panel/../../etc")).toBeNull();
  });

  it("logs what the sanitizer blocked once per change", () => {
    const { service, logs, create } = rig();
    const id = create();
    service.recordBlocked(id, ["Remote content blocked: https://x.test/a.png"]);
    service.recordBlocked(id, ["Remote content blocked: https://x.test/a.png"]);
    expect(logs).toEqual([
      '[t.sample] webview "Panel 1": Remote content blocked: https://x.test/a.png',
    ]);
    expect(service.find(id)?.blocked).toHaveLength(1);
  });
});
