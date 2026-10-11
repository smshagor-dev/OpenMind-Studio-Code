import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const previews = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../services/container", () => ({
  container: {
    filePreviews: { get: (id: string) => previews.get(id) },
    run: vi.fn(),
    explorer: { revealPath: vi.fn() },
  },
}));

import { Breadcrumbs } from "./Breadcrumbs";
import { isRemotePath, shownPath } from "./remoteTabPath";

const ROOM_ID = "2aeb40d67879f70f7390a6bfaa808cdc";
const FILE_ID = "f3b1c0de9a8b7c6d5e4f30211a0b9c8d";
const ADDRESS = `omcollab://${ROOM_ID}/${FILE_ID}`;

function remoteDoc(id: string, origin: { room: string; path: string } | null) {
  previews.set(id, {
    model: {
      type: "virtualText",
      text: "",
      language: "typescript",
      extension: "ts",
      readonly: false,
      ...(origin
        ? { collab: { roomUid: ROOM_ID, fileId: FILE_ID, sha256: "x", state: "live", ...origin } }
        : {}),
    },
  });
}

afterEach(() => {
  cleanup();
  previews.clear();
});

describe("a remote collaboration document's breadcrumbs and tooltip", () => {
  it("show the shared folder and the path inside it, never the room or file id", () => {
    remoteDoc("pv:1", { room: "Shared Project", path: "src/main.ts" });
    const { container } = render(
      <Breadcrumbs path={ADDRESS} title="main.ts" rootPath={null} docId="pv:1" />,
    );
    const text = container.textContent;
    expect(
      [...container.querySelectorAll(".breadcrumbs__label")].map((b) => b.textContent),
    ).toEqual(["Shared Project", "src", "main.ts"]);
    expect(text).not.toContain(ROOM_ID);
    expect(text).not.toContain(FILE_ID);
    expect(text).not.toContain("omcollab");
    expect(shownPath(ADDRESS, "pv:1", "main.ts")).toBe("Shared Project/src/main.ts");
  });

  it("fall back to the title alone when the origin isn't known", () => {
    remoteDoc("pv:2", null);
    const { container } = render(
      <Breadcrumbs path={ADDRESS} title="main.ts" rootPath={null} docId="pv:2" />,
    );
    expect(container.textContent).toBe("main.ts");
    expect(shownPath(ADDRESS, "pv:2", "main.ts")).toBe("main.ts");
    expect(shownPath(ADDRESS.toUpperCase(), "missing", "main.ts")).toBe("main.ts");
  });

  it("leave ordinary files alone", () => {
    expect(isRemotePath("C:/work/src/main.ts")).toBe(false);
    expect(shownPath("C:/work/src/main.ts", "doc-1", "main.ts")).toBe("C:/work/src/main.ts");
    expect(shownPath(null, "doc-1", "Untitled-1")).toBeNull();
    const { container } = render(
      <Breadcrumbs path="C:/work/src/main.ts" title="main.ts" rootPath="C:/work" docId="doc-1" />,
    );
    expect(container.textContent).toContain("main.ts");
  });
});
