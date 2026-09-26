import { useSyncExternalStore } from "react";

import { container } from "../../services/container";
import { ConfirmDialog } from "../ConfirmDialog";

/**
 * "This will send <what> to <provider>": shown before text leaves this computer for an online provider, naming the
 * provider, its host and the kind of content. Nothing is sent until the user says yes. UI only.
 */
export function AiConfirmDialog() {
  const chat = useSyncExternalStore(
    (listener) => container.ai.chat.subscribe(listener),
    () => container.ai.chat.getState(),
  );
  const pending = chat.confirmation;
  if (pending === null) return null;
  const size = pending.chars > 0 ? ` (about ${pending.chars.toLocaleString()} characters)` : "";
  const warning = pending.large
    ? " This is a large amount of text; it may be slow or expensive."
    : "";
  return (
    <ConfirmDialog
      title={`Send to ${pending.providerName}?`}
      message={`This will send ${pending.what}${size} to ${pending.providerName} (${pending.host}). It leaves this computer.${warning}`}
      confirmLabel="Send"
      tone="primary"
      onConfirm={() => {
        void container.ai.chat.confirm();
      }}
      onCancel={() => {
        container.ai.chat.cancelConfirmation();
      }}
    />
  );
}
