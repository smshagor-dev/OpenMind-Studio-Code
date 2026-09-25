import { vi } from "vitest";

import type { MarketDetails, MarketItem, MarketplaceApi } from "../services/marketplaceIpc";

export function marketItem(overrides: Partial<MarketItem> = {}): MarketItem {
  return {
    namespace: "ms-python",
    name: "python",
    displayName: "Python",
    description: "Python language support",
    version: "2026.4.0",
    iconUrl: "https://open-vsx.org/api/ms-python/python/2026.4.0/file/icon.png",
    downloadCount: 59_099_659,
    averageRating: 3.875,
    reviewCount: 16,
    verified: true,
    deprecated: false,
    ...overrides,
  };
}

export function marketDetails(overrides: Partial<MarketDetails> = {}): MarketDetails {
  return {
    ...marketItem(),
    publisher: "Microsoft",
    categories: ["Programming Languages"],
    tags: ["python"],
    license: "MIT",
    repository: "https://github.com/Microsoft/vscode-python",
    homepage: null,
    lastUpdated: "2026-03-13T04:21:53Z",
    engine: "^1.95.0",
    preview: false,
    readmeUrl: "https://open-vsx.org/api/ms-python/python/2026.4.0/file/README.md",
    changelogUrl: "https://open-vsx.org/api/ms-python/python/2026.4.0/file/CHANGELOG.md",
    pageUrl: "https://open-vsx.org/extension/ms-python/python",
    ...overrides,
  };
}

/** An Open VSX with one page of results; override any call. */
export function createFakeMarketplaceApi(overrides: Partial<MarketplaceApi> = {}): MarketplaceApi {
  return {
    search: vi.fn().mockResolvedValue({ total: 1, offset: 0, items: [marketItem()] }),
    details: vi.fn().mockResolvedValue(marketDetails()),
    text: vi.fn().mockResolvedValue("# Python\n\nThe README."),
    download: vi.fn().mockResolvedValue("C:/app/cache/extensions/ms-python.python-2026.4.0.vsix"),
    ...overrides,
  };
}
