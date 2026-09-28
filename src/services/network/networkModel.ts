import { t } from "../../i18n";
import type { CacheEntry, NetProblem, NetworkStatus, ProxySource, TestOutcome } from "./networkIpc";

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
    ],
  ],
  [
    "timeout",
    ["timed out", "etimedout", "timeout was reached", "operation timed out", "i/o timeout", "read timed out"],
  ],
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
      "network is unreachable",
      "no route to host",
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

/** One line for the result of Test Connection. */
export function testText(outcome: TestOutcome): string {
  const via =
    outcome.route === "proxy" && outcome.proxy !== null
      ? t("network.test.viaProxy", { proxy: outcome.proxy })
      : t("network.test.direct");
  if (outcome.ok) {
    return t("network.test.ok", { status: outcome.status ?? 0, ms: outcome.elapsedMs, via });
  }
  const problem = problemText(outcome.problem ?? "other");
  return outcome.status !== null
    ? t("network.test.failedStatus", { problem, status: outcome.status, via })
    : t("network.test.failed", { problem, via });
}

export function kindText(kind: CacheEntry["kind"]): string {
  return t(`network.kind.${kind}`);
}

export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${String(bytes)} B`;
}
