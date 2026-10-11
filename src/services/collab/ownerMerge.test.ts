import { describe, expect, it } from "vitest";

import { mergeOwnerText } from "./ownerMerge";

const BASE = "export function greet(name) {\n  return name;\n}\n";

describe("the Owner's unsaved edits meeting a shared document", () => {
  it("keeps the editor's edits when the shared document is still the saved text (the room started later)", () => {
    const ours = `// mine\n${BASE}`;
    expect(mergeOwnerText(BASE, ours, BASE)).toEqual({ kind: "useText", text: ours });
  });

  it("keeps the shared document when the editor has no edits of its own (recovered accepted changes)", () => {
    const shared = `Acrash1 Bcrash1 ${BASE}`;
    expect(mergeOwnerText(BASE, BASE, shared)).toEqual({ kind: "keepShared" });
    expect(mergeOwnerText(BASE, shared, shared)).toEqual({ kind: "keepShared" });
  });

  it("keeps both when they changed different places (the crash case: typed after a restart)", () => {
    // Recovered accepted edits at the end, the Owner typed at the start after restarting.
    const shared = `${BASE}// from Ana\n`;
    const ours = `Apost ${BASE}`;
    expect(mergeOwnerText(BASE, ours, shared)).toEqual({
      kind: "useText",
      text: `Apost ${BASE}// from Ana\n`,
    });
    // And the other way round.
    expect(mergeOwnerText(BASE, `${BASE}// mine\n`, `// shared\n${BASE}`)).toEqual({
      kind: "useText",
      text: `// shared\n${BASE}// mine\n`,
    });
  });

  it("never drops either side when they overlap: a conflict to keep apart", () => {
    const shared = BASE.replace("return name;", "return `Hi ${name}`;");
    const ours = BASE.replace("return name;", "return name.trim();");
    expect(mergeOwnerText(BASE, ours, shared)).toEqual({ kind: "conflict" });
    // Two insertions at the very same place have no safe order either.
    expect(mergeOwnerText(BASE, `A${BASE}`, `B${BASE}`)).toEqual({ kind: "conflict" });
  });
});
