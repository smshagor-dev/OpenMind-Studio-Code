import type { LspServerInfo } from "../ipc";

/**
 * Which language servers belong to a Runtime Manager card: the language tools a runtime's files use. A runtime with no
 * server registered (Pascal, Go, Java ...) has no entry and shows nothing.
 */
export const RUNTIME_LANGUAGE_SERVERS: Readonly<Record<string, readonly string[]>> = {
  python: ["python"],
  node: ["typescript"],
  php: ["php"],
  fortran: ["fortran"],
  "llvm-mingw": ["clangd"],
};

/** The language a server gives features to, as the editor notification names it. */
const SERVER_LANGUAGE: Readonly<Record<string, string>> = {
  typescript: "TypeScript/JavaScript",
  python: "Python",
  php: "PHP",
  json: "JSON",
  css: "CSS",
  html: "HTML",
  yaml: "YAML",
  bash: "Shell",
  dockerfile: "Dockerfile",
  rust: "Rust",
  clangd: "C/C++",
  fortran: "Fortran",
};

export function serverLanguage(server: Pick<LspServerInfo, "id" | "name">): string {
  return SERVER_LANGUAGE[server.id] ?? server.name;
}

/**
 * Where a language tool stands:
 * - `missing`: not installed and one click can download it;
 * - `unavailable`: not installed and it can't be installed now (`installBlocked` says why);
 * - `included`: the app's offline bundle carries it (unpacked the first time a file needs it — nothing to download);
 * - `installing`, `ready` (installed), `running`.
 */
export type ToolState = "missing" | "unavailable" | "included" | "installing" | "ready" | "running";

export function toolState(server: LspServerInfo, installing: boolean): ToolState {
  if (installing || server.state === "installing") return "installing";
  if (server.installed) return server.state === "running" ? "running" : "ready";
  if (server.bundled) return "included";
  return server.canInstall ? "missing" : "unavailable";
}

/** The servers of a runtime card, in the order the backend lists them (only those the backend knows). */
export function runtimeServers(runtimeId: string, servers: readonly LspServerInfo[]): LspServerInfo[] {
  const ids = RUNTIME_LANGUAGE_SERVERS[runtimeId] ?? [];
  return servers.filter((server) => ids.includes(server.id));
}
