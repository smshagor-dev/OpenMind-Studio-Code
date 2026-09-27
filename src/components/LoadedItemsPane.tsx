import { useEffect, useState, useSyncExternalStore } from "react";

import { container } from "../services/container";

/** Loaded scripts or modules of the running program (asked from the adapter when shown, and on each pause). */
export function LoadedItemsPane() {
  const state = useSyncExternalStore(
    (listener) => container.debug.subscribe(listener),
    () => container.debug.getState(),
  );
  const [items, setItems] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runState = state.run?.state;
  useEffect(() => {
    let cancelled = false;
    container.debug.loadedItems().then(
      (answer) => {
        if (!cancelled) setItems(answer?.items ?? []);
      },
      (reason: unknown) => {
        if (!cancelled) setError(String(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [runState]);
  if (error !== null) return <p className="debug-reason">{error}</p>;
  if (items === null) return <p className="debug-empty">Loading…</p>;
  if (items.length === 0) return <p className="debug-empty">Nothing loaded yet.</p>;
  return (
    <ul className="debug-list" aria-label="Loaded items">
      {items.slice(0, 500).map((item) => (
        <li key={item} className="debug-loaded" title={item}>
          {item.split(/[\\/]/).pop() ?? item}
        </li>
      ))}
    </ul>
  );
}
