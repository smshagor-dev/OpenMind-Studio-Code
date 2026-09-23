import { useEffect } from "react";

/**
 * While `active`, closes a popup on any outside mouse-down, window blur, or
 * window resize. Popups stop mousedown propagation on themselves, so clicks
 * inside them don't count as "outside".
 */
export function useDismissOnOutside(active: boolean, close: () => void): void {
  useEffect(() => {
    if (!active) return;
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [active, close]);
}
