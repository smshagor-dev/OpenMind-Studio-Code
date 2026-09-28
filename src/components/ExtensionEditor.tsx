import { useSyncExternalStore, type ReactNode } from "react";

import { container } from "../services/container";
import { displayName } from "../services/extensionModel";
import {
  formatCount,
  marketId,
  type ExtensionPage,
  type ExtensionPageTab,
} from "../services/extensionMarketplaceService";
import type { InstalledExtension } from "../services/extensionsIpc";
import { safeHref } from "../services/markdown";
import "../styles/extensionsMarket.css";
import { ExtensionDetails } from "./ExtensionDetails";
import { ExtensionIcon } from "./ExtensionListItem";
import { CloseIcon, CloudDownloadIcon, StarIcon, VerifiedIcon } from "./icons";
import { MarkdownText } from "./MarkdownPreview";
import { t } from "../i18n";

function openLink(href: string) {
  const target = safeHref(href);
  if (target?.kind === "web") void container.ipc.openExternalUrl(target.url);
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="ext-page__stars" title={`Average rating: ${rating.toFixed(1)} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <StarIcon key={n} size={14} filled={rating >= n - 0.25} />
      ))}
    </span>
  );
}

function Actions({
  page,
  installed,
}: {
  page: ExtensionPage;
  installed: InstalledExtension | undefined;
}) {
  const { marketplace, service } = container.extensions;
  const market = useSyncExternalStore(
    (listener) => marketplace.subscribe(listener),
    () => marketplace.getState(),
  );
  if (installed) {
    const toggle = service.toggleAvailability(installed);
    return (
      <div className="ext-page__actions">
        <button
          type="button"
          className="ext-page__button"
          disabled={!toggle.enabled}
          title={toggle.enabled ? undefined : toggle.reason}
          onClick={() => void service.setEnabled(installed.id, !installed.enabled)}
        >
          {installed.enabled ? t("extensions.disable") : t("extensions.enable")}
        </button>
        <button
          type="button"
          className="ext-page__button"
          disabled={!toggle.enabled}
          title={toggle.enabled ? undefined : toggle.reason}
          onClick={() => {
            service.requestUninstall(installed.id);
          }}
        >
          {t("extensions.uninstall.confirm")}
        </button>
        {installed.enabled ? null : (
          <span className="ext-page__state">{t("extPage.disabled")}</span>
        )}
      </div>
    );
  }
  if (page.details === null) return null;
  const busy = market.installing[marketId(page.namespace, page.name)] ?? null;
  return (
    <div className="ext-page__actions">
      <button
        type="button"
        className="ext-page__button ext-page__button--primary"
        disabled={busy !== null}
        onClick={() => void marketplace.install(page.namespace, page.name)}
      >
        {busy ?? t("extensions.installButton")}
      </button>
    </div>
  );
}

function InfoBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ext-page__info-block">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Sidebar({
  page,
  installed,
}: {
  page: ExtensionPage;
  installed: InstalledExtension | undefined;
}) {
  const d = page.details;
  const updated = d?.lastUpdated ? new Date(d.lastUpdated) : null;
  return (
    <aside className="ext-page__side">
      <InfoBlock title={t("extPage.installation")}>
        <dl className="ext-page__facts">
          <dt>{t("extPage.identifier")}</dt>
          <dd>{installed?.id ?? marketId(page.namespace, page.name)}</dd>
          <dt>{t("extensions.install.version")}</dt>
          <dd>{installed?.manifest.version ?? d?.version ?? "—"}</dd>
          {d?.engine ? (
            <>
              <dt>{t("extPage.vscodeApi")}</dt>
              <dd>{d.engine}</dd>
            </>
          ) : null}
        </dl>
      </InfoBlock>
      {d ? (
        <InfoBlock title={t("extensions.marketplace")}>
          <dl className="ext-page__facts">
            <dt>{t("extPage.lastUpdated")}</dt>
            <dd>
              {updated && !Number.isNaN(updated.getTime()) ? updated.toLocaleDateString() : "—"}
            </dd>
            <dt>{t("extPage.downloads")}</dt>
            <dd>{formatCount(d.downloadCount)}</dd>
            {d.license ? (
              <>
                <dt>{t("extPage.license")}</dt>
                <dd>{d.license}</dd>
              </>
            ) : null}
          </dl>
        </InfoBlock>
      ) : null}
      {d && d.categories.length > 0 ? (
        <InfoBlock title={t("extPage.categories")}>
          <div className="ext-page__chips">
            {d.categories.map((category) => (
              <span key={category} className="ext-page__chip">
                {category}
              </span>
            ))}
          </div>
        </InfoBlock>
      ) : null}
      {d ? (
        <InfoBlock title={t("extPage.resources")}>
          <ul className="ext-page__links">
            <li>
              <button
                type="button"
                className="ext-link"
                onClick={() => {
                  openLink(d.pageUrl);
                }}
              >
                {t("extensions.marketplace")}
              </button>
            </li>
            {d.repository ? (
              <li>
                <button
                  type="button"
                  className="ext-link"
                  onClick={() => {
                    openLink(d.repository ?? "");
                  }}
                >
                  {t("extPage.repository")}
                </button>
              </li>
            ) : null}
            {d.homepage ? (
              <li>
                <button
                  type="button"
                  className="ext-link"
                  onClick={() => {
                    openLink(d.homepage ?? "");
                  }}
                >
                  {t("extPage.homepage")}
                </button>
              </li>
            ) : null}
          </ul>
        </InfoBlock>
      ) : null}
    </aside>
  );
}

function Body({
  page,
  installed,
}: {
  page: ExtensionPage;
  installed: InstalledExtension | undefined;
}) {
  if (page.tab === "features") {
    return installed ? (
      <div className="ext-page__features">
        <ExtensionDetails extension={installed} />
      </div>
    ) : (
      <p className="ext-page__note">Install the extension to see what it contributes.</p>
    );
  }
  const text = page.tab === "details" ? page.readme : page.changelog;
  const url = page.tab === "details" ? page.details?.readmeUrl : page.details?.changelogUrl;
  if (page.textError !== null) return <p className="ext-page__note">{page.textError}</p>;
  if (page.textLoading) return <p className="ext-page__note">{t("common.loading")}</p>;
  if (text !== null) return <MarkdownText text={text} onLink={openLink} />;
  if (page.details !== null && url === null) {
    return (
      <p className="ext-page__note">
        {page.tab === "details"
          ? t("extPage.noReadme")
          : t("extPage.noChangelog")}
      </p>
    );
  }
  return (
    <p className="ext-page__note">
      {installed?.manifest.description ?? t("extPage.noDetails")}
    </p>
  );
}

const TABS: readonly { tab: ExtensionPageTab; label: string }[] = [
  { tab: "details", label: "extPage.tab.details" },
  { tab: "features", label: "extPage.tab.features" },
  { tab: "changelog", label: "extPage.tab.changelog" },
];

/**
 * VS Code's extension editor, over the editor area: the header (icon, name,
 * publisher, installs, rating, Install or Disable/Uninstall), Details (the
 * README from Open VSX), Features (what an installed extension contributes)
 * and Changelog, with the facts on the right.
 */
export function ExtensionEditor() {
  const { marketplace, registry } = container.extensions;
  const market = useSyncExternalStore(
    (listener) => marketplace.subscribe(listener),
    () => marketplace.getState(),
  );
  useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.getState(),
  );
  const page = market.page;
  if (page === null) return null;
  const installed =
    registry.find(page.installedId ?? marketId(page.namespace, page.name)) ?? undefined;
  const d = page.details;
  const title = d?.displayName ?? (installed ? displayName(installed) : page.name);
  const close = () => {
    marketplace.closePage();
    container.extensions.service.select(null);
  };
  return (
    <section className="ext-page" aria-label={t("extPage.title", { name: title })}>
      <div className="ext-page__tabbar">
        <div className="tab tab--active" role="tab" aria-selected="true">
          <span className="tab__label">{t("extPage.title", { name: title })}</span>
          <button
            type="button"
            className="tab__close"
            aria-label={t("extPage.close")}
            onClick={close}
          >
            <CloseIcon />
          </button>
        </div>
      </div>
      <div className="ext-page__scroll">
        <header className="ext-page__header">
          <ExtensionIcon url={d?.iconUrl ?? null} size={128} />
          <div className="ext-page__heading">
            <h1 className="ext-page__name">
              {title}
              {d?.preview ? <span className="ext-page__badge">{t("extPage.preview")}</span> : null}
            </h1>
            <div className="ext-page__meta">
              <span className="ext-page__publisher">
                {d?.verified ? (
                  <span className="ext-verified" title={t("extensions.verified")}>
                    <VerifiedIcon size={14} />
                  </span>
                ) : null}
                {d?.publisher ?? installed?.manifest.publisher ?? page.namespace}
              </span>
              {d ? (
                <span className="ext-page__stat">
                  <CloudDownloadIcon size={14} /> {formatCount(d.downloadCount)}
                </span>
              ) : null}
              {d && d.reviewCount > 0 && d.averageRating !== null ? (
                <span className="ext-page__stat">
                  <Stars rating={d.averageRating} /> ({d.reviewCount})
                </span>
              ) : null}
            </div>
            <p className="ext-page__desc">
              {d?.description ?? installed?.manifest.description ?? ""}
            </p>
            <Actions page={page} installed={installed} />
            {page.loading ? <p className="ext-page__note">{t("extPage.loadingOpenVsx")}</p> : null}
            {page.error !== null ? (
              <p className="ext-page__note">{t("extPage.notOnOpenVsx", { error: page.error })}</p>
            ) : null}
          </div>
        </header>
        <nav className="ext-page__tabs" role="tablist" aria-label={t("extPage.tabs")}>
          {TABS.map(({ tab, label }) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={page.tab === tab}
              className={page.tab === tab ? "ext-page__tab ext-page__tab--active" : "ext-page__tab"}
              onClick={() => void marketplace.setTab(tab)}
            >
              {t(label)}
            </button>
          ))}
        </nav>
        <div className="ext-page__content">
          <div className="ext-page__main">
            <Body page={page} installed={installed} />
          </div>
          <Sidebar page={page} installed={installed} />
        </div>
      </div>
    </section>
  );
}
