import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { container } from "../services/container";
import { displayName, hostStateText, runtimeStatus } from "../services/extensionModel";
import { marketId } from "../services/extensionMarketplaceService";
import type { InstalledExtension } from "../services/extensionsIpc";
import type { MarketItem } from "../services/marketplaceIpc";
import "../styles/extensions.css";
import "../styles/extensionsMarket.css";
import { manageMenu, moreActionsMenu, sortMenu } from "./extensionMenus";
import { ExtensionListItem } from "./ExtensionListItem";
import { ChevronIcon, EllipsisIcon, FilterIcon } from "./icons";
import { MenuPopup, type PopupItem } from "./MenuPopup";
import { useDismissOnOutside } from "./useDismissOnOutside";

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
      dimmed={extension.enabled ? undefined : "Disabled"}
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
        label: extension.enabled ? "" : "Disabled",
        onManage: (anchor) => {
          props.onMenu({
            items: manageMenu(extension),
            x: anchor.left,
            y: anchor.bottom,
            label: "Manage",
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
              label: installed.enabled ? "" : "Disabled",
              onManage: (anchor) => {
                props.onMenu({
                  items: manageMenu(installed),
                  x: anchor.left,
                  y: anchor.bottom,
                  label: "Manage",
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
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}
      {problem !== null ? (
        <div className="ext-banner ext-banner--problem" role="alert">
          <p>{problem}</p>
          {node && !node.portable && node.system !== null && !node.allowSystem ? (
            <p className="ext-banner__hint">
              A Node.js was found at {node.system}. OpenMind Studio only uses it if you allow it.
            </p>
          ) : null}
          {node && !node.portable && node.system !== null && !node.allowSystem ? (
            <button
              type="button"
              className="ext-button"
              onClick={() => void service.allowSystemNode()}
            >
              Use System Node.js
            </button>
          ) : node && !node.portable ? (
            <button
              type="button"
              className="ext-button"
              onClick={() => {
                container.run("runtime.manage");
              }}
            >
              Install Node.js Runtime
            </button>
          ) : (
            <button type="button" className="ext-button" onClick={() => void host.reload()}>
              Restart Extension Host
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
        <p>Couldn't reach the marketplace (Open VSX).</p>
        <p className="ext-empty__hint">{market.error}</p>
        <button type="button" className="ext-button" onClick={() => void marketplace.refresh()}>
          Retry
        </button>
      </div>
    );
  }
  if (market.loading && market.items.length === 0) {
    return <p className="ext-empty">Loading…</p>;
  }
  if (market.items.length === 0) {
    return <p className="ext-empty">No extensions found.</p>;
  }
  return (
    <ul
      className="ext-items"
      aria-label="Marketplace extensions"
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
      {market.loadingMore ? <li className="ext-empty">Loading more…</li> : null}
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
      <div className="ext-searchbar">
        <input
          type="search"
          className="ext-search"
          placeholder="Search Extensions in Marketplace"
          aria-label="Search Extensions in Marketplace"
          value={market.query}
          onChange={(event) => {
            marketplace.setQuery(event.target.value);
          }}
        />
        <button
          type="button"
          className="ext-search__action"
          title="Filter Extensions..."
          aria-label="Filter Extensions"
          onMouseDown={(event) => {
            event.stopPropagation();
            openMenu(sortMenu(), event.currentTarget.getBoundingClientRect(), "Filter Extensions");
          }}
        >
          <FilterIcon />
        </button>
        <button
          type="button"
          className="ext-search__action"
          title="More Actions..."
          aria-label="More Actions"
          onMouseDown={(event) => {
            event.stopPropagation();
            openMenu(
              moreActionsMenu(),
              event.currentTarget.getBoundingClientRect(),
              "More Actions",
            );
          }}
        >
          <EllipsisIcon />
        </button>
      </div>
      <Notices />
      {installedOnly || query === "" ? (
        <Section title="Installed" count={installedShown.length} grow={installedOnly}>
          {registryState.snapshot === null && registryState.error === null ? (
            <p className="ext-empty">Loading extensions…</p>
          ) : installedShown.length === 0 ? (
            <p className="ext-empty">
              {installed.length === 0
                ? "No extensions installed."
                : "No installed extension matches."}
            </p>
          ) : (
            <ul className="ext-items ext-items--installed" aria-label="Installed extensions">
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
          title={query === "" ? "Popular" : "Marketplace"}
          count={market.loading ? null : market.total}
          grow
        >
          <MarketList installedById={installedById} onMenu={setMenu} />
        </Section>
      )}
      {registryState.snapshot ? (
        <p className="ext-host-line" aria-label="Extension host status">
          Extension host: {hostStateText(registryState.snapshot.host)}
        </p>
      ) : null}
      {ui.logs !== null ? (
        <section className="ext-logs" aria-label="Extension host log">
          <header>
            <h3>Extension host log</h3>
            <button
              type="button"
              className="ext-link"
              onClick={() => {
                service.openLogsFolder();
              }}
            >
              Open logs folder
            </button>
            <button
              type="button"
              className="ext-link"
              onClick={() => {
                service.hideLogs();
              }}
            >
              Close
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
