const EXTENSION_COLOR: Record<string, string> = {
  ts: "#3178c6",
  tsx: "#3178c6",
  js: "#f1c40f",
  jsx: "#f1c40f",
  json: "#cbcb41",
  md: "#519aba",
  rs: "#dea584",
  py: "#3572a5",
  css: "#563d7c",
  html: "#e34c26",
  yaml: "#cb171e",
  yml: "#cb171e",
  toml: "#9c4221",
  sql: "#e38c00",
  txt: "#8a8a8a",
};

const DEFAULT_COLOR = "#8a8a8a";

export function iconColorForFile(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return DEFAULT_COLOR;
  }
  const extension = name.slice(dotIndex + 1).toLowerCase();
  return EXTENSION_COLOR[extension] ?? DEFAULT_COLOR;
}
