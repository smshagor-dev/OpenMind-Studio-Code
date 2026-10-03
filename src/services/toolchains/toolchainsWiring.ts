import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { ConfirmPrompt } from "../extensionPromptService";
import type { IpcClient } from "../ipc";
import type { LspService } from "../lspService";
import type { RuntimeService } from "../runtimeService";
import { ToolchainService } from "./toolchainService";
import { ToolInstallService } from "./toolInstallService";

export interface ToolchainsWiringDeps {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  runtime: RuntimeService;
  lsp: LspService;
  /** The language support looks at the open folder again (which tools are found). */
  refreshLanguage: () => void;
  confirm: (request: Omit<ConfirmPrompt, "kind" | "id">) => Promise<string | null>;
}

/**
 * The bundled app-local tools (Language Tools): the list follows the canonical state; Install routes a tool to the
 * Runtime Manager, Language Tools or a tool package installed into `tools/`.
 */
export function wireToolchains(deps: ToolchainsWiringDeps) {
  const { ipc } = deps;
  const toolchains = new ToolchainService(ipc);
  const toolInstall = new ToolInstallService({
    events: deps.events,
    runtime: deps.runtime,
    lsp: deps.lsp,
    installPackage: async (id) => {
      await ipc.toolchainsInstall(id);
    },
    removePackage: async (id) => {
      await ipc.toolchainsRemove(id);
    },
    refreshTools: async () => {
      await toolchains.refresh();
      deps.refreshLanguage();
    },
    acceptLicence: async ({ tool, name, url }) =>
      (await deps.confirm({
        extension: "Language Tools",
        title: `Accept the ${name} to install ${tool}?`,
        details: [
          { label: "Licence", value: name },
          { label: "Terms", value: url },
        ],
        notes: [`${tool} is installed only after you accept its vendor's licence. Read the terms at the address above.`],
        buttons: ["Accept and Install"],
      })) === "Accept and Install",
  });
  return { toolchains, toolInstall };
}
