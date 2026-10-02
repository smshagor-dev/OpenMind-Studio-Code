import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { LspService } from "../lspService";
import type { RuntimeService } from "../runtimeService";
import { LanguageToolsPromptService } from "./languageToolsPrompt";

export interface LanguageToolsWiringDeps {
  events: EventBus<AppEvents>;
  lsp: Pick<LspService, "subscribe" | "activeFileStatus" | "isInstalling" | "install" | "servers">;
}

/** Which installed, healthy runtime versions are active — what decides what can run, format, serve or be installed. */
export function runtimeInstallFingerprint(runtime: Pick<RuntimeService, "getState">): string {
  return runtime
    .getState()
    .runtimes.map((r) => `${r.id}:${r.activeVersion ?? "-"}:${String(r.installed.filter((v) => v.healthy).length)}`)
    .join(",");
}

/** The editor's one-click install card for a missing language tool. */
export function wireLanguageTools(deps: LanguageToolsWiringDeps): LanguageToolsPromptService {
  return new LanguageToolsPromptService({
    lsp: deps.lsp,
    onActiveChange: (listener) => deps.events.on("tabsChanged", listener),
  });
}

/**
 * Everything that depends on the installed runtimes follows an install, removal or switch at once, as in VS Code —
 * no restart: the language servers (status read again, open files without a working server retried so it starts),
 * the project/tool detection, the Dependencies view and the formatter status. Each refresher runs on its own; one
 * failing doesn't stop the others. The first load (start-up) refreshes nothing: everything just read its state.
 */
export function refreshAfterInstalls(
  runtime: Pick<RuntimeService, "subscribe" | "getState">,
  refreshers: readonly (() => Promise<void> | void)[],
): () => void {
  let seen: string | null = null;
  return runtime.subscribe(() => {
    if (!runtime.getState().loaded) return;
    const now = runtimeInstallFingerprint(runtime);
    const changed = seen !== null && now !== seen;
    seen = now;
    if (!changed) return;
    for (const refresh of refreshers) {
      void Promise.resolve()
        .then(refresh)
        .catch(() => undefined);
    }
  });
}
