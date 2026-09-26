import { useSyncExternalStore } from "react";

import { container } from "../../services/container";

/** Re-renders when provider availability, selection or configuration changes; returns the service. */
export function useProviders() {
  useSyncExternalStore(
    (listener) => container.ai.providers.subscribe(listener),
    () => container.ai.providers.getVersion(),
  );
  return container.ai.providers;
}

/** The chat's state (messages, sending, notice, waiting confirmation, history). */
export function useChat() {
  return useSyncExternalStore(
    (listener) => container.ai.chat.subscribe(listener),
    () => container.ai.chat.getState(),
  );
}
