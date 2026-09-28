import "../styles/ai.css";

import { container } from "../services/container";
import type { AiProviderView } from "../services/ai/aiProviderService";
import { ActionsBar } from "./ai/ActionsBar";
import { useChat, useProviders } from "./ai/aiHooks";
import { ChatMessages } from "./ai/ChatMessages";
import { Composer } from "./ai/Composer";
import { History } from "./ai/History";
import { ProviderBar } from "./ai/ProviderBar";
import { t } from "../i18n";

/** Shown instead of a chat while the provider lacks a key or a model: never a broken chat. */
function ConfigPrompt({ provider, issue }: { provider: AiProviderView; issue: string }) {
  return (
    <div className="ai-config" role="note">
      <p>{issue}</p>
      <button
        type="button"
        className="ai-button ai-button--primary"
        onClick={() => {
          container.ai.ui.openManager(provider.id);
        }}
      >
        {t("ai.openProviderSettings")}
      </button>
    </div>
  );
}

/**
 * The AI side bar panel. It is only ever rendered while a provider is available (see `SideBar`). Nothing here sends
 * anything by itself: a request starts from Send or an action button, after the confirmation for online providers.
 */
export function AiView() {
  const providers = useProviders();
  const chat = useChat();
  const provider = providers.selected();
  if (provider === null) return null;
  const issue = providers.configIssue(provider);
  return (
    <div className="ai-view">
      <ProviderBar />
      {issue === null ? (
        <>
          <ActionsBar />
          <div className="ai-view__messages">
            <ChatMessages messages={chat.messages} />
          </div>
          <Composer />
          <History />
        </>
      ) : (
        <ConfigPrompt provider={provider} issue={issue} />
      )}
    </div>
  );
}
