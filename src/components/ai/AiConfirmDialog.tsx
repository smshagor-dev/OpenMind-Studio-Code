import { useSyncExternalStore } from "react";

import { container } from "../../services/container";
import { ConfirmDialog } from "../ConfirmDialog";
import { t } from "../../i18n";

/**
 * "This will send <what> to <provider>": shown before text leaves this computer for an online provider, naming the
 * provider, its host and the kind of content. Nothing is sent until the user says yes. UI only.
 */
/** What is sent, in the UI language (the chat service keeps the English value). */
function whatText(what: string): string {
  if (what === "your message") return t("ai.what.message");
  if (what === "the selected code") return t("ai.what.code");
  if (what === "the selected terminal output") return t("ai.what.terminal");
  const preview = /^text from the preview of (.+)$/.exec(what);
  return preview ? t("ai.what.preview", { name: preview[1] ?? "" }) : what;
}

export function AiConfirmDialog() {
  const chat = useSyncExternalStore(
    (listener) => container.ai.chat.subscribe(listener),
    () => container.ai.chat.getState(),
  );
  const pending = chat.confirmation;
  if (pending === null) return null;
  const size =
    pending.chars > 0 ? t("ai.confirm.size", { count: pending.chars.toLocaleString() }) : "";
  const warning = pending.large ? t("ai.confirm.large") : "";
  return (
    <ConfirmDialog
      title={t("ai.confirm.title", { provider: pending.providerName })}
      message={t("ai.confirm.message", {
        what: whatText(pending.what),
        size,
        provider: pending.providerName,
        host: pending.host,
        warning,
      })}
      confirmLabel={t("ai.send")}
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
