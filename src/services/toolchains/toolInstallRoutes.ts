import type { LspServerInfo, RuntimeStatus } from "../ipc";

/**
 * How each tool of Runtime Manager > Language Tools is installed, reusing what already installs it:
 * - `runtime`: one or more Runtime Manager runtimes (portable, checksum-verified, in the app folder);
 * - `server`: a language server of the Language Tools installer;
 * - `package`: a tool package the app downloads into `tools/` (npm / pip / PHP archive / `go install` / rustup);
 * - `external`: can't be installed by a portable app, with the reason.
 */
export type ToolRoute =
  | { kind: "runtime"; runtimes: readonly string[] }
  | { kind: "server"; server: string }
  | { kind: "package" }
  | { kind: "external"; reason: string };

export const TOOL_ROUTES: Readonly<Record<string, ToolRoute>> = {
  git: { kind: "runtime", runtimes: ["git"] },
  composer: { kind: "runtime", runtimes: ["php", "composer"] },
  debugpy: { kind: "runtime", runtimes: ["debugpy"] },
  "go-sdk": { kind: "runtime", runtimes: ["go"] },
  jdk: { kind: "runtime", runtimes: ["jdk"] },
  "dotnet-sdk": { kind: "runtime", runtimes: ["dotnet"] },
  "cpp-toolchain": { kind: "runtime", runtimes: ["llvm-mingw", "cmake", "ninja"] },
  "flutter-sdk": { kind: "runtime", runtimes: ["flutter"] },
  "android-sdk": { kind: "runtime", runtimes: ["android-cmdline-tools", "android-platform-tools"] },
  intelephense: { kind: "server", server: "php" },
  ruff: { kind: "package" },
  black: { kind: "package" },
  isort: { kind: "package" },
  pytest: { kind: "package" },
  eslint: { kind: "package" },
  prettier: { kind: "package" },
  biome: { kind: "package" },
  "tailwindcss-language-server": { kind: "package" },
  "vue-language-server": { kind: "package" },
  "svelte-language-server": { kind: "package" },
  "astro-language-server": { kind: "package" },
  "graphql-language-service": { kind: "package" },
  "sql-language-server": { kind: "package" },
  phpactor: {
    kind: "external",
    reason:
      "Phpactor needs PHP's posix extension, which PHP doesn't have on Windows, so it can't run here (only on Linux, macOS or WSL). Use Intelephense for PHP.",
  },
  "php-cs-fixer": { kind: "package" },
  pint: { kind: "package" },
  gopls: { kind: "package" },
  "rust-toolchain": { kind: "package" },
  docker: {
    kind: "external",
    reason:
      "Docker needs Docker Desktop or a Docker engine, which install a Windows service and need administrator rights and WSL 2 or Hyper-V — a portable app can't install that. Install Docker Desktop yourself; OpenMind finds docker on PATH.",
  },
  xcode: {
    kind: "external",
    reason: "Xcode runs only on macOS. iOS and macOS builds can't be done on Windows.",
  },
};

/** The active, healthy version of each runtime the route needs (`null` = not installed). */
export function runtimeVersions(
  runtimes: readonly string[],
  list: readonly RuntimeStatus[],
): { id: string; name: string; version: string | null; licence: RuntimeStatus["license"] }[] {
  return runtimes.map((id) => {
    const status = list.find((entry) => entry.id === id);
    const active = status?.installed.find((entry) => entry.active && entry.healthy) ?? null;
    return { id, name: status?.displayName ?? id, version: active?.version ?? null, licence: status?.license ?? null };
  });
}

export type RouteState =
  | { state: "installed"; detail: string }
  | { state: "missing"; detail: string }
  | { state: "installing" }
  | { state: "unavailable"; reason: string }
  | { state: "external"; reason: string };

/** Where a runtime- or server-backed tool stands. */
export function routeState(
  route: ToolRoute,
  runtimes: readonly RuntimeStatus[],
  servers: readonly LspServerInfo[],
  busy: boolean,
): RouteState | null {
  if (route.kind === "external") return { state: "external", reason: route.reason };
  if (route.kind === "package") return null;
  if (busy) return { state: "installing" };
  if (route.kind === "server") {
    const server = servers.find((entry) => entry.id === route.server);
    if (server === undefined) return null;
    if (server.state === "installing") return { state: "installing" };
    if (server.installed) return { state: "installed", detail: server.contents };
    if (!server.canInstall) return { state: "unavailable", reason: server.installBlocked ?? "It can't be installed now." };
    return { state: "missing", detail: `Installs ${server.contents} with the Language Tools installer.` };
  }
  const parts = runtimeVersions(route.runtimes, runtimes);
  if (parts.length > 0 && parts.every((part) => part.version !== null)) {
    return { state: "installed", detail: parts.map((part) => `${part.name} ${part.version ?? ""}`).join(", ") };
  }
  const missing = parts.filter((part) => part.version === null).map((part) => part.name);
  return { state: "missing", detail: `Installs ${missing.join(", ")} with the Runtime Manager (into the app folder).` };
}
