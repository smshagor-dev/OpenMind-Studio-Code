import { expect, it } from "vitest";
import { snippetUsesClipboard } from "./snippetClipboard";

it("detects real clipboard variables and ignores escaped text, similar names and transform literals", () => {
  for (const value of ["$CLIPBOARD", "${CLIPBOARD}", "${CLIPBOARD:fallback}", "${1:${CLIPBOARD}}", "${CLIPBOARD/(.*)/${1:/upcase}/}"]) expect(snippetUsesClipboard(value)).toBe(true);
  for (const value of ["plain", "\\$CLIPBOARD", "${1:literal}", "$CLIPBOARD_SUFFIX", "${1/(.*)/CLIPBOARD/}"]) expect(snippetUsesClipboard(value)).toBe(false);
});
