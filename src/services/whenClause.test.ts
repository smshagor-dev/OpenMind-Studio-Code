import { describe, expect, it } from "vitest";

import { evaluateWhen } from "./whenClause";

describe("evaluateWhen", () => {
  const empty = { workbenchState: "empty", workspaceFolderCount: 0 };
  const folder = { workbenchState: "folder", workspaceFolderCount: 1 };

  it("handles ==, !=, !, bare keys, true/false, && and ||", () => {
    expect(evaluateWhen("workbenchState == empty", empty)).toBe(true);
    expect(evaluateWhen("workbenchState != empty", empty)).toBe(false);
    expect(evaluateWhen("workbenchState == 'folder'", folder)).toBe(true);
    expect(evaluateWhen("workspaceFolderCount == 0", empty)).toBe(true);
    expect(evaluateWhen("!workspaceFolderCount", empty)).toBe(true);
    expect(evaluateWhen("workspaceFolderCount", folder)).toBe(true);
    expect(evaluateWhen("workbenchState != empty && workspaceFolderCount", folder)).toBe(true);
    expect(evaluateWhen("false || workbenchState == folder", folder)).toBe(true);
    expect(evaluateWhen("true && false", folder)).toBe(false);
  });

  it("an empty clause holds, an unknown key is false, unsupported syntax is shown", () => {
    expect(evaluateWhen(null, empty)).toBe(true);
    expect(evaluateWhen("", empty)).toBe(true);
    expect(evaluateWhen("config.x.enabled", empty)).toBe(false);
    expect(evaluateWhen("resourceFilename =~ /foo/", empty)).toBe(true);
  });
});
