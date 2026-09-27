import { useEffect, useState } from "react";

import { container } from "../services/container";
import type { ExtensionActivity, InstalledExtension } from "../services/extensionsIpc";
import { contributedLists } from "./extensionContributesModel";

function List({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <h5>{label}</h5>
      <ul className="ext-plain-list" aria-label={label}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </>
  );
}

/**
 * The details page's Milestone 18 part: the extension's id, what it contributes by name, the VS Code APIs it called
 * that OpenMind Studio doesn't support (seen while it ran), and its stored secrets (a count only, with Clear).
 */
export function ExtensionContributes({
  extension,
  activity,
}: {
  extension: InstalledExtension;
  activity: ExtensionActivity;
}) {
  const { service } = container.extensions;
  const [secrets, setSecrets] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void service.secretCount(extension.id).then((count) => {
      if (!cancelled) setSecrets(count);
    });
    return () => {
      cancelled = true;
    };
  }, [extension.id, service]);
  const unsupported = activity.unsupportedApis ?? [];
  return (
    <>
      <h4>Contributes</h4>
      {contributedLists(extension).every((list) => list.items.length === 0) ? (
        <p className="ext-note">No commands, views, themes, icon themes or task types.</p>
      ) : (
        contributedLists(extension).map((list) => (
          <List key={list.label} label={list.label} items={list.items} />
        ))
      )}
      <h4>Unsupported APIs used</h4>
      {unsupported.length === 0 ? (
        <p className="ext-note">None seen so far (they are recorded while the extension runs).</p>
      ) : (
        <>
          <p className="ext-note">
            These VS Code APIs aren't supported by OpenMind Studio yet; the parts of the extension
            that use them won't work.
          </p>
          <ul className="ext-plain-list" aria-label="Unsupported APIs used">
            {unsupported.map((api) => (
              <li key={api}>
                <code>{api}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>Secrets</h4>
      <p className="ext-note">
        {secrets === null
          ? "Checking…"
          : secrets === 0
            ? "It keeps no secrets."
            : `It keeps ${String(secrets)} secret${secrets === 1 ? "" : "s"}, encrypted for your Windows account. Values are never shown.`}
      </p>
      {secrets !== null && secrets > 0 ? (
        confirming ? (
          <p>
            <span className="ext-note">
              Forget all of them? The extension may ask you to sign in again.{" "}
            </span>
            <button
              type="button"
              className="ext-button"
              onClick={() => {
                void service.clearSecrets(extension.id).then(() => {
                  setSecrets(0);
                  setConfirming(false);
                });
              }}
            >
              Clear Secrets
            </button>{" "}
            <button
              type="button"
              className="ext-button"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </button>
          </p>
        ) : (
          <p>
            <button
              type="button"
              className="ext-button"
              onClick={() => {
                setConfirming(true);
              }}
            >
              Clear Secrets…
            </button>
          </p>
        )
      ) : null}
    </>
  );
}
