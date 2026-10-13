/// <reference types="node" />
// The third-party licence notices (scripts/third-party-licenses.mjs) shipped with every package.
import { describe, expect, it } from "vitest";

import {
  fallbackIds,
  groupByText,
  noticesText,
  shippedPackageIds,
  withFallbackTexts,
} from "../../scripts/third-party-licenses.mjs";

const available = new Set(["MIT", "Apache-2.0", "BSD-3-Clause", "Zlib"]);

describe("third-party licence notices", () => {
  it("prints an identical licence text once, with every component that uses it", () => {
    const { groups, missing } = groupByText([
      { name: "a 1.0", license: "MIT", texts: [{ file: "LICENSE", text: "MIT text" }] },
      { name: "b 2.0", license: "MIT", texts: [{ file: "LICENSE-MIT", text: "MIT text" }] },
      { name: "c 3.0", license: "MIT", texts: [{ file: "LICENSE", text: "Copyright C\nMIT text" }] },
      { name: "d 4.0", license: "", texts: [] },
    ]);
    expect(groups.map((g) => g.users)).toEqual([["a 1.0", "b 2.0"], ["c 3.0"]]);
    expect(missing.map((c) => c.name)).toEqual(["d 4.0"]);
  });

  it("takes one licence of a choice but every licence of an AND, from the texts it has", () => {
    expect(fallbackIds("MIT OR Apache-2.0", available)).toEqual(["MIT"]);
    expect(fallbackIds("Zlib OR Apache-2.0 OR MIT", available)).toEqual(["Zlib"]);
    expect(fallbackIds("(Apache-2.0 AND BSD-3-Clause)", available)).toEqual(["Apache-2.0", "BSD-3-Clause"]);
    expect(fallbackIds("Apache-2.0 WITH LLVM-exception", available)).toEqual(["Apache-2.0"]);
    expect(fallbackIds("MIT/Apache-2.0", available)).toEqual(["MIT"]);
    expect(fallbackIds("LicenseRef-Proprietary", available)).toEqual([]);
  });

  it("fills in the declared licence's standard text only when the package has none, and says so", () => {
    const spdx = new Map([["MIT", "standard MIT"]]);
    const [own, filled, unknown] = withFallbackTexts(
      [
        { name: "own", license: "MIT", texts: [{ file: "LICENSE", text: "own text" }] },
        { name: "none", license: "MIT OR Apache-2.0", texts: [] },
        { name: "odd", license: "LicenseRef-X", texts: [] },
      ],
      spdx,
    );
    expect(own?.texts[0]?.text).toBe("own text");
    expect(filled?.texts[0]?.text).toMatch(/^\[MIT — standard text from the SPDX License List.*\]\n\nstandard MIT$/s);
    expect(unknown?.texts).toEqual([]);
  });

  it("follows normal and build dependencies but not dev-only ones", () => {
    const meta = {
      workspace_members: ["app"],
      resolve: {
        nodes: [
          {
            id: "app",
            deps: [
              { pkg: "runtime", dep_kinds: [{ kind: null }] },
              { pkg: "builder", dep_kinds: [{ kind: "build" }] },
              { pkg: "tester", dep_kinds: [{ kind: "dev" }] },
            ],
          },
          { id: "runtime", deps: [{ pkg: "nested", dep_kinds: [{ kind: null }] }] },
          { id: "tester", deps: [{ pkg: "only-tests", dep_kinds: [{ kind: null }] }] },
        ],
      },
    };
    expect([...shippedPackageIds(meta)].sort()).toEqual(["app", "builder", "nested", "runtime"]);
  });

  it("states that the project licence doesn't change anyone else's, and counts what is missing", () => {
    const { text, missing } = noticesText([
      { title: "Section", components: [{ name: "x 1", license: "MIT", texts: [] }] },
    ]);
    expect(text).toContain("does not change the licence of any of them");
    expect(text).toContain("Licence text not found");
    expect(missing).toBe(1);
  });
});
