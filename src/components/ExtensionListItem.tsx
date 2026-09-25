import { useState } from "react";

import { formatCount } from "../services/extensionMarketplaceService";
import { CloudDownloadIcon, ExtensionsIcon, GearIcon, StarIcon, VerifiedIcon } from "./icons";

export interface ListItemProps {
  name: string;
  description: string;
  publisher: string;
  verified: boolean;
  iconUrl: string | null;
  downloads: number | null;
  rating: number | null;
  /** Grey the row out (a disabled extension), and say why in the name's tooltip. */
  dimmed?: string;
  /** A problem to show under the description (e.g. the runtime it needs is missing). */
  problem?: string | null;
  selected: boolean;
  onOpen: () => void;
  action: ItemAction;
}

export type ItemAction =
  | { kind: "install"; busy: string | null; onInstall: () => void }
  | { kind: "installed"; label: string; onManage: (anchor: DOMRect) => void };

/** The extension's icon, or the Extensions glyph when it has none (or it fails to load). */
export function ExtensionIcon({ url, size }: { url: string | null; size: number }) {
  const [failed, setFailed] = useState(false);
  if (url === null || failed) {
    return (
      <span className="ext-icon ext-icon--default" style={{ width: size, height: size }}>
        <ExtensionsIcon size={Math.round(size * 0.6)} />
      </span>
    );
  }
  return (
    <img
      className="ext-icon"
      src={url}
      alt=""
      width={size}
      height={size}
      draggable={false}
      onError={() => {
        setFailed(true);
      }}
    />
  );
}

/** One row of the Extensions view, laid out like VS Code's. */
export function ExtensionListItem(props: ListItemProps) {
  const { action } = props;
  return (
    <li
      className={props.selected ? "ext-item ext-item--selected" : "ext-item"}
      data-dimmed={props.dimmed !== undefined}
    >
      <button
        type="button"
        className="ext-item__open"
        aria-label={`${props.name}, ${props.publisher}`}
        onClick={props.onOpen}
      >
        <ExtensionIcon url={props.iconUrl} size={42} />
        <span className="ext-item__body">
          <span className="ext-item__top">
            <span className="ext-item__name" title={props.dimmed ?? props.name}>
              {props.name}
            </span>
            <span className="ext-item__stats">
              {props.downloads !== null ? (
                <span className="ext-item__stat" title={`${String(props.downloads)} installs`}>
                  <CloudDownloadIcon size={14} />
                  {formatCount(props.downloads)}
                </span>
              ) : null}
              {props.rating !== null ? (
                <span
                  className="ext-item__stat"
                  title={`Average rating: ${props.rating.toFixed(1)} out of 5`}
                >
                  <StarIcon size={13} filled />
                  {props.rating.toFixed(1)}
                </span>
              ) : null}
            </span>
          </span>
          <span className="ext-item__desc">{props.description}</span>
          {props.problem ? <span className="ext-item__problem">{props.problem}</span> : null}
          <span className="ext-item__bottom">
            <span className="ext-item__publisher">
              {props.verified ? (
                <span className="ext-verified" title="Verified publisher">
                  <VerifiedIcon size={13} />
                </span>
              ) : null}
              {props.publisher}
            </span>
          </span>
        </span>
      </button>
      <span className="ext-item__action">
        {action.kind === "install" ? (
          <button
            type="button"
            className="ext-install-button"
            disabled={action.busy !== null}
            onClick={action.onInstall}
          >
            {action.busy ?? "Install"}
          </button>
        ) : (
          <>
            <span className="ext-item__state">{action.label}</span>
            <button
              type="button"
              className="ext-item__manage"
              title="Manage"
              aria-label={`Manage ${props.name}`}
              onClick={(event) => {
                action.onManage(event.currentTarget.getBoundingClientRect());
              }}
            >
              <GearIcon size={16} />
            </button>
          </>
        )}
      </span>
    </li>
  );
}
