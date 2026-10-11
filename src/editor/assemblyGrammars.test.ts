import * as monaco from "monaco-editor";
import { beforeAll, describe, expect, it } from "vitest";

import { assemblyIncludeLanguage, REGISTERS } from "./assemblyGrammars";
import { registerBuiltInLanguages } from "./builtinLanguages";
import { languageForPath } from "./languageForPath";

function tokenOf(line: string, language: string, text: string): string | undefined {
  const [first] = monaco.editor.tokenize(line, language);
  const list = first ?? [];
  const index = list.findIndex((token, i) => {
    const end = list[i + 1]?.offset ?? line.length;
    return line.slice(token.offset, end).trim() === text;
  });
  return list[index]?.type.replace(`.${language}`, "");
}

beforeAll(() => {
  registerBuiltInLanguages();
});

describe("assembly in the editor", () => {
  it("opens NASM and GNU as sources in their language and leaves .inc alone", () => {
    for (const name of ["hello.asm", "BOOT.ASM", "x.nasm"])
      expect(languageForPath(`C:/p/${name}`), name).toBe("nasm");
    // `.s` is also Monaco's MIPS: the document table picks GNU as (documentService.test.ts).
    expect(monaco.languages.getLanguages().some((language) => language.id === "gas")).toBe(true);
    expect(languageForPath("C:/p/macros.inc")).not.toBe("nasm");
  });

  it("colours NASM: instructions, registers, directives, sizes, labels, numbers, strings, comments", () => {
    const line = "        mov     rax, qword [rbp - 8] ; load";
    expect(tokenOf(line, "nasm", "mov")).toBe("keyword");
    expect(tokenOf(line, "nasm", "rax")).toBe("variable.predefined");
    expect(tokenOf(line, "nasm", "qword")).toBe("keyword.type");
    expect(tokenOf(line, "nasm", "; load")).toBe("comment");
    expect(tokenOf("        global  main", "nasm", "global")).toBe("keyword.directive");
    expect(tokenOf("main:   ret", "nasm", "main:")).toBe("type.identifier");
    expect(tokenOf('msg: db "Hello", 10, 0', "nasm", '"Hello"')).toBe("string");
    expect(tokenOf("        add     r12d, 0x1F", "nasm", "r12d")).toBe("variable.predefined");
    expect(tokenOf("        add     r12d, 0x1F", "nasm", "0x1F")).toBe("number.hex");
    expect(tokenOf('%include "macros.inc"', "nasm", "%include")).toBe("keyword.directive");
    expect(tokenOf("        call    printf", "nasm", "printf")).toBe("identifier");
  });

  it("colours GNU as: directives, %registers, $immediates and both comment styles", () => {
    expect(tokenOf("\t.globl main", "gas", ".globl")).toBe("keyword");
    expect(tokenOf("\tmovq $5, %rax", "gas", "movq")).toBe("keyword");
    expect(tokenOf("\tmovq $5, %rax", "gas", "%rax")).toBe("variable.predefined");
    expect(tokenOf("\tmovq $5, %rax", "gas", "$5")).toBe("number");
    expect(tokenOf("# a comment", "gas", "# a comment")).toBe("comment");
    expect(tokenOf("/* block */", "gas", "/* block */")).toBe("comment");
  });

  it("knows the numbered register families", () => {
    for (const name of ["r8", "r15d", "r9b", "xmm0", "ymm31", "st7", "cr0", "k7"])
      expect(REGISTERS).toContain(name);
    expect(REGISTERS).not.toContain("r16");
  });
});

describe("an .inc file", () => {
  it("is NASM when it holds macros, equates or data", () => {
    expect(assemblyIncludeLanguage("%macro print 1\n  nop\n%endmacro\n")).toBe("nasm");
    expect(assemblyIncludeLanguage("BUFSIZE equ 64\n")).toBe("nasm");
    expect(assemblyIncludeLanguage("; shared\nsection .data\n")).toBe("nasm");
  });

  it("is left alone for PHP and plain text", () => {
    expect(assemblyIncludeLanguage("<?php\n$db = 'x';\n")).toBeNull();
    expect(assemblyIncludeLanguage("just words\nnothing here\n")).toBeNull();
  });
});
