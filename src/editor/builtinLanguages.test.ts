import * as monaco from "monaco-editor";
import { beforeAll, describe, expect, it } from "vitest";

import { registerBuiltInLanguages } from "./builtinLanguages";
import { languageForPath } from "./languageForPath";

/** `[text, token]` pairs of a line, so a test reads like the code it checks. */
function tokens(line: string, language: string): [string, string][] {
  const [first] = monaco.editor.tokenize(line, language);
  const list = first ?? [];
  return list
    .map((token, index) => {
      const end = list[index + 1]?.offset ?? line.length;
      return [line.slice(token.offset, end), token.type.replace(`.${language}`, "")] as [
        string,
        string,
      ];
    })
    .filter(([text]) => text.trim() !== "");
}

function tokenOf(line: string, language: string, text: string): string | undefined {
  return tokens(line, language).find(([part]) => part.trim() === text)?.[1];
}

beforeAll(() => {
  registerBuiltInLanguages();
});

describe("Fortran and Pascal in the editor", () => {
  it("opens every registered extension in its language", () => {
    for (const name of ["a.f", "b.FOR", "c.f90", "d.F95", "e.f03", "f.f08"]) {
      expect(languageForPath(`C:/p/${name}`), name).toBe("fortran");
    }
    for (const name of ["main.pas", "unit.PP"]) {
      expect(languageForPath(`C:/p/${name}`), name).toBe("pascal");
    }
    // Not registered: they stay plain text rather than being guessed.
    expect(languageForPath("C:/p/old.f77")).toBe("plaintext");
    expect(languageForPath("C:/p/old.ftn")).toBe("plaintext");
    expect(languageForPath("C:/p/notes.ps")).not.toBe("pascal");
  });

  it("colours free-form Fortran", () => {
    const line = "  real(kind=8) :: x = 1.5d-3 ! area";
    expect(tokenOf(line, "fortran", "real")).toBe("type");
    expect(tokenOf(line, "fortran", "x")).toBe("identifier");
    expect(tokenOf(line, "fortran", "1.5d-3")).toBe("number.float");
    expect(tokenOf(line, "fortran", "! area")).toBe("comment");
    expect(tokenOf("print *, 'it''s', .true.", "fortran", "print")).toBe("keyword");
    expect(tokenOf("print *, 'it''s', .true.", "fortran", ".true.")).toBe("keyword");
    expect(tokens("if (a .and. b) then", "fortran")).toContainEqual([".and.", "operator"]);
    expect(tokens('s = "text"', "fortran")).toContainEqual(['"text"', "string"]);
    expect(tokenOf("END PROGRAM MAIN", "fortran", "END")).toBe("keyword");
  });

  it("reads fixed-form comment lines but not free-form statements in the first column", () => {
    expect(tokens("C     comment in column one", "fortran")).toEqual([
      ["C     comment in column one", "comment"],
    ]);
    expect(tokens("c---------", "fortran")).toEqual([["c---------", "comment"]]);
    expect(tokens("* star comment", "fortran")).toEqual([["* star comment", "comment"]]);
    expect(tokenOf("contains", "fortran", "contains")).toBe("keyword");
    expect(tokenOf("call run()", "fortran", "call")).toBe("keyword");
    expect(tokenOf("c = a + b", "fortran", "c")).toBe("identifier");
    expect(tokenOf("      PRINT *, 'FIXED'", "fortran", "PRINT")).toBe("keyword");
  });

  it("colours Pascal", () => {
    const line = "var count: integer = $FF; // counter";
    expect(tokenOf(line, "pascal", "var")).toBe("keyword");
    expect(tokenOf(line, "pascal", "integer")).toBe("type");
    expect(tokenOf(line, "pascal", "$FF")).toBe("number.hex");
    expect(tokenOf(line, "pascal", "// counter")).toBe("comment");
    expect(tokenOf("x := 2.5e3 div 2;", "pascal", "2.5e3")).toBe("number.float");
    expect(tokenOf("x := 2.5e3 div 2;", "pascal", "div")).toBe("keyword");
    expect(tokenOf("x := 2.5e3 div 2;", "pascal", ":=")).toBe("operator");
    expect(tokenOf("if p = nil then", "pascal", "nil")).toBe("keyword");
    expect(tokenOf("s := 'it''s';", "pascal", "'it''s'")).toBe("string");
    expect(tokenOf("{ brace comment }", "pascal", "{ brace comment }")).toBe("comment");
    expect(tokenOf("(* paren comment *)", "pascal", "(* paren comment *)")).toBe("comment");
    expect(tokens("{$mode objfpc}", "pascal")[0]?.[1]).toBe("keyword.directive");
  });
});
