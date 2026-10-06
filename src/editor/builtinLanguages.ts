import * as monaco from "monaco-editor";

import { GAS_TOKENS, NASM_TOKENS } from "./assemblyGrammars";
import { FORTRAN_TOKENS, PASCAL_TOKENS } from "./builtinGrammars";

let registered = false;

export function registerBuiltInLanguages(): void {
  if (registered) return;
  registered = true;
  registerFortran();
  registerPascal();
  registerAssembly();
}

function ensureLanguage(id: string, extensions: string[], aliases: string[]): void {
  if (!monaco.languages.getLanguages().some((language) => language.id === id)) {
    monaco.languages.register({ id, extensions, aliases });
  }
}

function registerSnippets(language: string, snippets: [string, string, string][]): void {
  monaco.languages.registerCompletionItemProvider(language, {
    provideCompletionItems(model, position) {
      const range = model.getWordUntilPosition(position);
      const word = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: range.startColumn,
        endColumn: range.endColumn,
      };
      return {
        suggestions: snippets.map(([label, insertText, documentation]) => ({
          label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          documentation,
          range: word,
        })),
      };
    },
  });
}

function registerFortran(): void {
  ensureLanguage("fortran", [".f", ".for", ".f90", ".f95", ".f03", ".f08"], ["Fortran"]);
  monaco.languages.setLanguageConfiguration("fortran", {
    comments: { lineComment: "!" },
    brackets: [
      ["(", ")"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });
  monaco.languages.setMonarchTokensProvider("fortran", FORTRAN_TOKENS);
  registerSnippets("fortran", [
    ["program", "program ${1:name}\n  implicit none\n  ${0}\nend program ${1:name}", "Program"],
    ["subroutine", "subroutine ${1:name}(${2:args})\n  implicit none\n  ${0}\nend subroutine ${1:name}", "Subroutine"],
    ["do", "do ${1:i} = ${2:1}, ${3:n}\n  ${0}\nend do", "Do loop"],
    ["if", "if (${1:condition}) then\n  ${0}\nend if", "If block"],
  ]);
}

function registerPascal(): void {
  ensureLanguage("pascal", [".pas", ".pp"], ["Pascal", "Free Pascal"]);
  monaco.languages.setLanguageConfiguration("pascal", {
    comments: { lineComment: "//", blockComment: ["{", "}"] },
    brackets: [
      ["begin", "end"],
      ["(", ")"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: "'", close: "'" },
    ],
  });
  monaco.languages.setMonarchTokensProvider("pascal", PASCAL_TOKENS);
  registerSnippets("pascal", [
    ["program", "program ${1:Name};\n\nbegin\n  ${0}\nend.", "Program"],
    ["procedure", "procedure ${1:Name};\nbegin\n  ${0}\nend;", "Procedure"],
    ["if", "if ${1:condition} then\nbegin\n  ${0}\nend;", "If block"],
    ["for", "for ${1:i} := ${2:1} to ${3:n} do\nbegin\n  ${0}\nend;", "For loop"],
  ]);
}

/**
 * x86/x86-64 assembly: NASM (`.asm`, `.nasm`; Intel syntax, OpenMind's default) and GNU as (`.s`, `.S`; AT&T syntax).
 * `.inc` is not claimed here: PHP and others use it too, so an assembly include gets the NASM grammar only when its
 * text looks like assembly (`assemblyIncludeLanguage`).
 */
function registerAssembly(): void {
  ensureLanguage("nasm", [".asm", ".nasm"], ["Assembly (NASM)", "nasm", "asm"]);
  monaco.languages.setLanguageConfiguration("nasm", {
    comments: { lineComment: ";" },
    brackets: [
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "`", close: "`" },
    ],
  });
  monaco.languages.setMonarchTokensProvider("nasm", NASM_TOKENS);
  registerSnippets("nasm", [
    [
      "main",
      '        default rel\n        global  main\n        extern  printf\n\n        section .data\nmsg:    db "${1:Hello, world!}", 10, 0\n\n        section .text\nmain:\n        sub     rsp, 40\n        lea     rcx, [msg]\n        call    printf\n        add     rsp, 40\n        xor     eax, eax\n        ret\n',
      "Windows x64 program with main (C runtime)",
    ],
    ["section", "section .${1|text,data,bss,rdata|}\n${0}", "Section"],
    ["proc", "${1:name}:\n        push    rbp\n        mov     rbp, rsp\n        ${0}\n        pop     rbp\n        ret", "Procedure with a frame"],
    ["macro", "%macro ${1:name} ${2:0}\n        ${0}\n%endmacro", "Macro"],
  ]);
  ensureLanguage("gas", [".s", ".S"], ["Assembly (GAS)", "gas", "GNU Assembler"]);
  monaco.languages.setLanguageConfiguration("gas", {
    comments: { lineComment: "#", blockComment: ["/*", "*/"] },
    brackets: [["(", ")"]],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
  });
  monaco.languages.setMonarchTokensProvider("gas", GAS_TOKENS);
}
