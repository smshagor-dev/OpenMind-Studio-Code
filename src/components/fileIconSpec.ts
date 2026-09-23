/**
 * File-type icons in the spirit of VS Code's default "Seti" icon theme: a
 * short colored glyph per file type (Seti shows no folder icons — folders are
 * identified by their twistie alone, which the explorer mirrors).
 */
interface FileIconSpec {
  glyph: string;
  color: string;
}

const BLUE = "#519aba";
const YELLOW = "#cbcb41";
const ORANGE = "#e37933";
const RED = "#cc3e44";
const GREEN = "#8dc149";
const PURPLE = "#a074c4";
const PINK = "#f55385";
const GREY = "#6d8086";

const BY_FILENAME: Record<string, FileIconSpec> = {
  "package.json": { glyph: "npm", color: RED },
  "package-lock.json": { glyph: "npm", color: RED },
  "pnpm-lock.yaml": { glyph: "pn", color: YELLOW },
  "cargo.toml": { glyph: "R", color: ORANGE },
  "cargo.lock": { glyph: "R", color: ORANGE },
  "tsconfig.json": { glyph: "TS", color: BLUE },
  ".gitignore": { glyph: "git", color: ORANGE },
  ".gitattributes": { glyph: "git", color: ORANGE },
  "readme.md": { glyph: "i", color: BLUE },
  license: { glyph: "©", color: YELLOW },
  dockerfile: { glyph: "D", color: BLUE },
  ".env": { glyph: "⚙", color: GREY },
  ".editorconfig": { glyph: "⚙", color: GREY },
  "claude.md": { glyph: "i", color: BLUE },
};

const BY_EXTENSION: Record<string, FileIconSpec> = {
  ts: { glyph: "TS", color: BLUE },
  mts: { glyph: "TS", color: BLUE },
  cts: { glyph: "TS", color: BLUE },
  tsx: { glyph: "⚛", color: BLUE },
  jsx: { glyph: "⚛", color: YELLOW },
  js: { glyph: "JS", color: YELLOW },
  mjs: { glyph: "JS", color: YELLOW },
  cjs: { glyph: "JS", color: YELLOW },
  json: { glyph: "{}", color: YELLOW },
  md: { glyph: "M↓", color: BLUE },
  rs: { glyph: "R", color: ORANGE },
  py: { glyph: "py", color: BLUE },
  go: { glyph: "go", color: BLUE },
  java: { glyph: "J", color: RED },
  c: { glyph: "C", color: BLUE },
  h: { glyph: "h", color: PURPLE },
  cpp: { glyph: "C+", color: BLUE },
  hpp: { glyph: "h", color: PURPLE },
  cs: { glyph: "C#", color: GREEN },
  css: { glyph: "#", color: BLUE },
  scss: { glyph: "S", color: PINK },
  less: { glyph: "L", color: BLUE },
  html: { glyph: "<>", color: ORANGE },
  xml: { glyph: "<>", color: ORANGE },
  svg: { glyph: "◇", color: PURPLE },
  png: { glyph: "▣", color: PURPLE },
  jpg: { glyph: "▣", color: PURPLE },
  jpeg: { glyph: "▣", color: PURPLE },
  gif: { glyph: "▣", color: PURPLE },
  ico: { glyph: "▣", color: PURPLE },
  icns: { glyph: "▣", color: PURPLE },
  webp: { glyph: "▣", color: PURPLE },
  yaml: { glyph: "!", color: PURPLE },
  yml: { glyph: "!", color: PURPLE },
  toml: { glyph: "⚙", color: GREY },
  ini: { glyph: "⚙", color: GREY },
  lock: { glyph: "🔒", color: GREY },
  sql: { glyph: "DB", color: PINK },
  db: { glyph: "DB", color: PINK },
  sh: { glyph: ">_", color: GREEN },
  bash: { glyph: ">_", color: GREEN },
  ps1: { glyph: ">_", color: BLUE },
  bat: { glyph: ">_", color: GREEN },
  cmd: { glyph: ">_", color: GREEN },
  txt: { glyph: "≡", color: GREY },
  log: { glyph: "≡", color: GREY },
  vue: { glyph: "V", color: GREEN },
  svelte: { glyph: "S", color: ORANGE },
  php: { glyph: "php", color: PURPLE },
  rb: { glyph: "rb", color: RED },
  kt: { glyph: "K", color: ORANGE },
  swift: { glyph: "S", color: ORANGE },
  dart: { glyph: "D", color: BLUE },
  lua: { glyph: "L", color: BLUE },
};

const DEFAULT_SPEC: FileIconSpec = { glyph: "≡", color: "#a0a0a0" };

export function fileIconFor(name: string): FileIconSpec {
  const lower = name.toLowerCase();
  const byName = BY_FILENAME[lower];
  if (byName) {
    return byName;
  }
  const dotIndex = lower.lastIndexOf(".");
  if (dotIndex < 0) {
    return DEFAULT_SPEC;
  }
  return BY_EXTENSION[lower.slice(dotIndex + 1)] ?? DEFAULT_SPEC;
}
