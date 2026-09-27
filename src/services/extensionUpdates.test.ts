import { describe, expect, it, vi } from "vitest";

import { createFakeMarketplaceApi, marketDetails } from "../testUtils/fakeMarketplaceApi";
import { ExtensionMarketplaceService, isNewerVersion, type InstalledForUpdate } from "./extensionMarketplaceService";

function service(
  installed: InstalledForUpdate[],
  api = createFakeMarketplaceApi(),
  autoFetch = false,
  startup = { finished: true },
) {
  const install = vi.fn().mockResolvedValue(undefined);
  const market = new ExtensionMarketplaceService(api, {
    install,
    onError: () => undefined,
    autoFetch: () => autoFetch,
    installed: () => installed,
    startupFinished: () => startup.finished,
  });
  return { api, market, install };
}

const yaml: InstalledForUpdate = { id: "redhat.vscode-yaml", publisher: "redhat", name: "vscode-yaml", version: "1.0.0" };
const local: InstalledForUpdate = { id: "local.sample", publisher: "local", name: "sample", version: "0.1.0" };

describe("extension update check", () => {
  it("compares versions numerically, pre-releases before their release", () => {
    expect(isNewerVersion("1.10.0", "1.9.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("0.9.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0.0-beta")).toBe(true);
    expect(isNewerVersion("1.0.0-beta", "1.0.0")).toBe(false);
    expect(isNewerVersion("v2", "1.5")).toBe(true);
  });

  it("asks nothing when started with auto-load off", () => {
    const { api, market } = service([yaml]);
    market.start();
    expect(api.details).not.toHaveBeenCalled();
    expect(market.getState().updatesCheckedAt).toBeNull();
  });

  it("checks when the view opens with auto-load on", async () => {
    const api = createFakeMarketplaceApi({
      details: vi.fn().mockResolvedValue(marketDetails({ namespace: "redhat", name: "vscode-yaml", version: "1.2.0" })),
    });
    const { market } = service([yaml], api, true);
    market.start();
    await vi.waitFor(() => {
      expect(market.getState().updates).toHaveLength(1);
    });
  });

  it("fetches nothing for a view restored at launch; the next time the user opens it, it loads", () => {
    const startup = { finished: false };
    const { api, market } = service([yaml], createFakeMarketplaceApi(), true, startup);
    market.start();
    expect(api.details).not.toHaveBeenCalled();
    expect(api.search).not.toHaveBeenCalled();
    startup.finished = true;
    market.start();
    expect(api.details).toHaveBeenCalledTimes(1);
    expect(api.search).toHaveBeenCalled();
  });

  it("lists newer versions with both versions, skips local extensions and downloads nothing", async () => {
    const api = createFakeMarketplaceApi({
      details: vi.fn().mockResolvedValue(marketDetails({ namespace: "redhat", name: "vscode-yaml", version: "1.2.0" })),
    });
    const { market, install } = service([yaml, local], api);
    await market.checkUpdates();
    expect(api.details).toHaveBeenCalledTimes(1);
    expect(api.details).toHaveBeenCalledWith("redhat", "vscode-yaml");
    expect(api.download).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(market.getState().updates).toEqual([
      { id: "redhat.vscode-yaml", namespace: "redhat", name: "vscode-yaml", current: "1.0.0", latest: "1.2.0" },
    ]);
    expect(market.updateFor("redhat.vscode-yaml")?.latest).toBe("1.2.0");
  });

  it("reports no update for the same version and an error only when every lookup failed", async () => {
    const same = createFakeMarketplaceApi({
      details: vi.fn().mockResolvedValue(marketDetails({ namespace: "redhat", name: "vscode-yaml", version: "1.0.0" })),
    });
    const a = service([yaml], same);
    await a.market.checkUpdates();
    expect(a.market.getState().updates).toEqual([]);
    expect(a.market.getState().updateError).toBeNull();
    expect(a.market.getState().updatesCheckedAt).not.toBeNull();

    const down = createFakeMarketplaceApi({ details: vi.fn().mockRejectedValue(new Error("offline")) });
    const b = service([yaml], down);
    await b.market.checkUpdates();
    expect(b.market.getState().updates).toEqual([]);
    expect(b.market.getState().updateError).toMatch(/couldn't be reached/);
    expect(b.market.getState().checkingUpdates).toBe(false);
  });
});
