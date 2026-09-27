import { describe, expect, it, vi } from "vitest";

import { panelsOf, WebviewService } from "./webviewService";

function rig() {
  const sent: [string, unknown][] = [];
  const service = new WebviewService({
    notifyHost: (method, params) => sent.push([method, params]),
    readResource: vi.fn().mockResolvedValue("data:,"),
  });
  const reveal = vi.fn();
  service.onRevealView(reveal);
  return { service, sent, reveal };
}

const view = (extra: Record<string, unknown> = {}) => ({
  extension: "pub.ext",
  id: "pub.ext#wv-1",
  placement: "view",
  view: "pub.panel",
  viewType: "pub.panel",
  title: "Panel",
  enableScripts: true,
  retain: false,
  roots: [],
  ...extra,
});

describe("WebviewService views (WebviewView)", () => {
  it("records providers per view and forgets them when unregistered", () => {
    const { service } = rig();
    service.handleEvent("webview/viewProvider", { extension: "pub.ext", view: "pub.panel", registered: true });
    expect(service.hasProvider("pub.panel")).toBe(true);
    service.handleEvent("webview/viewProvider", { extension: "pub.ext", view: "pub.panel", registered: false });
    expect(service.hasProvider("pub.panel")).toBe(false);
  });

  it("puts a view in the side bar: no overlay, not among the panels, one per view", () => {
    const { service, sent } = rig();
    service.handleEvent("webview/create", view());
    service.handleEvent("webview/create", view({ id: "pub.ext#wv-2" }));
    expect(service.viewFor("pub.panel")?.id).toBe("pub.ext#wv-1");
    expect(panelsOf(service.getState())).toEqual([]);
    expect(service.getState().activeId).toBeNull();
    expect(sent).toEqual([]);
  });

  it("tells the host about visibility, takes a description and reveals its container", () => {
    const { service, sent, reveal } = rig();
    service.handleEvent("webview/create", view());
    service.setViewVisible("pub.ext#wv-1", true);
    expect(sent).toEqual([["host/webviewViewState", { id: "pub.ext#wv-1", visible: true, active: true }]]);
    service.handleEvent("webview/description", { extension: "pub.ext", id: "pub.ext#wv-1", description: "3 items" });
    expect(service.viewFor("pub.panel")?.description).toBe("3 items");
    service.handleEvent("webview/revealView", { extension: "pub.ext", id: "pub.ext#wv-1" });
    expect(reveal).toHaveBeenCalledWith("pub.panel");
    // Another extension can't reveal or change it.
    service.handleEvent("webview/description", { extension: "evil.ext", id: "pub.ext#wv-1", description: "x" });
    expect(service.viewFor("pub.panel")?.description).toBe("3 items");
  });

  it("goes when the host resets", () => {
    const { service } = rig();
    service.handleEvent("webview/create", view());
    service.handleEvent("webview/reset", {});
    expect(service.viewFor("pub.panel")).toBeUndefined();
  });
});
