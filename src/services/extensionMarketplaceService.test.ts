import { describe, expect, it, vi } from "vitest";

import { createFakeMarketplaceApi, marketItem } from "../testUtils/fakeMarketplaceApi";
import { ExtensionMarketplaceService, formatCount, marketId } from "./extensionMarketplaceService";
import type { MarketPage } from "./marketplaceIpc";

function service(api = createFakeMarketplaceApi()) {
  const install = vi.fn().mockResolvedValue(undefined);
  const errors: string[] = [];
  const market = new ExtensionMarketplaceService(api, {
    install,
    onError: (message) => errors.push(message),
  });
  return { api, market, install, errors };
}

function page(names: string[], total = names.length): MarketPage {
  return {
    total,
    offset: 0,
    items: names.map((name) => marketItem({ namespace: "pub", name, displayName: name })),
  };
}

describe("ExtensionMarketplaceService", () => {
  it("formats install counts like VS Code", () => {
    expect(formatCount(950)).toBe("950");
    expect(formatCount(1_234)).toBe("1.2K");
    expect(formatCount(86_528_511)).toBe("86.5M");
    expect(formatCount(59_099_659)).toBe("59.1M");
    expect(formatCount(2_000_000)).toBe("2M");
    expect(formatCount(1_500_000_000)).toBe("1.5B");
    expect(marketId("MS-Python", "Python")).toBe("ms-python.python");
  });

  it("an empty search lists by install count; a query by relevance, or the chosen sort", async () => {
    const { api, market } = service();
    market.start();
    market.start();
    await vi.waitFor(() => {
      expect(market.getState().items).toHaveLength(1);
    });
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(api.search).toHaveBeenCalledWith("", "installs", 0, 30);

    vi.useFakeTimers();
    market.setQuery("py");
    market.setQuery("python");
    await vi.advanceTimersByTimeAsync(350);
    vi.useRealTimers();
    expect(api.search).toHaveBeenLastCalledWith("python", "relevance", 0, 30);
    expect(api.search).toHaveBeenCalledTimes(2);

    await market.setSort("rating");
    expect(api.search).toHaveBeenLastCalledWith("python", "rating", 0, 30);
  });

  it("keeps only the newest answer when searches overlap", async () => {
    let finishOld: (value: MarketPage) => void = () => undefined;
    const api = createFakeMarketplaceApi({
      search: vi
        .fn()
        .mockReturnValueOnce(new Promise<MarketPage>((resolve) => (finishOld = resolve)))
        .mockResolvedValueOnce(page(["new"])),
    });
    const { market } = service(api);
    const old = market.refresh();
    await market.refresh();
    finishOld(page(["old"]));
    await old;
    expect(market.getState().items.map((i) => i.name)).toEqual(["new"]);
  });

  it("loads more pages without duplicates and stops at the total", async () => {
    const api = createFakeMarketplaceApi({
      search: vi
        .fn()
        .mockResolvedValueOnce(page(["a", "b"], 3))
        .mockResolvedValueOnce(page(["b", "c"], 3)),
    });
    const { market } = service(api);
    await market.refresh();
    expect(market.hasMore()).toBe(true);
    await market.loadMore();
    expect(market.getState().items.map((i) => i.name)).toEqual(["a", "b", "c"]);
    expect(api.search).toHaveBeenLastCalledWith("", "installs", 2, 30);
    expect(market.hasMore()).toBe(false);
    await market.loadMore();
    expect(api.search).toHaveBeenCalledTimes(2);
  });

  it("reports a failed search in its state", async () => {
    const { market } = service(
      createFakeMarketplaceApi({ search: vi.fn().mockRejectedValue("offline") }),
    );
    await market.refresh();
    expect(market.getState()).toMatchObject({ items: [], loading: false, error: "offline" });
  });

  it("opens a page with the README, fetches the changelog on its tab, and closes", async () => {
    const { api, market } = service();
    await market.openPage("ms-python", "python", null);
    expect(market.getState().page).toMatchObject({
      loading: false,
      readme: "# Python\n\nThe README.",
      tab: "details",
    });
    await market.setTab("changelog");
    expect(api.text).toHaveBeenLastCalledWith(
      "https://open-vsx.org/api/ms-python/python/2026.4.0/file/CHANGELOG.md",
    );
    await market.setTab("details");
    expect(api.text).toHaveBeenCalledTimes(2);
    market.closePage();
    expect(market.getState().page).toBeNull();
  });

  it("an installed extension that isn't on Open VSX gets a page with the reason", async () => {
    const { market } = service(
      createFakeMarketplaceApi({ details: vi.fn().mockRejectedValue("a.b isn't on Open VSX.") }),
    );
    await market.openPage("a", "b", "a.b");
    expect(market.getState().page).toMatchObject({
      installedId: "a.b",
      details: null,
      error: "a.b isn't on Open VSX.",
    });
  });

  it("installs: download, then the trust flow; a failure is reported and nothing stays busy", async () => {
    const { api, market, install, errors } = service();
    await market.install("ms-python", "python");
    expect(api.download).toHaveBeenCalledWith("ms-python", "python");
    expect(install).toHaveBeenCalledWith("C:/app/cache/extensions/ms-python.python-2026.4.0.vsix");
    expect(market.getState().installing).toEqual({});

    vi.mocked(api.download).mockRejectedValueOnce("checksum mismatch");
    await market.install("ms-python", "python");
    expect(errors).toEqual(["Couldn't install ms-python.python: checksum mismatch"]);
    expect(market.getState().installing).toEqual({});
  });
});
