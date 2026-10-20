import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { addBuildProblem, parseBuildLine, parseBuildProblem, problemPath, type BuildProblemFile } from "./buildProblems";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { CodeRunEvent, IpcClient } from "./ipc";
import { OutputService } from "./outputService";
import type { PanelService } from "./panelService";
import type { RunConfigurationService } from "./runConfigurationService";
import { RunCodeService } from "./runCodeService";
import type { TerminalService } from "./terminalService";
import type { WorkspaceService } from "./workspaceService";

// Lines exactly as gfortran 13 (`-fdiagnostics-plain-output`), Free Pascal 3.2 (`-vwn`) and ld print them.
const GFORTRAN_ERROR = "E:\\My Work\\app src\\main.f90:3:12: Error: Symbol 'y' at (1) has no IMPLICIT type";
const GFORTRAN_MODULE = "E:\\My Work\\app src\\main.f90:2:7: Fatal Error: Cannot open module file 'mathx.mod' for reading at (1): No such file or directory";
const GFORTRAN_WARNING = "E:\\My Work\\app src\\mathx.f90:5:14: Warning: Array reference at (1) is out of bounds (5 > 3) in dimension 1";
const FPC_ERROR = 'hello world.pas(3,11) Error: Identifier not found "zz"';
const FPC_WARNING = 'hello world.pas(5,8) Warning: Variable "i" does not seem to be initialized';
const FPC_UNIT = 'greet.pas(7,3) Error: Identifier not found "x"';
const FPC_HINT = 'app.pas(2,6) Hint: Unit "sysutils" not used in app';
const LD_UNDEFINED =
  "C:\\app\\runtimes\\fortran\\versions\\13.1.0\\bin/ld.exe: C:\\Users\\me\\AppData\\Local\\Temp\\ccCeKZOs.o:link.f90:(.text+0x9): undefined reference to `nothere_'";

describe("compiler lines", () => {
  it("reads gfortran's plain diagnostics with the file it names", () => {
    expect(parseBuildLine(GFORTRAN_ERROR)).toMatchObject({
      file: "E:\\My Work\\app src\\main.f90",
      problem: { severity: "error", line: 3, column: 12, message: "Symbol 'y' at (1) has no IMPLICIT type" },
    });
    expect(parseBuildProblem(GFORTRAN_MODULE)).toMatchObject({ severity: "error", line: 2, column: 7 });
    expect(parseBuildProblem(GFORTRAN_WARNING)).toMatchObject({ severity: "warning", line: 5, column: 14 });
  });

  it("reads Free Pascal's errors, warnings and hints", () => {
    expect(parseBuildLine(FPC_ERROR)).toMatchObject({
      file: "hello world.pas",
      problem: { severity: "error", line: 3, column: 11, message: 'Identifier not found "zz"' },
    });
    expect(parseBuildProblem(FPC_WARNING)).toMatchObject({ severity: "warning", line: 5, column: 8 });
    expect(parseBuildProblem(FPC_HINT)).toMatchObject({ severity: "info", line: 2 });
    expect(parseBuildProblem("bad.pas(5) Fatal: There were 1 errors compiling module, stopping")).toBeNull();
    expect(parseBuildProblem("link.pas(5,1) Fatal: There were 2 errors compiling module, stopping")).toBeNull();
    expect(parseBuildProblem("bad.pas(5) Fatal: Can't open include file \"x.inc\"")).toMatchObject({
      severity: "error",
      line: 5,
      column: 1,
    });
  });

  it("reads PascalABC.NET's errors, exactly as pabcnetcclear 4.0.0.3883 prints them", () => {
    expect(parseBuildLine("[2,21] bad.pas: Incompatible types: 'string' and 'integer'")).toEqual({
      file: "bad.pas",
      problem: {
        severity: "error",
        message: "Incompatible types: 'string' and 'integer'",
        source: "compiler",
        line: 2,
        column: 21,
        endLine: 2,
        endColumn: 22,
      },
    });
    expect(parseBuildLine("[12,5] привет мир.pas: Неизвестное имя 'y'")).toMatchObject({
      file: "привет мир.pas",
      problem: { line: 12, column: 5, message: "Неизвестное имя 'y'" },
    });
    // Its other lines are not problems.
    expect(parseBuildLine("Compile errors:")).toBeNull();
    expect(parseBuildLine("OK")).toBeNull();
    // Filed next to the built file, so a click opens the source the compiler named.
    expect(problemPath("C:\\Work\\My Project\\bad.pas", "bad.pas")).toBe("C:\\Work\\My Project\\bad.pas");
  });

  it("puts a linker's undefined reference on the built file and ignores plain lines", () => {
    expect(parseBuildLine(LD_UNDEFINED)).toMatchObject({
      file: null,
      problem: { severity: "error", line: 1, message: "undefined reference to `nothere_' (linker)" },
    });
    expect(parseBuildLine("collect2.exe: error: ld returned 1 exit status")).toBeNull();
    expect(parseBuildLine("Fatal: Compilation aborted")).toBeNull();
    expect(parseBuildLine("compilation terminated.")).toBeNull();
  });

  it("files a problem under the file the compiler named, next to the built file when relative", () => {
    const built = "E:\\My Work\\app src\\main.f90";
    expect(problemPath(built, null)).toBe(built);
    expect(problemPath(built, "e:/my work/app src/MAIN.f90")).toBe(built);
    expect(problemPath(built, "E:\\My Work\\app src\\mathx.f90")).toBe("E:\\My Work\\app src\\mathx.f90");
    expect(problemPath("C:/p/pas app/hello world.pas", "greet.pas")).toBe("C:/p/pas app/greet.pas");
  });

  it("groups per file and keeps a repeated line once", () => {
    const built = "C:/p/pas app/hello world.pas";
    let files: BuildProblemFile[] = [];
    for (const line of [FPC_ERROR, FPC_WARNING, FPC_UNIT, FPC_ERROR]) {
      const parsed = parseBuildLine(line);
      if (parsed) files = addBuildProblem(files, built, parsed);
    }
    expect(files.map((file) => [file.title, file.problems.length])).toEqual([
      ["hello world.pas", 2],
      ["greet.pas", 1],
    ]);
    expect(files[0]?.path).toBe(built);
  });
});

describe("Run Code's build problems", () => {
  async function service() {
    let handler: (event: CodeRunEvent) => void = () => undefined;
    const ipc: IpcClient = createFakeIpc({
      onRunEvent: vi.fn((h: typeof handler) => {
        handler = h;
        return Promise.resolve(() => undefined);
      }),
    });
    const setExternal = vi.fn();
    const workspace = {
      getState: () => ({ tabs: [], activeId: null, groups: [], activeGroupId: "group-1", weights: [1] }),
      getActiveWorkspace: () => null,
    } as unknown as WorkspaceService;
    const run = new RunCodeService(
      ipc,
      new EventBus<AppEvents>(),
      new OutputService(),
      workspace,
      { subscribe: () => () => undefined, templateFor: () => null } as unknown as RunConfigurationService,
      {} as unknown as TerminalService,
      {} as unknown as PanelService,
      undefined,
      undefined,
      { setExternal },
    );
    await run.initialize();
    return {
      emit: (event: CodeRunEvent) => {
        handler(event);
      },
      setExternal,
    };
  }

  const building = (runId: string): CodeRunEvent => ({
    type: "building",
    runId,
    file: "E:\\My Work\\app src\\main.f90",
    language: "Fortran",
    commandLine: "gfortran mathx.f90 main.f90 -o main.exe",
    cwd: "E:\\My Work",
    runtime: "OpenMind portable gfortran (fortran 13.1.0)",
    compiler: "C:\\app\\runtimes\\fortran\\versions\\13.1.0\\bin\\gfortran.exe",
    pid: 1,
  });
  const line = (runId: string, text: string): CodeRunEvent => ({ type: "output", runId, stream: "stderr", line: text, phase: "build" });

  it("shows each file's problems and drops them when the next build starts", async () => {
    const r = await service();
    r.emit(building("run-1"));
    r.emit(line("run-1", GFORTRAN_ERROR));
    r.emit(line("run-1", GFORTRAN_WARNING));
    r.emit(line("run-1", "compilation terminated."));

    const owner = "run:E:\\My Work\\app src\\main.f90";
    const last = r.setExternal.mock.calls.at(-1) as [string, BuildProblemFile[]];
    expect(last[0]).toBe(owner);
    expect(last[1].map((file) => [file.title, file.problems[0]?.severity, file.problems[0]?.line])).toEqual([
      ["main.f90", "error", 3],
      ["mathx.f90", "warning", 5],
    ]);

    // The fixed file builds again: the old entries are cleared at once, and a clean build adds none.
    r.emit(building("run-2"));
    expect(r.setExternal).toHaveBeenLastCalledWith(owner, []);
    r.emit({ type: "built", runId: "run-2", success: true, code: 0, durationMs: 10 });
    expect(r.setExternal).toHaveBeenLastCalledWith(owner, []);
  });
});
