import { t } from "../../i18n";
import type { ConfirmPrompt } from "../extensionPromptService";
import type { LspService } from "../lspService";
import type { RunMissingRuntimeHost } from "../runCodeService";
import type { LspServerInfo, RuntimeStatus } from "../ipc";
import type { RuntimeService } from "../runtimeService";
import type { SettingsService } from "../settingsService";

/** The Runtime Manager item that holds NASM, the MinGW-w64 linker, GNU binutils and GDB. */
export const ASSEMBLY_RUNTIME = "assembly";
/** OpenMind's id of asm-lsp, the Assembly language server. */
export const ASSEMBLY_SERVER = "assembly";

/** The Assembly runtime's optional 32-bit toolchain. */
export const X86_ADDON = "x86";

export interface ToolchainDeps {
  runtime: Pick<RuntimeService, "install" | "installAddon" | "repair" | "getState">;
  lsp: Pick<LspService, "install" | "servers">;
  settings: Pick<SettingsService, "bool" | "string">;
}

/**
 * Install Assembly Toolchain: the Assembly runtime (NASM, linker, binutils, GDB — downloaded through the Runtime
 * Manager, checksum-verified), its x86 (32-bit) part when the architecture setting is x86, and then asm-lsp from
 * Language Tools unless the language server is turned off or already installed. One click; a failure of any part is
 * reported by its own service (toast and Output).
 */
export async function installAssemblyToolchain(deps: ToolchainDeps): Promise<boolean> {
  if (!(await ensureRuntime(deps))) return false;
  if (deps.settings.string("assembly.architecture", "x86-64") === "x86" && !(await ensureX86(deps))) return false;
  if (!deps.settings.bool("assembly.enableLanguageServer", true)) return true;
  const server = deps.lsp.servers().find((entry) => entry.id === ASSEMBLY_SERVER);
  if (server === undefined || server.installed || server.bundled || !server.canInstall) return true;
  await deps.lsp.install(ASSEMBLY_SERVER);
  // The toolchain is what Run Code needs; a language server that failed to install was reported on its own.
  return true;
}

/** A healthy toolchain: kept; a damaged one (files missing): repaired in place; none: installed. */
async function ensureRuntime(deps: ToolchainDeps): Promise<boolean> {
  const status = runtimeStatus(deps);
  if (status?.installed.some((version) => version.healthy) === true) return true;
  const damaged = status?.installed.find((version) => version.version === status.activeVersion) ?? status?.installed[0];
  if (damaged !== undefined) {
    // The canonical state may not show the repaired version yet: the repair's own answer counts.
    return deps.runtime.repair(ASSEMBLY_RUNTIME, damaged.version);
  }
  return deps.runtime.install(ASSEMBLY_RUNTIME, null);
}

function runtimeStatus(deps: ToolchainDeps) {
  return deps.runtime.getState().runtimes.find((runtime) => runtime.id === ASSEMBLY_RUNTIME);
}

/** Adds the x86 part to the active (else just installed, the default) Assembly version unless it is there already. */
async function ensureX86(deps: ToolchainDeps): Promise<boolean> {
  const status = runtimeStatus(deps);
  const version = status?.activeVersion ?? status?.defaultVersion;
  if (version === undefined) return false;
  const present = status?.installed
    .find((entry) => entry.version === version)
    ?.addons?.some((addon) => addon.id === X86_ADDON && addon.installed);
  return present === true || deps.runtime.installAddon(ASSEMBLY_RUNTIME, version, X86_ADDON);
}

/** What the Assembly card's complete setup holds right now, part by part. */
export interface AssemblySetup {
  /** `needsRepair`: installed, but files are missing (Repair, or Install Assembly Toolchain, puts them back). */
  toolchain: "installed" | "needsRepair" | "missing";
  /** The x86 (32-bit) part: only needed when the architecture is x86. */
  x86: "installed" | "missing" | "notNeeded";
  /** asm-lsp is optional: `off` when the language server setting is turned off, `unavailable` when it can't be installed. */
  languageServer: "installed" | "missing" | "off" | "unavailable";
  /** Something *Install Assembly Toolchain* would add. */
  incomplete: boolean;
}

export function assemblySetup(
  runtime: RuntimeStatus | undefined,
  servers: readonly LspServerInfo[],
  architecture: string,
  languageServerOn: boolean,
): AssemblySetup {
  const active = runtime?.installed.find((entry) => entry.version === runtime.activeVersion) ?? runtime?.installed[0];
  const toolchain = active === undefined ? "missing" : active.healthy ? "installed" : "needsRepair";
  const x86Installed = active?.addons?.some((addon) => addon.id === X86_ADDON && addon.installed) === true;
  const x86 = architecture !== "x86" ? "notNeeded" : x86Installed ? "installed" : "missing";
  const server = servers.find((entry) => entry.id === ASSEMBLY_SERVER);
  const languageServer = !languageServerOn
    ? "off"
    : server?.installed === true || server?.bundled === true
      ? "installed"
      : server?.canInstall === true
        ? "missing"
        : "unavailable";
  return {
    toolchain,
    x86,
    languageServer,
    incomplete: toolchain !== "installed" || x86 === "missing" || languageServer === "missing",
  };
}

export interface MissingRuntimeDeps extends ToolchainDeps {
  confirm: (request: Omit<ConfirmPrompt, "kind" | "id">) => Promise<string | null>;
  /** Runs an app command (`runtime.manage` opens the Runtime Manager). */
  run: (command: string) => void;
}

/**
 * Run Code's answer to a missing tool: "Install <toolchain> / Open Runtime Manager / Cancel". Assembly installs its
 * whole toolchain (and asm-lsp); any other runtime is installed through the Runtime Manager as from its card.
 */
export function missingRuntimeHost(deps: MissingRuntimeDeps): RunMissingRuntimeHost {
  return {
    offer: async (runtimeId, reason) => {
      const name =
        runtimeId === ASSEMBLY_RUNTIME
          ? t("assembly.toolchain")
          : (deps.runtime.getState().runtimes.find((runtime) => runtime.id === runtimeId)?.displayName ?? runtimeId);
      const install = t("run.missing.install", { name });
      const open = t("run.missing.open");
      const answer = await deps.confirm({
        extension: t("run.interactive.source"),
        title: t("run.missing.title", { name }),
        details: [{ label: t("run.missing.reason"), value: reason }],
        notes: [t("run.missing.note")],
        buttons: [install, open],
      });
      if (answer === open) deps.run("runtime.manage");
      if (answer !== install) return false;
      return runtimeId === ASSEMBLY_RUNTIME ? installAssemblyToolchain(deps) : deps.runtime.install(runtimeId, null);
    },
  };
}
