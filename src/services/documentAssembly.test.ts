import { beforeAll, describe, expect, it, vi } from "vitest";

import { registerBuiltInLanguages } from "../editor/builtinLanguages";
import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";

const CONTENT: Record<string, string> = {
  "C:/p/hello.asm": "global main\nmain: ret\n",
  "C:/p/start.S": "\t.globl main\nmain: ret\n",
  "C:/p/macros.inc": "%macro print 1\n%endmacro\n",
  "C:/p/config.inc": "<?php\n$db = 1;\n",
};

beforeAll(() => {
  registerBuiltInLanguages();
});

describe("assembly documents", () => {
  it("open as NASM / GNU as (never Monaco's MIPS for .s) and an .inc only when its text is assembly", async () => {
    const ipc = createFakeIpc({
      documentOpen: vi.fn().mockImplementation((path: string) =>
        Promise.resolve({ path, content: CONTENT[path] ?? "", encoding: "utf8", lineEnding: "lf" }),
      ),
    });
    const service = new DocumentService(ipc, new BufferManager(), new EventBus<AppEvents>());
    // The language registry would say PHP for every .inc.
    service.setLanguageResolver((path) => (path.endsWith(".inc") ? "php" : null));
    expect(service.languageOf(await service.openFromPath("C:/p/hello.asm"))).toBe("nasm");
    expect(service.languageOf(await service.openFromPath("C:/p/start.S"))).toBe("gas");
    expect(service.languageOf(await service.openFromPath("C:/p/macros.inc"))).toBe("nasm");
    expect(service.languageOf(await service.openFromPath("C:/p/config.inc"))).toBe("php");
  });
});
