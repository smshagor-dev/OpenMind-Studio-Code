import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import "@testing-library/jest-dom/vitest";

// @testing-library/react's automatic per-test cleanup only registers itself
// when it detects a global `afterEach` (Vitest's `globals: true` mode).
// This project keeps globals off (explicit imports everywhere else), so
// cleanup is wired up manually here instead.
afterEach(cleanup);

// jsdom doesn't implement every browser API monaco-editor's default bundle
// touches at import time (it ships all editor contributions, e.g.
// clipboard, unconditionally). These are environment gaps, not app code —
// stub only what's needed to let real monaco-editor modules load under
// Vitest.
/* eslint-disable @typescript-eslint/no-deprecated -- monaco-editor's bundle calls this deprecated API internally; jsdom doesn't implement it at all */
if (typeof document.queryCommandSupported !== "function") {
  document.queryCommandSupported = () => false;
}
/* eslint-enable @typescript-eslint/no-deprecated */

if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (typeof globalThis.ResizeObserver !== "function") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
}
