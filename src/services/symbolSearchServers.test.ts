import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import type { SymbolHit } from "./searchIpc";
import { mergeSymbolHits, SymbolSearchService } from "./symbolSearchService";

function hit(name: string, path: string, line: number, extra: Partial<SymbolHit> = {}): SymbolHit {
  return {
    name,
    kind: "function",
    line,
    column: 1,
    container: null,
    path,
    relativePath: path.split("/").pop() ?? path,
    language: null,
    score: 0,
    ...extra,
  };
}

describe("workspace symbols from language servers", () => {
  it("come first, filtered by kind, without repeating the index's copy of the same symbol", () => {
    const servers = [
      hit("circle_area", "C:/w/src/shapes.f90", 7, { language: "fortran" }),
      hit("shapes", "C:/w/src/shapes.f90", 1, { kind: "module" }),
    ];
    const index = [hit("circle_area", "C:\\W\\src\\shapes.f90", 7), hit("startServer", "C:/w/app.ts", 3)];
    expect(mergeSymbolHits(servers, index, null, 10).map((h) => h.name)).toEqual(["circle_area", "shapes", "startServer"]);
    expect(mergeSymbolHits(servers, index, "module", 10).map((h) => h.name)).toEqual(["shapes", "circle_area", "startServer"]);
    expect(mergeSymbolHits(servers, index, null, 1)).toHaveLength(1);
  });

  const rig = (serverHits: SymbolHit[] | Error, hasFiles = true) => {
    const ipc = createFakeIpc({
      searchSymbolsIndexed: vi.fn().mockResolvedValue([hit("startServer", "C:/w/app.ts", 3)]),
    });
    const fromServers = vi.fn(() =>
      serverHits instanceof Error ? Promise.reject(serverHits) : Promise.resolve(serverHits),
    );
    const service = new SymbolSearchService(
      ipc,
      { openPathAt: vi.fn().mockResolvedValue("tab") },
      () => "C:/w",
      () => hasFiles,
      fromServers,
    );
    return { service, fromServers };
  };

  it("are asked for with the query and shown with the index's results (Ctrl+T)", async () => {
    const { service, fromServers } = rig([hit("circle_area", "C:/w/src/shapes.f90", 7, { language: "fortran" })]);
    service.setQuery("circ");
    await vi.waitFor(() => {
      expect(service.getState().status).toBe("done");
    });
    expect(fromServers).toHaveBeenCalledWith("circ", 200);
    expect(service.getState().results.map((h) => h.name)).toEqual(["circle_area", "startServer"]);
  });

  it("a failing server leaves the index's results; an empty query doesn't ask servers", async () => {
    const failing = rig(new Error("fortls stopped"));
    failing.service.setQuery("start");
    await vi.waitFor(() => {
      expect(failing.service.getState().status).toBe("done");
    });
    expect(failing.service.getState().results.map((h) => h.name)).toEqual(["startServer"]);

    const empty = rig([]);
    await empty.service.run();
    expect(empty.fromServers).not.toHaveBeenCalled();
  });

  it("answer even while the index is still empty (Fortran isn't in the index at all)", async () => {
    const { service } = rig([hit("circle_area", "C:/w/src/shapes.f90", 7)], false);
    service.setQuery("circle");
    await vi.waitFor(() => {
      expect(service.getState().status).toBe("done");
    });
    expect(service.getState().results.map((h) => h.name)).toEqual(["circle_area"]);
  });
});
