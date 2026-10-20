/**
 * Web addresses for a Git remote: a file (at a revision, with lines), a commit, and a vscode.dev link. Only hosts
 * whose URL scheme is known are supported — github.com, gitlab.com and bitbucket.org — so OpenMind never builds an
 * address that merely looks right. Self-hosted servers and other hosts are reported as unsupported.
 */

export type RemoteHost = "github" | "gitlab" | "bitbucket";

export interface ParsedRemote {
  host: RemoteHost;
  /** `https://github.com` etc. */
  origin: string;
  /** Owner (GitLab: group with subgroups) and repository, without `.git`. */
  namespace: string;
  repo: string;
}

const HOSTS: Record<string, RemoteHost> = {
  "github.com": "github",
  "ssh.github.com": "github",
  "gitlab.com": "gitlab",
  "altssh.gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
  "altssh.bitbucket.org": "bitbucket",
};

const ORIGINS: Record<RemoteHost, string> = {
  github: "https://github.com",
  gitlab: "https://gitlab.com",
  bitbucket: "https://bitbucket.org",
};

/** `host` and `path` of an SSH, HTTPS or git:// remote address, or `null`. */
function splitAddress(url: string): { host: string; path: string } | null {
  const text = url.trim();
  // scp-like: git@github.com:owner/repo.git (no scheme, a colon before the first slash)
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return { host: scp[1] ?? "", path: scp[2] ?? "" };
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (!["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"].includes(parsed.protocol)) return null;
  try {
    return { host: parsed.hostname, path: decodeURIComponent(parsed.pathname) };
  } catch {
    return null;
  }
}

/** The remote's host and repository, or `null` when the address isn't one of the supported hosts. */
export function parseRemote(url: string): ParsedRemote | null {
  const address = splitAddress(url);
  if (address === null) return null;
  const host = HOSTS[address.host.toLowerCase().replace(/^www\./, "")];
  if (host === undefined) return null;
  const parts = address.path
    .replace(/\.git\/?$/, "")
    .split("/")
    .filter((part) => part.length > 0);
  if (parts.length < 2 || parts.some((part) => part === "." || part === "..")) return null;
  // GitHub and Bitbucket are owner/repo; GitLab allows nested groups.
  if (host !== "gitlab" && parts.length !== 2) return null;
  const repo = parts[parts.length - 1] ?? "";
  return { host, origin: ORIGINS[host], namespace: parts.slice(0, -1).join("/"), repo };
}

/** Each path segment percent-encoded, the slashes kept. */
export function encodePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

function base(remote: ParsedRemote): string {
  return `${remote.origin}/${encodePath(remote.namespace)}/${encodeURIComponent(remote.repo)}`;
}

export interface LineSpan {
  start: number;
  end: number;
}

function lineAnchor(host: RemoteHost, lines: LineSpan | null): string {
  if (lines === null) return "";
  const start = String(lines.start);
  const end = String(lines.end);
  const range = lines.end > lines.start;
  switch (host) {
    case "github":
      return range ? `#L${start}-L${end}` : `#L${start}`;
    case "gitlab":
      return range ? `#L${start}-${end}` : `#L${start}`;
    case "bitbucket":
      return range ? `#lines-${start}:${end}` : `#lines-${start}`;
  }
}

/** A file's page at `revision` (branch, tag or commit), optionally with lines highlighted. */
export function fileUrl(remote: ParsedRemote, revision: string, path: string, lines: LineSpan | null): string {
  const rev = encodePath(revision);
  const file = encodePath(path);
  const anchor = lineAnchor(remote.host, lines);
  switch (remote.host) {
    case "github":
      return `${base(remote)}/blob/${rev}/${file}${anchor}`;
    case "gitlab":
      return `${base(remote)}/-/blob/${rev}/${file}${anchor}`;
    case "bitbucket":
      return `${base(remote)}/src/${rev}/${file}${anchor}`;
  }
}

export function commitUrl(remote: ParsedRemote, hash: string): string {
  const id = encodeURIComponent(hash);
  switch (remote.host) {
    case "github":
      return `${base(remote)}/commit/${id}`;
    case "gitlab":
      return `${base(remote)}/-/commit/${id}`;
    case "bitbucket":
      return `${base(remote)}/commits/${id}`;
  }
}

/** vscode.dev opens GitHub repositories (and Azure Repos, which OpenMind doesn't recognise); `null` otherwise. */
export function vscodeDevUrl(
  remote: ParsedRemote,
  revision: string,
  path: string,
  lines: LineSpan | null,
): string | null {
  if (remote.host !== "github") return null;
  const anchor = lines === null ? "" : `#L${String(lines.start)}`;
  return `https://vscode.dev/github/${encodePath(remote.namespace)}/${encodeURIComponent(remote.repo)}/blob/${encodePath(revision)}/${encodePath(path)}${anchor}`;
}

/** `file:///C:/My%20Project/a.ts` for an absolute path (Windows drive, UNC or POSIX), with a line fragment. */
export function fileUri(path: string, line: number | null): string {
  const slashed = path.replace(/\\/g, "/");
  const fragment = line === null ? "" : `#L${String(line)}`;
  const encode = (parts: string[]) => parts.filter((part) => part.length > 0).map(encodeURIComponent).join("/");
  if (/^[a-zA-Z]:\//.test(slashed)) {
    return `file:///${slashed.slice(0, 2)}/${encode(slashed.slice(3).split("/"))}${fragment}`;
  }
  if (slashed.startsWith("//")) {
    // UNC: the server is the URI's authority.
    return `file://${encode(slashed.slice(2).split("/"))}${fragment}`;
  }
  return `file:///${encode(slashed.split("/"))}${fragment}`;
}
