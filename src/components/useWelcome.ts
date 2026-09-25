import { useSyncExternalStore } from "react";

import { container } from "../services/container";

/** The Welcome tab's state (open, show on start-up), re-rendering on change. */
export function useWelcome() {
  return useSyncExternalStore(
    (listener) => container.welcome.subscribe(listener),
    () => container.welcome.getState(),
  );
}
