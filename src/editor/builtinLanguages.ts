import * as monaco from "monaco-editor";

let registered = false;

export function registerBuiltInLanguages(): void {
  if (registered) return;
  registered = true;
  registerFortran();
  registerPascal();
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
  monaco.languages.setMonarchTokensProvider("fortran", {
    ignoreCase: true,
    keywords: [
      "program",
      "module",
      "subroutine",
      "function",
      "contains",
      "use",
      "implicit",
      "none",
      "integer",
      "real",
      "logical",
      "character",
      "complex",
      "if",
      "then",
      "else",
      "elseif",
      "endif",
      "do",
      "enddo",
      "select",
      "case",
      "call",
      "return",
      "allocate",
      "deallocate",
      "intent",
      "in",
      "out",
      "inout",
      "end",
    ],
    tokenizer: {
      root: [
        [/!.*/, "comment"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/"/, "string", "@string_double"],
        [/'([^'\\]|\\.)*$/, "string.invalid"],
        [/'/, "string", "@string_single"],
        [/[a-z_]\w*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/\d+(\.\d+)?([ed][+-]?\d+)?/, "number"],
        [/[+\-*/=<>:,.;]+/, "operator"],
      ],
      string_double: [
        [/[^"]+/, "string"],
        [/""/, "string.escape"],
        [/"/, "string", "@pop"],
      ],
      string_single: [
        [/[^']+/, "string"],
        [/''/, "string.escape"],
        [/'/, "string", "@pop"],
      ],
    },
  });
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
  monaco.languages.setMonarchTokensProvider("pascal", {
    ignoreCase: true,
    keywords: [
      "program",
      "unit",
      "interface",
      "implementation",
      "uses",
      "var",
      "const",
      "type",
      "procedure",
      "function",
      "begin",
      "end",
      "if",
      "then",
      "else",
      "case",
      "of",
      "for",
      "to",
      "downto",
      "do",
      "while",
      "repeat",
      "until",
      "array",
      "record",
      "class",
      "try",
      "except",
      "finally",
    ],
    tokenizer: {
      root: [
        [/\/\/.*/, "comment"],
        [/\{/, "comment", "@comment_brace"],
        [/\(\*/, "comment", "@comment_paren"],
        [/'([^']|'')*'/, "string"],
        [/[a-z_]\w*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/\$[0-9a-f]+|\d+(\.\d+)?/, "number"],
        [/[+\-*/=<>:,.;]+/, "operator"],
      ],
      comment_brace: [
        [/[^}]+/, "comment"],
        [/\}/, "comment", "@pop"],
      ],
      comment_paren: [
        [/[^(*)]+/, "comment"],
        [/\*\)/, "comment", "@pop"],
        [/[(*)]/, "comment"],
      ],
    },
  });
  registerSnippets("pascal", [
    ["program", "program ${1:Name};\n\nbegin\n  ${0}\nend.", "Program"],
    ["procedure", "procedure ${1:Name};\nbegin\n  ${0}\nend;", "Procedure"],
    ["if", "if ${1:condition} then\nbegin\n  ${0}\nend;", "If block"],
    ["for", "for ${1:i} := ${2:1} to ${3:n} do\nbegin\n  ${0}\nend;", "For loop"],
  ]);
}
