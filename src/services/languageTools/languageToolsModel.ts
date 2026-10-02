import type { LspServerInfo } from "../ipc";

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

/** The servers "Install all missing" would install: missing and installable now, in the backend's order. */
export function installableServers(servers: readonly LspServerInfo[], isInstalling: (id: string) => boolean): LspServerInfo[] {
  return servers.filter((server) => toolState(server, isInstalling(server.id)) === "missing");
}

/**
 * Installs every missing language server, one after another, through the Language Tools installer (offline bundle,
 * else npm / pip into the app's own folder). One failing doesn't stop the rest; the result names what worked.
 */
export async function installAllMissing(lsp: {
  servers: () => readonly LspServerInfo[];
  isInstalling: (id: string) => boolean;
  install: (id: string) => Promise<boolean>;
}): Promise<{ installed: string[]; failed: string[] }> {
  const installed: string[] = [];
  const failed: string[] = [];
  for (const server of installableServers(lsp.servers(), lsp.isInstalling)) {
    if (await lsp.install(server.id)) installed.push(server.name);
    else failed.push(server.name);
  }
  return { installed, failed };
}
