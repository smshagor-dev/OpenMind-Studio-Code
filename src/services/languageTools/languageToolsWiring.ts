import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { LspService } from "../lspService";
import type { RuntimeService } from "../runtimeService";
import { LanguageToolsPromptService } from "./languageToolsPrompt";

export interface LanguageToolsWiringDeps {
  events: EventBus<AppEvents>;
  lsp: Pick<LspService, "subscribe" | "activeFileStatus" | "isInstalling" | "install" | "servers" | "refresh">;
  runtime: Pick<RuntimeService, "subscribe" | "getState">;
}

/** Which installed, healthy runtime versions are active — what decides whether a language tool can be installed. */
export function runtimeInstallFingerprint(runtime: Pick<RuntimeService, "getState">): string {
  return runtime
    .getState()
    .runtimes.map((r) => `${r.id}:${r.activeVersion ?? "-"}:${String(r.installed.filter((v) => v.healthy).length)}`)
    .join(",");
}

/**
 * Language tools for the Runtime Manager cards and the editor's install card. A runtime installed, removed or switched
 * (portable Python for fortls, Node.js for the npm servers) changes what can be installed, so the language server status
 * is read again — the cards then show Missing / Install without a restart.
 */
export function wireLanguageTools(deps: LanguageToolsWiringDeps): LanguageToolsPromptService {
  const prompt = new LanguageToolsPromptService({
    lsp: deps.lsp,
    onActiveChange: (listener) => deps.events.on("tabsChanged", listener),
  });
  let seen: string | null = null;
  deps.runtime.subscribe(() => {
    if (!deps.runtime.getState().loaded) return;
    const now = runtimeInstallFingerprint(deps.runtime);
    if (seen !== null && now !== seen) void deps.lsp.refresh();
    seen = now;
  });
  return prompt;
}
