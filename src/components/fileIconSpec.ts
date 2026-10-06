/**
 * File-type icons: a real icon per language and well-known file, from the MIT-licensed Material Icon
 * Theme (`material-icon-theme`, the SVGs are bundled with the app — nothing is fetched). Folders have
 * no icon (VS Code's default look: the twistie identifies them).
 */

/** Icons by exact file name (lower case). */
const BY_FILENAME: Record<string, string> = {
  "package.json": "nodejs",
  "package-lock.json": "nodejs",
  ".npmrc": "npm",
  "pnpm-lock.yaml": "pnpm",
  "pnpm-workspace.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lockb": "bun",
  "deno.json": "deno",
  "cargo.toml": "rust",
  "cargo.lock": "rust",
  "go.mod": "go-mod",
  "go.sum": "go-mod",
  "tsconfig.json": "tsconfig",
  "jsconfig.json": "tsconfig",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  "readme.md": "readme",
  readme: "readme",
  license: "license",
  "license.md": "license",
  "license.txt": "license",
  dockerfile: "docker",
  "docker-compose.yml": "docker",
  "docker-compose.yaml": "docker",
  ".dockerignore": "docker",
  ".env": "tune",
  ".env.local": "tune",
  ".editorconfig": "editorconfig",
  "vite.config.ts": "vite",
  "vite.config.js": "vite",
  "vitest.config.ts": "vitest",
  "jest.config.js": "jest",
  "jest.config.ts": "jest",
  "webpack.config.js": "webpack",
  ".babelrc": "babel",
  "babel.config.js": "babel",
  "eslint.config.js": "eslint",
  "eslint.config.mjs": "eslint",
  ".eslintrc": "eslint",
  ".eslintrc.json": "eslint",
  ".eslintrc.js": "eslint",
  ".prettierrc": "prettier",
  ".prettierrc.json": "prettier",
  "prettier.config.js": "prettier",
  "composer.json": "php",
  "composer.lock": "php",
  "requirements.txt": "python-misc",
  "pyproject.toml": "python-misc",
  makefile: "makefile",
  "cmakelists.txt": "cmake",
  gemfile: "gemfile",
  "tauri.conf.json": "tauri",
  "claude.md": "claude",
  "nginx.conf": "nginx",
  artisan: "laravel",
  "build.gradle": "gradle",
  "build.gradle.kts": "gradle",
  "settings.gradle": "gradle",
  "settings.gradle.kts": "gradle",
  "gradle.properties": "gradle",
  "androidmanifest.xml": "android",
  "pubspec.yaml": "dart",
  "pubspec.lock": "dart",
  "analysis_options.yaml": "dart",
  "schema.prisma": "prisma",
};

/** Names that start with a known word (`.env.production`, `Dockerfile.dev`, `docker-compose.override.yml`). */
const BY_PREFIX: [string, string][] = [
  [".env", "tune"],
  ["dockerfile", "docker"],
  ["docker-compose", "docker"],
  ["tauri.", "tauri"],
];

/** Icons by extension (lower case, without the dot). */
const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "react_ts",
  jsx: "react",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "mdx",
  rs: "rust",
  py: "python",
  pyw: "python",
  ipynb: "jupyter",
  go: "go",
  java: "java",
  c: "c",
  h: "h",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "hpp",
  f: "fortran",
  for: "fortran",
  f90: "fortran",
  f95: "fortran",
  f03: "fortran",
  f08: "fortran",
  pas: "pascal",
  pp: "pascal",
  asm: "assembly",
  nasm: "assembly",
  s: "assembly",
  cs: "csharp",
  fs: "fsharp",
  css: "css",
  scss: "sass",
  sass: "sass",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "svg",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  ico: "image",
  icns: "image",
  webp: "image",
  bmp: "image",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "settings",
  cfg: "settings",
  conf: "settings",
  lock: "lock",
  sql: "database",
  db: "database",
  sqlite: "database",
  sh: "console",
  bash: "console",
  zsh: "console",
  bat: "console",
  cmd: "console",
  ps1: "powershell",
  psm1: "powershell",
  txt: "document",
  log: "log",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  php: "php",
  rb: "ruby",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  dart: "dart",
  lua: "lua",
  r: "r",
  pl: "perl",
  scala: "scala",
  hs: "haskell",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  zig: "zig",
  tex: "tex",
  graphql: "graphql",
  gql: "graphql",
  prisma: "prisma",
  proto: "proto",
  tf: "terraform",
  vim: "vim",
  wasm: "webassembly",
  pdf: "pdf",
  zip: "zip",
  gz: "zip",
  "7z": "zip",
  rar: "zip",
  tar: "zip",
  csv: "table",
  tsv: "table",
  xlsx: "table",
  env: "tune",
  exe: "exe",
  dll: "dll",
  url: "url",
  mp4: "video",
  mov: "video",
  webm: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  ttf: "font",
  otf: "font",
  woff: "font",
  woff2: "font",
  pem: "certificate",
  crt: "certificate",
  cer: "certificate",
  key: "key",
  gradle: "gradle",
};

/** Used for anything the tables don't know. */
export const DEFAULT_ICON = "file";

/** The Material icon name for a file name (by exact name, then `.d.ts`, then extension). */
export function fileIconName(name: string): string {
  const lower = name.toLowerCase();
  const byName = BY_FILENAME[lower];
  if (byName) return byName;
  if (lower.endsWith(".blade.php")) return "laravel";
  const byPrefix = BY_PREFIX.find(([prefix]) => lower.startsWith(prefix));
  if (byPrefix && !lower.endsWith(".json")) return byPrefix[1];
  if (lower.endsWith(".d.ts")) return "typescript-def";
  const dotIndex = lower.lastIndexOf(".");
  if (dotIndex < 0) return DEFAULT_ICON;
  return BY_EXTENSION[lower.slice(dotIndex + 1)] ?? DEFAULT_ICON;
}

/** Every icon name the tables use (for the icon loader and its test). */
export function usedIconNames(): string[] {
  return [
    ...new Set([
      ...Object.values(BY_FILENAME),
      ...Object.values(BY_EXTENSION),
      ...BY_PREFIX.map(([, icon]) => icon),
      "laravel",
      "typescript-def",
      DEFAULT_ICON,
    ]),
  ].sort();
}

/** Folder icons by folder name (lower case); the icon name has an `-open` twin in the theme. */
const BY_FOLDER: Record<string, string> = {
  src: "folder-src",
  "src-tauri": "folder-src-tauri",
  test: "folder-test",
  tests: "folder-test",
  __tests__: "folder-test",
  spec: "folder-test",
  node_modules: "folder-node",
  ".git": "folder-git",
  ".github": "folder-github",
  dist: "folder-dist",
  build: "folder-dist",
  out: "folder-dist",
  target: "folder-target",
  public: "folder-public",
  assets: "folder-resource",
  resources: "folder-resource",
  routes: "folder-routes",
  controllers: "folder-controller",
  components: "folder-components",
  pages: "folder-views",
  views: "folder-views",
  config: "folder-config",
  docs: "folder-docs",
  lib: "folder-lib",
  app: "folder-app",
  database: "folder-database",
  images: "folder-images",
  scripts: "folder-scripts",
  utils: "folder-utils",
  api: "folder-api",
  android: "folder-android",
  ios: "folder-ios",
};

/** Used for a folder the table doesn't know. */
export const DEFAULT_FOLDER_ICON = "folder-base";

/** The icon name for a folder, in its closed or open form. */
export function folderIconName(name: string, open: boolean): string {
  const base = BY_FOLDER[name.toLowerCase()] ?? DEFAULT_FOLDER_ICON;
  return open ? `${base}-open` : base;
}

/** Every folder icon name (closed and open) the table can return, for the loader and its test. */
export function usedFolderIconNames(): string[] {
  const bases = new Set([...Object.values(BY_FOLDER), DEFAULT_FOLDER_ICON]);
  return [...bases].flatMap((base) => [base, `${base}-open`]).sort();
}
