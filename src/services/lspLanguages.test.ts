import { describe, expect, it } from "vitest";

import { LSP_MONACO_LANGUAGES, lspLanguageId, monacoLanguageFor } from "./lspLanguages";

describe("lspLanguageId", () => {
  it("mirrors the backend for the bundled servers' languages", () => {
    expect(lspLanguageId("C:/My Site/app.tsx")).toBe("typescriptreact");
    expect(lspLanguageId(".github/ci.YML")).toBe("yaml");
    expect(lspLanguageId("scripts/build.sh")).toBe("shellscript");
    expect(lspLanguageId("src/main.rs")).toBe("rust");
    expect(lspLanguageId("inc/util.h")).toBe("c");
    expect(lspLanguageId("src/app.hpp")).toBe("cpp");
    expect(lspLanguageId("src/solver.F90")).toBe("fortran");
    expect(lspLanguageId("notes.txt")).toBeNull();
    expect(lspLanguageId("README")).toBeNull();
  });

  it("finds Dockerfiles by their whole name", () => {
    expect(lspLanguageId("C:/My App/Dockerfile")).toBe("dockerfile");
    expect(lspLanguageId("api/Dockerfile.prod")).toBe("dockerfile");
    expect(lspLanguageId("Containerfile")).toBe("dockerfile");
    expect(lspLanguageId("web.dockerfile")).toBe("dockerfile");
  });

  it("registers providers under Monaco's own language ids", () => {
    expect(monacoLanguageFor("shellscript")).toBe("shell");
    expect(monacoLanguageFor("typescriptreact")).toBe("typescript");
    for (const id of ["yaml", "shell", "dockerfile", "rust", "c", "cpp", "fortran"]) {
      expect(LSP_MONACO_LANGUAGES).toContain(id);
    }
  });
});
