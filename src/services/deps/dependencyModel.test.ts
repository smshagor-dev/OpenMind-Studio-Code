import { describe, expect, it } from "vitest";

import { diagnoseDependency, isMissingInputError, needsInteractiveInput, npmPackageOf } from "./dependencyModel";

describe("diagnoseDependency: Python", () => {
  it("a missing third-party package gets the pip name", () => {
    expect(diagnoseDependency("ModuleNotFoundError: No module named 'requests'")).toEqual({
      kind: "pythonPackage",
      module: "requests",
      package: "requests",
      guessed: false,
    });
    expect(diagnoseDependency("  File \"x.py\", line 1\nModuleNotFoundError: No module named 'pandas'")).toMatchObject({
      package: "pandas",
      guessed: false,
    });
    // Import names that differ from the package, and the old ImportError wording.
    expect(diagnoseDependency("ModuleNotFoundError: No module named 'cv2'")).toMatchObject({ package: "opencv-python", guessed: false });
    expect(diagnoseDependency("ModuleNotFoundError: No module named 'PIL'")).toMatchObject({ package: "Pillow" });
    expect(diagnoseDependency("ImportError: No module named yaml")).toMatchObject({ package: "PyYAML" });
    // A sub-module is the top-level package; an unknown name is only a guess.
    expect(diagnoseDependency("ModuleNotFoundError: No module named 'sklearn.linear_model'")).toMatchObject({ package: "scikit-learn" });
    expect(diagnoseDependency("ModuleNotFoundError: No module named 'foobarlib'")).toMatchObject({ package: "foobarlib", guessed: true });
  });

  it("tkinter and other parts of Python are never pip packages", () => {
    for (const module of ["tkinter", "_tkinter", "turtle"]) {
      expect(diagnoseDependency(`ModuleNotFoundError: No module named '${module}'`)).toEqual({
        kind: "pythonComponent",
        module,
        tk: true,
      });
    }
    for (const module of ["sqlite3", "_sqlite3", "ssl", "ctypes", "venv"]) {
      expect(diagnoseDependency(`ModuleNotFoundError: No module named '${module}'`)).toEqual({
        kind: "pythonComponent",
        module,
        tk: false,
      });
    }
    // Tcl/Tk files missing from an installed tkinter.
    expect(diagnoseDependency("_tkinter.TclError: Can't find a usable init.tcl in the following directories")).toEqual({
      kind: "pythonComponent",
      module: "tkinter",
      tk: true,
    });
  });
});

describe("diagnoseDependency: Node, commands and headers", () => {
  it("a missing npm module gets its package; built-ins and local files don't", () => {
    expect(diagnoseDependency("Error: Cannot find module 'lodash'\nRequire stack:")).toEqual({
      kind: "nodePackage",
      module: "lodash",
      package: "lodash",
    });
    expect(diagnoseDependency("Error: Cannot find module 'lodash/fp'")).toMatchObject({ package: "lodash" });
    expect(diagnoseDependency("Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@scope/pkg' imported from x")).toMatchObject({
      package: "@scope/pkg",
    });
    expect(diagnoseDependency("Error: Cannot find module './helpers'")).toBeNull();
    expect(diagnoseDependency("Error: Cannot find module 'C:\\work\\app.js'")).toBeNull();
    expect(npmPackageOf("fs")).toBeNull();
    expect(npmPackageOf("node:path")).toBeNull();
    expect(npmPackageOf("Bad Name")).toBeNull();
  });

  it("a missing compiler or runtime points to its Runtime Manager item in every shell's wording", () => {
    const cases: [string, string, string | null][] = [
      ["javac : The term 'javac' is not recognized as the name of a cmdlet, function, script file", "javac", "jdk"],
      ["'gcc' is not recognized as an internal or external command,", "gcc", "llvm-mingw"],
      ["bash: g++: command not found", "g++", "llvm-mingw"],
      ["java : The term 'java' is not recognized", "java", "jdk"],
      ["'rustc' is not recognized as an internal or external command,", "rustc", null],
      ["npm : The term 'npm' is not recognized", "npm", "node"],
    ];
    for (const [text, tool, runtime] of cases) {
      expect(diagnoseDependency(text), text).toMatchObject({ kind: "toolMissing", tool, runtime });
    }
    // An unknown command isn't guessed at.
    expect(diagnoseDependency("'foo' is not recognized as an internal or external command,")).toBeNull();
  });

  it("a missing C/C++ header is reported, never fixed", () => {
    expect(diagnoseDependency("main.c:1:10: fatal error: curl/curl.h: No such file or directory")).toEqual({
      kind: "headerMissing",
      header: "curl/curl.h",
    });
    expect(diagnoseDependency("main.cpp:2:10: fatal error: 'boost/asio.hpp' file not found")).toMatchObject({
      header: "boost/asio.hpp",
    });
  });

  it("ordinary output is nothing", () => {
    for (const text of ["Hello", "Successfully installed six-1.17.0", "Status: Adult", "ERROR: No matching distribution found for x"]) {
      expect(diagnoseDependency(text), text).toBeNull();
    }
  });
});

describe("interactive input", () => {
  it("recognizes programs that read the keyboard in the languages Run Code runs", () => {
    expect(needsInteractiveInput("py", 'name = input("Enter your name: ")')).toBe(true);
    // What `extensionOf` returns (with the dot) works the same.
    expect(needsInteractiveInput(".py", 'age = int(input("Enter your age: "))')).toBe(true);
    expect(needsInteractiveInput("py", "import sys\ndata = sys.stdin.read()")).toBe(true);
    expect(needsInteractiveInput("py", "print('hi')\nuser_input = 3")).toBe(false);
    expect(needsInteractiveInput("py", "value = obj.input(3)")).toBe(false);
    expect(needsInteractiveInput("js", "const rl = readline.createInterface({ input: process.stdin })")).toBe(true);
    expect(needsInteractiveInput("ts", "console.log(1)")).toBe(false);
    expect(needsInteractiveInput("php", "$name = trim(fgets(STDIN));")).toBe(true);
    // Not a Run Code language: the terminal is the place anyway.
    expect(needsInteractiveInput("c", "scanf(\"%d\", &age);")).toBe(false);
    expect(isMissingInputError("EOFError: EOF when reading a line")).toBe(true);
    expect(isMissingInputError("Status: Adult")).toBe(false);
  });
});
