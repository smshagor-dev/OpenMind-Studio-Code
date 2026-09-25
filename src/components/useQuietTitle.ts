import { useState } from "react";

/**
 * A button's tooltip, dropped while the pointer presses it: the menu it opens appears under the
 * pointer, and the native tooltip would sit on top of its first row. It comes back on leaving the button.
 */
export function useQuietTitle(title: string) {
  const [quiet, setQuiet] = useState(false);
  return {
    title: quiet ? undefined : title,
    onMouseDown: () => {
      setQuiet(true);
    },
    onMouseLeave: () => {
      setQuiet(false);
    },
  };
}
