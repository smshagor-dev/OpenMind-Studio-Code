import type * as monaco from "monaco-editor";

/**
 * Monarch grammars for the languages Monaco doesn't ship: Fortran (free and fixed form share one language, so a
 * `.f` file and a `.f90` file get the same language services) and Pascal / Free Pascal.
 */

const FORTRAN_KEYWORDS = [
  "program", "module", "submodule", "subroutine", "function", "procedure", "contains", "use", "only", "implicit",
  "none", "intrinsic", "external", "intent", "in", "out", "inout", "optional", "parameter", "dimension",
  "allocatable", "pointer", "target", "save", "public", "private", "protected", "value", "volatile", "interface",
  "abstract", "result", "recursive", "pure", "impure", "elemental", "if", "then", "else", "elseif", "endif", "end",
  "do", "enddo", "while", "concurrent", "select", "case", "default", "where", "elsewhere", "forall", "block", "associate",
  "call", "return", "stop", "exit", "cycle", "continue", "goto", "go", "to", "allocate", "deallocate", "nullify",
  "print", "write", "read", "open", "close", "inquire", "rewind", "backspace", "format", "common", "data",
  "equivalence", "include", "extends", "class", "is", "generic", "final", "bind", "import", "enum", "enumerator",
  "sequence", "entry", "kind", "len",
];

const FORTRAN_TYPES = ["integer", "real", "double", "precision", "complex", "logical", "character", "type"];

/** Shared by free and fixed form. Fixed-form comment lines (`C`, `c` or `*` in the first column) are recognised
 * when the comment letter is followed by a space, a digit or a rule character; `C` directly followed by letters is
 * read as code, because in free form a statement such as `contains` may start in the first column too. */
export const FORTRAN_TOKENS: monaco.languages.IMonarchLanguage = {
  ignoreCase: true,
  keywords: FORTRAN_KEYWORDS,
  types: FORTRAN_TYPES,
  tokenizer: {
    root: [
      [/^\*.*$/, "comment"],
      [/^[cC](?:$|[-*!#+0-9].*$)/, "comment"],
      [/^[cC][ \t](?![ \t]*=).*$/, "comment"],
      [/!.*$/, "comment"],
      [/"/, "string", "@string_double"],
      [/'/, "string", "@string_single"],
      [/\.(?:true|false)\.(?:_\w+)?/, "keyword"],
      [/\.(?:and|or|not|eqv|neqv|eq|ne|lt|le|gt|ge)\./, "operator"],
      [/[a-z_]\w*/, { cases: { "@types": "type", "@keywords": "keyword", "@default": "identifier" } }],
      [/(?:\d+\.\d*|\.\d+)(?:[ed][+-]?\d+)?(?:_\w+)?/, "number.float"],
      [/\d+[ed][+-]?\d+(?:_\w+)?/, "number.float"],
      [/\d+(?:_\w+)?/, "number"],
      [/[()[\]]/, "@brackets"],
      [/\*\*|\/\/|==|\/=|<=|>=|=>|::|[+\-*/=<>%]/, "operator"],
      [/[,;:&]/, "delimiter"],
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
};

const PASCAL_KEYWORDS = [
  "program", "unit", "library", "interface", "implementation", "initialization", "finalization", "uses", "var",
  "const", "type", "resourcestring", "threadvar", "label", "procedure", "function", "constructor", "destructor",
  "operator", "property", "begin", "end", "if", "then", "else", "case", "of", "for", "to", "downto", "do", "while",
  "repeat", "until", "with", "goto", "exit", "break", "continue", "array", "record", "set", "file", "packed",
  "object", "class", "interface", "private", "protected", "public", "published", "strict", "inherited", "virtual",
  "override", "abstract", "overload", "forward", "external", "try", "except", "finally", "raise", "on", "out",
  "absolute", "inline", "specialize", "generic",
];

const PASCAL_OPERATOR_WORDS = ["and", "or", "not", "xor", "div", "mod", "shl", "shr", "in", "is", "as"];

const PASCAL_CONSTANTS = ["nil", "true", "false", "self", "result"];

const PASCAL_TYPES = [
  "integer", "cardinal", "shortint", "smallint", "longint", "int64", "byte", "word", "longword", "qword",
  "real", "single", "double", "extended", "currency", "boolean", "char", "widechar", "string", "shortstring",
  "ansistring", "widestring", "unicodestring", "pchar", "pointer", "text", "variant",
];

export const PASCAL_TOKENS: monaco.languages.IMonarchLanguage = {
  ignoreCase: true,
  keywords: PASCAL_KEYWORDS,
  operatorWords: PASCAL_OPERATOR_WORDS,
  constants: PASCAL_CONSTANTS,
  types: PASCAL_TYPES,
  tokenizer: {
    root: [
      [/\/\/.*$/, "comment"],
      [/\{\$/, "keyword.directive", "@directive"],
      [/\{/, "comment", "@comment_brace"],
      [/\(\*/, "comment", "@comment_paren"],
      [/'([^']|'')*'/, "string"],
      [/#\d+/, "string"],
      [
        /[a-z_]\w*/,
        {
          cases: {
            "@types": "type",
            "@constants": "keyword",
            "@operatorWords": "keyword",
            "@keywords": "keyword",
            "@default": "identifier",
          },
        },
      ],
      [/\$[0-9a-f]+/, "number.hex"],
      [/\d+\.\d+(?:e[+-]?\d+)?|\d+e[+-]?\d+/, "number.float"],
      [/\d+/, "number"],
      [/[()[\]]/, "@brackets"],
      [/:=|<>|<=|>=|\.\.|[+\-*/=<>@^]/, "operator"],
      [/[,;:.]/, "delimiter"],
    ],
    directive: [
      [/[^}]+/, "keyword.directive"],
      [/\}/, "keyword.directive", "@pop"],
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
};
