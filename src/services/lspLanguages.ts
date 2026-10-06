/**
 * Which language a file is, as a language server sees it. Mirrors
 * `openmind_lsp::language::language_id` (the backend is the authority — this
 * only saves a round trip for files no server would ever take, like `.txt`).
 */
const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  py: "python",
  pyi: "python",
  pyw: "python",
  php: "php",
  phtml: "php",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  yaml: "yaml",
  yml: "yaml",
  sh: "shellscript",
  bash: "shellscript",
  dockerfile: "dockerfile",
  rs: "rust",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  f: "fortran",
  for: "fortran",
  f90: "fortran",
  f95: "fortran",
  f03: "fortran",
  f08: "fortran",
  asm: "nasm",
  nasm: "nasm",
};

export function lspLanguageId(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? path;
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower === "containerfile" || lower.startsWith("dockerfile.")) {
    return "dockerfile";
  }
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** The Monaco language ids that language-server providers are registered for. */
export const LSP_MONACO_LANGUAGES = [
  "typescript",
  "javascript",
  "python",
  "php",
  "json",
  "css",
  "scss",
  "less",
  "html",
  "yaml",
  "shell",
  "dockerfile",
  "rust",
  "c",
  "cpp",
  "fortran",
  "nasm",
] as const;

/** Monaco's language id for an LSP language id (`typescriptreact` is TypeScript to Monaco). */
export function monacoLanguageFor(lspLanguage: string): string {
  switch (lspLanguage) {
    case "typescriptreact":
      return "typescript";
    case "javascriptreact":
      return "javascript";
    case "jsonc":
      return "json";
    case "shellscript":
      return "shell";
    default:
      return lspLanguage;
  }
}
