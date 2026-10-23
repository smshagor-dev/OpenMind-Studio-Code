import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { container } from "../services/container";
import { displayName, hostStateText, runtimeStatus } from "../services/extensionModel";
import { isNewerVersion, marketId } from "../services/extensionMarketplaceService";
import type { InstalledExtension } from "../services/extensionsIpc";
import type { MarketItem } from "../services/marketplaceIpc";
import "../styles/extensions.css";
import "../styles/extensionsMarket.css";
import { manageMenu, moreActionsMenu, sortMenu } from "./extensionMenus";
import { ExtensionListItem } from "./ExtensionListItem";
import { useQuietTitle } from "./useQuietTitle";
import { ChevronIcon, EllipsisIcon, FilterIcon } from "./icons";
import { MenuPopup, type PopupItem } from "./MenuPopup";
import { useDismissOnOutside } from "./useDismissOnOutside";
import { t } from "../i18n";
import { extensionWorkbench } from "../services/extensionWorkbench";

const INSTALLED_FILTER = "@installed";

function useExtensionsState() {
  const { registry, service, marketplace } = container.extensions;
  const registryState = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.getState(),
  );
  const ui = useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.getState(),
  );
  const market = useSyncExternalStore(
    (listener) => marketplace.subscribe(listener),
    () => marketplace.getState(),
  );
  return { registryState, ui, market };
}

type OpenMenu = { items: PopupItem[]; x: number; y: number; label: string } | null;

/** A collapsible section with a count badge, like VS Code's Installed / Popular. */
function Section(props: {
  title: string;
  count: number | null;
  grow?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section
      className={props.grow && open ? "ext-section ext-section--grow" : "ext-section"}
      aria-label={props.title}
    >
      <button
        type="button"
        className="ext-section__header"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <ChevronIcon expanded={open} />
        <span className="ext-section__title">{props.title}</span>
        {props.count !== null ? <span className="ext-badge">{props.count}</span> : null}
      </button>
      {open ? props.children : null}
    </section>
  );
}

function InstalledRow(props: {
  extension: InstalledExtension;
  iconUrl: string | null;
  onMenu: (menu: OpenMenu) => void;
}) {
  const { extension } = props;
  const { registryState, market } = useExtensionsState();
  const snapshot = registryState.snapshot;
  const runtime = snapshot ? runtimeStatus(extension, snapshot.host, snapshot.node) : null;
  const activity = container.extensions.registry.activityOf(extension.id);
  return (
    <ExtensionListItem
      name={displayName(extension)}
      description={extension.manifest.description ?? ""}
      publisher={extension.manifest.publisher}
      verified={false}
      iconUrl={props.iconUrl}
      downloads={null}
      rating={null}
      dimmed={extension.enabled ? undefined : t("extensions.disabled")}
      problem={
        activity.lastError ?? (runtime && !runtime.ready && extension.enabled ? runtime.text : null)
      }
      selected={market.page?.installedId === extension.id}
      onOpen={() => {
        container.extensions.service.select(extension.id);
        void container.extensions.marketplace.openPage(
          extension.manifest.publisher,
          extension.manifest.name,
          extension.id,
        );
      }}
      action={{
        kind: "installed",
        label: extension.enabled ? "" : t("extensions.disabled"),
        onManage: (anchor) => {
          props.onMenu({
            items: manageMenu(extension),
            x: anchor.left,
            y: anchor.bottom,
            label: t("extensions.manage"),
          });
        },
      }}
    />
  );
}

function MarketRow(props: {
  item: MarketItem;
  installed: InstalledExtension | undefined;
  onMenu: (menu: OpenMenu) => void;
}) {
  const { item, installed } = props;
  const { market } = useExtensionsState();
  const { marketplace } = container.extensions;
  const id = marketId(item.namespace, item.name);
  return (
    <ExtensionListItem
      name={item.displayName}
      description={item.description}
      publisher={item.namespace}
      verified={item.verified}
      iconUrl={item.iconUrl}
      downloads={item.downloadCount}
      rating={item.reviewCount > 0 ? item.averageRating : null}
      selected={market.page !== null && marketId(market.page.namespace, market.page.name) === id}
      onOpen={() => void marketplace.openPage(item.namespace, item.name, installed?.id ?? null)}
      action={
        installed
          ? {
              kind: "installed",
              label: installed.enabled ? "" : t("extensions.disabled"),
              onManage: (anchor) => {
                props.onMenu({
                  items: manageMenu(installed),
                  x: anchor.left,
                  y: anchor.bottom,
                  label: t("extensions.manage"),
                });
              },
            }
          : {
              kind: "install",
              busy: market.installing[id] ?? null,
              onInstall: () => void marketplace.install(item.namespace, item.name),
            }
      }
    />
  );
}

/**
 * Update check of installed extensions (Milestone 18): only on a click (or when the view opens with auto-load on);
 * each update names its source and both versions, and Update goes through the normal verified install + trust dialog.
 */
function Updates() {
  const { market } = useExtensionsState();
  const { marketplace, registry } = container.extensions;
  // An update that was installed since the check (or the extension removed) is no longer offered.
  const updates = market.updates.filter((update) => {
    const installed = registry.find(update.id);
    return installed !== undefined && isNewerVersion(update.latest, installed.manifest.version);
  });
  return (
    <div className="ext-updates" aria-label={t("extensions.updates")}>
      <div className="ext-updates__bar">
        <button
          type="button"
          className="ext-link"
          disabled={market.checkingUpdates}
          onClick={() => void marketplace.checkUpdates()}
        >
          {market.checkingUpdates ? t("extensions.checkingUpdates") : t("extensions.checkUpdates")}
        </button>
        {market.updatesCheckedAt !== null && !market.checkingUpdates && market.updateError === null ? (
          <span className="ext-note">
            {updates.length === 0
              ? t("extensions.noUpdates", { time: market.updatesCheckedAt })
              : t("extensions.updateCount", { count: updates.length })}
          </span>
        ) : null}
      </div>
      {market.updateError !== null ? <p className="ext-note">{market.updateError}</p> : null}
      {updates.length > 0 ? (
        <ul className="ext-plain-list" aria-label={t("extensions.availableUpdates")}>
          {updates.map((update) => {
            const busy = market.installing[marketId(update.namespace, update.name)] ?? null;
            return (
              <li key={update.id}>
                <span>
                  {update.id}: {update.current} → {update.latest} (Open VSX)
                </span>{" "}
                <button
                  type="button"
                  className="ext-button"
                  disabled={busy !== null}
                  onClick={() => void marketplace.install(update.namespace, update.name)}
                >
                  {busy ?? t("extensions.update")}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** Banners from the extensions service and the runtime it needs. */
function Notices() {
  const { registryState, ui } = useExtensionsState();
  const { service, host } = container.extensions;
  const problem = service.runtimeProblem();
  const node = registryState.snapshot?.node;
  return (
    <>
      {ui.busy !== null || ui.notice !== null || ui.error !== null ? (
        <div
          className={ui.error !== null ? "ext-banner ext-banner--problem" : "ext-banner"}
          role={ui.error !== null ? "alert" : "status"}
        >
          <p>{ui.error ?? ui.busy ?? ui.notice}</p>
          {ui.busy === null ? (
            <button
              type="button"
              className="ext-link"
              onClick={() => {
                service.clearMessages();
              }}
            >
              {t("common.dismissAction")}
            </button>
          ) : null}
        </div>
      ) : null}
      {problem !== null ? (
        <div className="ext-banner ext-banner--problem" role="alert">
          <p>{problem}</p>
          {node && !node.portable && node.system !== null && !node.allowSystem ? (
            <p className="ext-banner__hint">
              {t("extensions.systemNodeFound", { path: node.system })}
            </p>
          ) : null}
          {node && !node.portable && node.system !== null && !node.allowSystem ? (
            <button
              type="button"
              className="ext-button"
              onClick={() => void service.allowSystemNode()}
            >
              {t("extensions.useSystemNode")}
            </button>
          ) : node && !node.portable ? (
            <button
              type="button"
              className="ext-button"
              onClick={() => {
                container.run("runtime.manage");
              }}
            >
              {t("extensions.installNode")}
            </button>
          ) : (
            <button type="button" className="ext-button" onClick={() => void host.reload()}>
              {t("extensions.restartHost")}
            </button>
          )}
        </div>
      ) : null}
      {registryState.error !== null ? (
        <p className="ext-banner ext-banner--problem" role="alert">
          {registryState.error}
        </p>
      ) : null}
      {(registryState.snapshot?.broken ?? []).map((broken) => (
        <p key={broken.folder} className="ext-banner ext-banner--problem" role="alert">
          {broken.folder}: {broken.error}
        </p>
      ))}
    </>
  );
}

function MarketList(props: {
  installedById: Map<string, InstalledExtension>;
  onMenu: (menu: OpenMenu) => void;
}) {
  const { market } = useExtensionsState();
  const { marketplace } = container.extensions;
  if (market.error !== null) {
    return (
      <div className="ext-empty" role="alert">
        <p>{t("extensions.marketUnreachable")}</p>
        <p className="ext-empty__hint">{market.error}</p>
        <button type="button" className="ext-button" onClick={() => void marketplace.refresh()}>
          {t("common.retry")}
        </button>
      </div>
    );
  }
  if (!market.requested) {
    return (
      <div className="ext-empty">
        <p>{t("extensions.loadOnRequest")}</p>
        <p className="ext-empty__hint">
          {t("extensions.nothingFetched")}
        </p>
        <button type="button" className="ext-button" onClick={() => void marketplace.browse()}>
          {t("extensions.loadPopular")}
        </button>
      </div>
    );
  }
  if (market.loading && market.items.length === 0) {
    return <p className="ext-empty">{t("common.loading")}</p>;
  }
  if (market.items.length === 0) {
    const query = market.query.trim();
    return (
      <p className="ext-empty">
        {query === "" ? t("extensions.noneFound") : t("extensions.noneFoundFor", { query })}
      </p>
    );
  }
  return (
    <ul
      className="ext-items"
      aria-label={t("extensions.marketList")}
      onScroll={(event) => {
        const list = event.currentTarget;
        if (list.scrollTop + list.clientHeight > list.scrollHeight - 200) {
          void marketplace.loadMore();
        }
      }}
    >
      {market.items.map((item) => (
        <MarketRow
          key={marketId(item.namespace, item.name)}
          item={item}
          installed={props.installedById.get(marketId(item.namespace, item.name))}
          onMenu={props.onMenu}
        />
      ))}
      {market.loadingMore ? <li className="ext-empty">{t("extensions.loadingMore")}</li> : null}
    </ul>
  );
}

/**
 * The side bar's Extensions view, laid out like VS Code's: a marketplace search
 * box with Filter and "…" menus, then Installed and Popular (or the search
 * results). Every marketplace entry comes from Open VSX's API.
 */
export function ExtensionsView() {
  const { registryState, ui, market } = useExtensionsState();
  const { registry, service, marketplace } = container.extensions;
  const filterTip = useQuietTitle(t("extensions.filterTitle"));
  const moreTip = useQuietTitle(t("common.moreActionsTitle"));
  const [menu, setMenu] = useState<OpenMenu>(null);
  useDismissOnOutside(menu !== null, () => {
    setMenu(null);
  });
  useEffect(() => {
    marketplace.start();
  }, [marketplace]);

  const installed = registry.all();
  const installedById = new Map(installed.map((extension) => [extension.id, extension]));
  const iconOf = new Map(market.items.map((i) => [marketId(i.namespace, i.name), i.iconUrl]));
  const query = market.query.trim();
  const installedOnly = query.toLowerCase().startsWith(INSTALLED_FILTER);
  const installedQuery = installedOnly
    ? query.slice(INSTALLED_FILTER.length).trim().toLowerCase()
    : "";
  const installedShown = installed.filter(
    (extension) =>
      installedQuery === "" ||
      `${displayName(extension)} ${extension.id} ${extension.manifest.description ?? ""}`
        .toLowerCase()
        .includes(installedQuery),
  );
  const openMenu = (items: PopupItem[], anchor: DOMRect, label: string) => {
    setMenu({ items, x: anchor.left, y: anchor.bottom + 2, label });
  };

  return (
    <div className="ext-view ext-view--market">
      <button type="button" className="ext-button" onClick={() => { void extensionWorkbench.show(); }}>Tests, Debug, Notebooks &amp; Source Control</button>
      <div className="ext-searchbar">
        <input
          type="search"
          className="ext-search"
          placeholder={t("extensions.search")}
          aria-label={t("extensions.search")}
          value={market.query}
          onChange={(event) => {
            marketplace.setQuery(event.target.value);
          }}
        />
        <button
          type="button"
          className="ext-search__action"
          title={filterTip.title}
          onMouseLeave={filterTip.onMouseLeave}
          aria-label={t("extensions.filter")}
          onMouseDown={(event) => {
            filterTip.onMouseDown();
            event.stopPropagation();
            openMenu(sortMenu(), event.currentTarget.getBoundingClientRect(), t("extensions.filter"));
          }}
        >
          <FilterIcon />
        </button>
        <button
          type="button"
          className="ext-search__action"
          title={moreTip.title}
          onMouseLeave={moreTip.onMouseLeave}
          aria-label={t("common.moreActions")}
          onMouseDown={(event) => {
            moreTip.onMouseDown();
            event.stopPropagation();
            openMenu(
              moreActionsMenu(),
              event.currentTarget.getBoundingClientRect(),
              t("common.moreActions"),
            );
          }}
        >
          <EllipsisIcon />
        </button>
      </div>
      <Notices />
      {installedOnly || query === "" ? (
        <Section title={t("extensions.installed")} count={installedShown.length} grow={installedOnly}>
          {installed.length > 0 ? <Updates /> : null}
          {registryState.snapshot === null && registryState.error === null ? (
            <p className="ext-empty">{t("extensions.loading")}</p>
          ) : installedShown.length === 0 ? (
            <p className="ext-empty">
              {installed.length === 0
                ? t("extensions.noneInstalled")
                : t("extensions.noInstalledMatch")}
            </p>
          ) : (
            <ul className="ext-items ext-items--installed" aria-label={t("extensions.installedList")}>
              {installedShown.map((extension) => (
                <InstalledRow
                  key={extension.id}
                  extension={extension}
                  iconUrl={iconOf.get(extension.id) ?? null}
                  onMenu={setMenu}
                />
              ))}
            </ul>
          )}
        </Section>
      ) : null}
      {installedOnly ? null : (
        <Section
          title={query === "" ? t("extensions.popular") : t("extensions.marketplace")}
          count={market.loading || !market.requested ? null : market.total}
          grow
        >
          <MarketList installedById={installedById} onMenu={setMenu} />
        </Section>
      )}
      {registryState.snapshot ? (
        <p className="ext-host-line" aria-label={t("extensions.hostStatus")}>
          {t("extensions.hostLine", { state: hostStateText(registryState.snapshot.host) })}
        </p>
      ) : null}
      {ui.logs !== null ? (
        <section className="ext-logs" aria-label={t("extensions.hostLog")}>
          <header>
            <h3>{t("extensions.hostLog")}</h3>
            <button
              type="button"
              className="ext-link"
              onClick={() => {
                service.openLogsFolder();
              }}
            >
              {t("extensions.openLogsFolder")}
            </button>
            <button
              type="button"
              className="ext-link"
              onClick={() => {
                service.hideLogs();
              }}
            >
              {t("common.close")}
            </button>
          </header>
          <pre>{ui.logs}</pre>
        </section>
      ) : null}
      {menu ? (
        <MenuPopup
          items={menu.items}
          x={menu.x}
          y={menu.y}
          ariaLabel={menu.label}
          onClose={() => {
            setMenu(null);
          }}
        />
      ) : null}
    </div>
  );
}

