/**
 * The arithmetic behind the editor tab row's horizontal scrolling (VS Code's behaviour), kept apart from the DOM so it
 * can be tested exactly: how far one wheel event moves the row, and where the row must scroll so a tab is fully seen.
 */

/** How many pixels one wheel "line" moves (Firefox and some mice report lines rather than pixels). */
const LINE_PX = 16;

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
}

/**
 * The horizontal distance a wheel event should scroll the tab row. A trackpad's sideways swipe (mostly `deltaX`) is used
 * as it is; an ordinary vertical wheel — with or without Shift — moves the row sideways, as in VS Code. Line and page
 * units are converted to pixels (`pageWidth` is the row's visible width).
 */
export function wheelDistance(input: WheelInput, pageWidth: number): number {
  const sideways = Math.abs(input.deltaX) > Math.abs(input.deltaY);
  const delta = sideways ? input.deltaX : input.deltaY;
  if (input.deltaMode === 1) return delta * LINE_PX;
  if (input.deltaMode === 2) return delta * pageWidth;
  return delta;
}

/**
 * The `scrollLeft` that shows the whole tab (`tabLeft`/`tabWidth` measured inside the row), or `null` when it is already
 * fully visible. A tab wider than the row is aligned to its start.
 */
export function revealScrollLeft(
  scrollLeft: number,
  viewWidth: number,
  tabLeft: number,
  tabWidth: number,
): number | null {
  const tabRight = tabLeft + tabWidth;
  if (tabLeft < scrollLeft) return tabLeft;
  if (tabRight > scrollLeft + viewWidth) return tabWidth >= viewWidth ? tabLeft : tabRight - viewWidth;
  return null;
}

/** Whether the row has tabs hidden past one of its edges (nothing to scroll otherwise). */
export function overflows(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth - clientWidth > 1;
}
