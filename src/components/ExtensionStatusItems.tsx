import { useSyncExternalStore, type CSSProperties } from "react";

import { container } from "../services/container";
import { COLOR_TOKENS, type StatusBarItemView } from "../services/statusBarItemsService";

function styleOf(item: StatusBarItemView): CSSProperties | undefined {
  const style: CSSProperties = {};
  if (item.color !== null) style.color = COLOR_TOKENS[item.color];
  if (item.background !== null) style.backgroundColor = COLOR_TOKENS[item.background];
  return Object.keys(style).length > 0 ? style : undefined;
}

/**
 * The status bar items extensions created, on one side. Text is plain (React text, never HTML), long text is
 * cut with an ellipsis and its full text goes in the tooltip; an item with a command is a button.
 */
export function ExtensionStatusItems({ alignment }: { alignment: "left" | "right" }) {
  const { statusBar } = container.extensions;
  useSyncExternalStore(
    (listener) => statusBar.subscribe(listener),
    () => statusBar.getItems(),
  );
  return (
    <>
      {statusBar.itemsOf(alignment).map((item) => {
        const title = item.tooltip !== "" ? item.tooltip : item.text;
        const label = `${item.text} (${item.extension})`;
        return item.command === null ? (
          <span
            key={item.id}
            className="statusbar__item statusbar__item--extension"
            title={title}
            aria-label={label}
            style={styleOf(item)}
          >
            {item.text}
          </span>
        ) : (
          <button
            key={item.id}
            type="button"
            className="statusbar__item statusbar__item--extension"
            title={title}
            aria-label={label}
            style={styleOf(item)}
            onClick={() => {
              statusBar.click(item.id);
            }}
          >
            {item.text}
          </button>
        );
      })}
    </>
  );
}
