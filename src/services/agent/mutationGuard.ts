// Installed in every editor at startup, including windows whose agent panel was never opened.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { container } from "../container";

interface GuardRequest {
  id: string;
  owner: string;
}

export async function installMutationGuard(): Promise<void> {
  let label: string;
  try {
    label = getCurrentWebviewWindow().label;
  } catch {
    return; // Plain browser previews have no native mutations to guard.
  }
  await listen<GuardRequest>(
    "agent:guard",
    ({ payload }) => {
      const unsaved = container.documents
        .fileBackedIds()
        .filter((id) => container.documents.isDirty(id))
        .map((id) => container.documents.snapshot(id).path)
        .filter((path): path is string => path !== null);
      void invoke("agent_guard_answer", {
        id: payload.id,
        owner: payload.owner,
        editor: { root: container.workspace.getActiveWorkspace()?.path ?? null, unsaved },
      }).catch((error: unknown) => {
        console.error("Agent document-state reply failed", error);
      });
    },
    { target: { kind: "WebviewWindow", label } },
  ).catch((error: unknown) => {
    console.error("Agent document-state listener failed", error);
  });
}
