import { useEffect, useState } from "react";

import { container } from "../services/container";
import type { ExtensionActivity, InstalledExtension } from "../services/extensionsIpc";
import { contributedLists } from "./extensionContributesModel";
import { t } from "../i18n";

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
      <h4>{t("extContrib.title")}</h4>
      {contributedLists(extension).every((list) => list.items.length === 0) ? (
        <p className="ext-note">{t("extContrib.none")}</p>
      ) : (
        contributedLists(extension).map((list) => (
          <List key={list.label} label={list.label} items={list.items} />
        ))
      )}
      <h4>{t("extContrib.unsupported")}</h4>
      {unsupported.length === 0 ? (
        <p className="ext-note">{t("extContrib.noneSeen")}</p>
      ) : (
        <>
          <p className="ext-note">
            {t("extContrib.unsupportedNote")}
          </p>
          <ul className="ext-plain-list" aria-label={t("extContrib.unsupported")}>
            {unsupported.map((api) => (
              <li key={api}>
                <code>{api}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>{t("extContrib.secrets")}</h4>
      <p className="ext-note">
        {secrets === null
          ? t("extContrib.checking")
          : secrets === 0
            ? t("extContrib.noSecrets")
            : t("extContrib.secretCount", { count: secrets })}
      </p>
      {secrets !== null && secrets > 0 ? (
        confirming ? (
          <p>
            <span className="ext-note">
              {t("extContrib.forgetAll")}{" "}
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
              {t("extContrib.clear")}
            </button>{" "}
            <button
              type="button"
              className="ext-button"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t("common.cancel")}
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
              {t("extContrib.clearEllipsis")}
            </button>
          </p>
        )
      ) : null}
    </>
  );
}
