import { invoke } from "@tauri-apps/api/core";

/** One extension in an Open VSX list (see `commands::marketplace`). */
export interface MarketItem {
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  iconUrl: string | null;
  downloadCount: number;
  averageRating: number | null;
  reviewCount: number;
  verified: boolean;
  deprecated: boolean;
}

export interface MarketPage {
  total: number;
  offset: number;
  items: MarketItem[];
}

export interface MarketDetails extends MarketItem {
  publisher: string;
  categories: string[];
  tags: string[];
  license: string | null;
  repository: string | null;
  homepage: string | null;
  lastUpdated: string | null;
  engine: string | null;
  preview: boolean;
  readmeUrl: string | null;
  changelogUrl: string | null;
  pageUrl: string;
}

/** How a list is sorted (mapped to Open VSX's `sortBy` in Rust). */
export type MarketSort = "relevance" | "installs" | "rating" | "updated";

/** The Open VSX calls, as an interface so tests can supply their own. */
export interface MarketplaceApi {
  search: (query: string, sort: MarketSort, offset: number, size: number) => Promise<MarketPage>;
  details: (namespace: string, name: string) => Promise<MarketDetails>;
  text: (url: string) => Promise<string>;
  /** Downloads the checksum-verified `.vsix`; resolves to its path. */
  download: (namespace: string, name: string) => Promise<string>;
}

export const tauriMarketplaceApi: MarketplaceApi = {
  search: (query, sort, offset, size) =>
    invoke<MarketPage>("ext_market_search", { query, sort, offset, size }),
  details: (namespace, name) => invoke<MarketDetails>("ext_market_details", { namespace, name }),
  text: (url) => invoke<string>("ext_market_text", { url }),
  download: (namespace, name) => invoke<string>("ext_market_download", { namespace, name }),
};
