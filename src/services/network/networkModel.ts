import { t } from "../../i18n";
import type {
  CacheEntry,
  NetProblem,
  NetworkDiagnostic,
  NetworkStatus,
  ProxySource,
  TestOutcome,
} from "./networkIpc";

/**
 * Pure helpers of the Network feature: the status bar label, validation of a proxy address as the backend reads it,
 * the words for a network problem, and recognizing a network problem in what a tool printed (the same rules as
 * `openmind_network::problem::diagnose`).
 */

const NEEDLES: [NetProblem, string[]][] = [
  [
    "proxyAuthRequired",
    [
      "407 proxy authentication",
      "proxy authentication required",
      "http 407",
      "status code 407",
      "received http code 407",
      "response 407",
      "e407",
      "proxyauthenticationrequired",
      "proxy requires authentication",
    ],
  ],
  [
    "proxyUnavailable",
    [
      "could not resolve proxy",
      "proxy unavailable",
      "proxyerror",
      "cannot connect to proxy",
      "unable to connect to proxy",
      "proxy connect aborted",
      "failed to connect to proxy",
      "proxy connection refused",
      "tunnel connection failed",
    ],
  ],
  [
    "tls",
    [
      "tls/certificate error",
      "ssl certificate problem",
      "certificate_verify_failed",
      "unable_to_get_issuer_cert",
      "unable to get local issuer certificate",
      "self signed certificate",
      "self-signed certificate",
      "certificate verify failed",
      "ssl: ",
      "sslerror",
      "invalid peer certificate",
      "schannel",
      "x509: certificate",
      "unknownissuer",
      "invalid certificate",
      "certificate verification failed",
      "received fatal alert",
      "corrupt message",
    ],
  ],
  [
    "dns",
    [
      "dns lookup failed",
      "could not resolve host",
      "getaddrinfo",
      "enotfound",
      "name or service not known",
      "no such host is known",
      "temporary failure in name resolution",
      "errno 11001",
      "failed to resolve",
      "dns error",
      "no such host",
      "failed to lookup address",
      "nodename nor servname",
      "no address associated",
      "host not found",
    ],
  ],
  [
    "timeout",
    ["timed out", "etimedout", "timeout was reached", "operation timed out", "i/o timeout", "read timed out"],
  ],
  ["unreachable", ["network is unreachable", "no route to host", "enetunreach", "ehostunreach", "network unreachable"]],
  [
    "connectionFailed",
    [
      "connection refused",
      "connection failed",
      "econnrefused",
      "failed to connect to",
      "could not connect to server",
      "econnreset",
      "connection reset",
    ],
  ],
  [
    "blocked",
    ["blocked by the network", "403 forbidden", "http 403", "status code 403", "e403", "451 unavailable"],
  ],
];

/** The network problem a tool's output shows, or `null`. */
export function diagnoseNetwork(output: string): NetProblem | null {
  const text = output.toLowerCase();
  for (const [problem, needles] of NEEDLES) {
    if (needles.some((needle) => text.includes(needle))) return problem;
  }
  return null;
}

/** Problems that are unmistakably about the network, safe to recognize in any terminal's output. */
export const STRONG_PROBLEMS: ReadonlySet<NetProblem> = new Set([
  "proxyAuthRequired",
  "proxyUnavailable",
  "tls",
  "dns",
  "unreachable",
]);

/** The status bar / terminal label: "Network: Manual Proxy" and so on. */
export function statusLabel(status: NetworkStatus | null, offlinePackages: number): string {
  if (status === null || status.mode === "none") {
    return offlinePackages > 0 && status?.useWheelhouse === true
      ? t("network.status.offlineCache")
      : t("network.status.noProxy");
  }
  if (status.mode === "manual") return t("network.status.manual");
  return status.active ? t("network.status.system") : t("network.status.systemNone");
}

export function sourceText(source: ProxySource): string {
  return t(`network.source.${source}`);
}

export function problemText(problem: NetProblem): string {
  return t(`network.problem.${problem}`);
}

/** Why a proxy address can't be used (the backend's rules), or `null`. An empty field is fine. */
export function validateProxyAddress(text: string, socks = false): string | null {
  const value = text.trim();
  if (value === "") return null;
  let rest = value;
  const at = value.indexOf("://");
  if (at >= 0) {
    const scheme = value.slice(0, at).toLowerCase();
    const allowed = socks ? ["socks5", "socks5h", "socks"] : ["http", "https"];
    if (!allowed.includes(scheme)) return t("network.invalid.scheme");
    rest = value.slice(at + 3);
  }
  rest = rest.replace(/\/+$/, "");
  if (rest.includes("@")) return t("network.invalid.credentials");
  if (/[/?#\s]/.test(rest) || rest === "") return t("network.invalid.address");
  const bracket = rest.startsWith("[");
  const portText = bracket ? rest.split("]")[1]?.replace(/^:/, "") ?? "" : rest.split(":")[1] ?? "";
  const hostPart = bracket ? rest.slice(1, rest.indexOf("]")) : (rest.split(":")[0] ?? "");
  if (hostPart === "" || (!bracket && rest.split(":").length > 2)) return t("network.invalid.address");
  if (portText !== "") {
    const port = Number(portText);
    if (!/^\d+$/.test(portText) || port < 1 || port > 65535) return t("network.invalid.port");
  }
  return null;
}

/** The short, actionable name of a problem: "DNS lookup failed", "Proxy authentication required" ... */
export function problemTitle(problem: NetProblem): string {
  return t(`network.label.${problem}`);
}

/** What to do about a problem, when there is something to do (`null` otherwise). */
export function problemHint(problem: NetProblem): string | null {
  const hinted: NetProblem[] = [
    "dns",
    "tls",
    "proxyAuthRequired",
    "proxyUnavailable",
    "timeout",
    "connectionFailed",
    "unreachable",
    "blocked",
  ];
  return hinted.includes(problem) ? t(`network.hint.${problem}`) : null;
}

/** The result of Test Connection: a headline, the route/status/time line, a hint, and the raw error for Details. */
export interface TestSummary {
  ok: boolean;
  title: string;
  line: string;
  hint: string | null;
  detail: string | null;
}

export function testSummary(outcome: TestOutcome): TestSummary {
  const via =
    outcome.route === "proxy" && outcome.proxy !== null
      ? t("network.test.viaProxy", { proxy: outcome.proxy })
      : t("network.test.direct");
  const parts = [via];
  if (outcome.status !== null) parts.push(`HTTP ${String(outcome.status)}`);
  parts.push(`${String(outcome.elapsedMs)} ms`);
  const problem = outcome.problem ?? "other";
  // A TLS failure that isn't about a certificate (the server doesn't speak TLS on that port, the network cuts the
  // handshake) must not be called a certificate problem.
  if (!outcome.ok && problem === "tls" && !isCertificateError(outcome.detail)) {
    return {
      ok: false,
      title: t("network.label.tlsHandshake"),
      line: parts.join(" · "),
      hint: t("network.hint.tlsHandshake"),
      detail: outcome.detail,
    };
  }
  return {
    ok: outcome.ok,
    title: outcome.ok ? t("network.test.connected") : problemTitle(problem),
    line: parts.join(" · "),
    hint: outcome.ok ? null : problemHint(problem),
    detail: outcome.detail,
  };
}

/** The error is about the server's certificate (untrusted issuer, expired, wrong name ...). Unknown detail: assume so. */
function isCertificateError(detail: string | null): boolean {
  if (detail === null) return true;
  return /certificat|issuer|x509|self[- ]signed|expired|notvalidforname/i.test(detail);
}

/** One sentence for a diagnostic of the proxy settings. */
export function diagnosticText(diagnostic: NetworkDiagnostic): string {
  switch (diagnostic.kind) {
    case "ignoredField":
      return t(`network.diag.ignored.${diagnostic.problem}`, { field: fieldName(diagnostic.field) });
    case "pacNotEvaluated":
      return t("network.diag.pacNotEvaluated", { url: diagnostic.url });
    default:
      return t(`network.diag.${diagnostic.kind}`);
  }
}

/** `https` -> `HTTPS`; an environment variable (System mode) keeps its name. */
function fieldName(field: string): string {
  return field === "http" || field === "https" || field === "socks" ? field.toUpperCase() : field;
}

/** pip printed this (its index path, its "no matching distribution" ending, its own modules). */
export function isPipOutput(text: string): boolean {
  const lower = text.toLowerCase();
  return [
    "no matching distribution found",
    "could not find a version that satisfies the requirement",
    "/simple/",
    "pip._vendor",
    "pip install",
    "python -m pip",
  ].some((needle) => lower.includes(needle));
}

/**
 * A command that can delete or change files, disks or system settings. Retry Command never runs one without asking.
 * Deliberately broad: a false alarm costs one click, a miss could cost files.
 */
export function isRiskyCommand(command: string): boolean {
  const text = ` ${command.toLowerCase()} `;
  const words = [
    "remove-item",
    " rm ",
    " rmdir ",
    " rd ",
    " del ",
    " erase ",
    " format ",
    "format-volume",
    " diskpart",
    "clear-disk",
    " reg ",
    "set-itemproperty",
    " setx ",
    " netsh ",
    " shutdown",
    "restart-computer",
    "stop-computer",
    " takeown",
    " icacls",
    " cipher ",
    " move-item",
    " mv ",
    " move ",
    " rename-item",
    " ren ",
    "git clean",
    "git reset --hard",
    "git push --force",
    " --force",
    " -rf",
    " /s ",
    " /q ",
    " sudo ",
    "runas",
    "invoke-expression",
    " iex ",
    "| sh",
    "| bash",
    "| iex",
    ">",
  ];
  return words.some((word) => text.includes(word));
}

export function kindText(kind: CacheEntry["kind"]): string {
  return t(`network.kind.${kind}`);
}

export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${String(bytes)} B`;
}
