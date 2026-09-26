import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { SearchOutcome, SearchQueryRequest } from "./ipc";

// Mirrors openmind_search::index (serde camelCase).

/** What the app tells the backend about how to index (the `search.indexing.*` settings). */
export interface IndexSettingsRequest {
  enabled: boolean;
  maxFileBytes: number;
  maxTotalBytes: number;
  useGitignore: boolean;
  indexHidden: boolean;
  exclude: string[];
}

export type IndexState = "none" | "disabled" | "indexing" | "idle" | "error";

export interface IndexStatus {
  root: string;
  state: IndexState;
  discovered: number;
  processed: number;
  indexed: number;
  skipped: number;
  errors: number;
  symbols: number;
  contentBytes: number;
  dbBytes: number;
  lastIndexedMs: number | null;
  error: string | null;
}

export interface FileHit {
  path: string;
  relativePath: string;
  name: string;
  score: number;
  /** Character ranges `[start, end)` of `relativePath` that matched. */
  highlights: [number, number][];
}

export interface SymbolHit {
  name: string;
  kind: string;
  line: number;
  column: number;
  container: string | null;
  path: string;
  relativePath: string;
  language: string | null;
  score: number;
}

/** A symbol read from a piece of text (no file). */
export interface TextSymbol {
  name: string;
  kind: string;
  line: number;
  column: number;
  container: string | null;
}

/** The workspace index and the searches answered from it (all local; the index lives in the app's own folder). */
export interface SearchIpc {
  indexStart: (settings: IndexSettingsRequest, restart: boolean) => Promise<IndexStatus>;
  indexStatus: () => Promise<IndexStatus>;
  indexCancel: () => Promise<void>;
  indexRebuild: (settings: IndexSettingsRequest) => Promise<void>;
  indexClear: () => Promise<void>;
  indexTouch: (paths: string[]) => Promise<void>;
  searchFilesIndexed: (text: string, extension: string | null, limit: number) => Promise<FileHit[]>;
  searchSymbolsIndexed: (text: string, kind: string | null, limit: number) => Promise<SymbolHit[]>;
  searchFileSymbols: (path: string) => Promise<SymbolHit[]>;
  searchSymbolsOfText: (language: string, text: string) => Promise<TextSymbol[]>;
  searchTextIndexed: (searchId: string, query: SearchQueryRequest) => Promise<SearchOutcome>;
  /** Index progress and state changes (for every open folder; the listener filters by `root`). */
  onIndexStatus: (listener: (status: IndexStatus) => void) => Promise<() => void>;
}

export const tauriSearchIpc: SearchIpc = {
  indexStart: (settings, restart) => invoke<IndexStatus>("index_start", { settings, restart }),
  indexStatus: () => invoke<IndexStatus>("index_status"),
  indexCancel: () => invoke("index_cancel"),
  indexRebuild: (settings) => invoke("index_rebuild", { settings }),
  indexClear: () => invoke("index_clear"),
  indexTouch: (paths) => invoke("index_touch", { paths }),
  searchFilesIndexed: (text, extension, limit) =>
    invoke<FileHit[]>("search_files_indexed", { text, extension, limit }),
  searchSymbolsIndexed: (text, kind, limit) =>
    invoke<SymbolHit[]>("search_symbols_indexed", { text, kind, limit }),
  searchFileSymbols: (path) => invoke<SymbolHit[]>("search_file_symbols", { path }),
  searchSymbolsOfText: (language, text) =>
    invoke<TextSymbol[]>("search_symbols_of_text", { language, text }),
  searchTextIndexed: (searchId, query) =>
    invoke<SearchOutcome>("search_text_indexed", { searchId, query }),
  onIndexStatus: (listener) =>
    listen<IndexStatus>("index:status", (event) => {
      listener(event.payload);
    }),
};
