import { describe, expect, it } from "vitest";

import { compilerName, compilerOf, pascalAbcSetup, type PascalStatus } from "./pascalModel";

const ready: PascalStatus = {
  compiler: "fpc",
  platformSupported: true,
  dotnetFramework: { version: "4.8.1", satisfied: true },
  bundledVersion: "4.0.0.3883",
  bundleProblem: null,
};

describe("Pascal compiler choice", () => {
  it("reads the setting like the backend: only `pascalabc` is PascalABC.NET", () => {
    expect(compilerOf("pascalabc")).toBe("pascalabc");
    expect(compilerOf(" pascalabc ")).toBe("pascalabc");
    for (const other of ["fpc", "", "PascalABC", "delphi"]) expect(compilerOf(other)).toBe("fpc");
    expect(compilerName("fpc")).toBe("Free Pascal");
    expect(compilerName("pascalabc")).toBe("PascalABC.NET");
  });
});

describe("PascalABC.NET card requirements", () => {
  it("shows a found .NET Framework, the included copy and that Free Pascal is still the choice", () => {
    expect(pascalAbcSetup(ready)).toEqual([
      { key: "pascal.setup.dotnetOk", values: { version: "4.8.1" }, problem: false },
      { key: "pascal.setup.bundled", values: { version: "4.0.0.3883" }, problem: false },
      { key: "pascal.setup.notChosen", problem: false },
    ]);
    expect(pascalAbcSetup({ ...ready, compiler: "pascalabc" }).at(-1)?.key).toBe("pascal.setup.usedByRunCode");
  });

  it("marks a missing or old .NET Framework as a problem", () => {
    expect(pascalAbcSetup({ ...ready, dotnetFramework: { version: null, satisfied: false } })[0]).toEqual({
      key: "pascal.setup.dotnetMissing",
      problem: true,
    });
    expect(pascalAbcSetup({ ...ready, dotnetFramework: { version: "4.7.1", satisfied: false } })[0]).toEqual({
      key: "pascal.setup.dotnetOld",
      values: { version: "4.7.1" },
      problem: true,
    });
  });

  it("says when the install will download, or why the included copy can't be used", () => {
    expect(pascalAbcSetup({ ...ready, bundledVersion: null })[1]?.key).toBe("pascal.setup.download");
    expect(pascalAbcSetup({ ...ready, bundledVersion: null, bundleProblem: "size differs" })[1]).toEqual({
      key: "pascal.setup.bundleProblem",
      values: { reason: "size differs" },
      problem: true,
    });
  });

  it("off Windows says only that it can't run here", () => {
    expect(pascalAbcSetup({ ...ready, platformSupported: false })).toEqual([
      { key: "pascal.setup.unsupportedPlatform", problem: true },
    ]);
  });
});
