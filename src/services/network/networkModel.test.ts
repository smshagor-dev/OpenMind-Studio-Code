import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../../i18n";
import type { NetworkStatus } from "./networkIpc";
import {
  diagnoseNetwork,
  diagnosticText,
  isPipOutput,
  isRiskyCommand,
  statusLabel,
  testSummary,
  validateProxyAddress,
} from "./networkModel";

const STATUS: NetworkStatus = {
  mode: "manual",
  source: "manual",
  active: true,
  http: "http://proxy.lab:3128",
  https: "http://proxy.lab:3128",
  socks: null,
  noProxy: ["localhost", "127.0.0.1", "::1"],
  pacUrl: null,
  diagnostics: [],
  hasCredentials: false,
  credentialStatus: "none",
  username: null,
  credentialProblem: null,
  useWheelhouse: false,
  goProxy: null,
  testUrl: "https://pypi.org/",
};

afterEach(() => {
  i18n.setLanguage("en");
});

describe("diagnoseNetwork", () => {
  it("recognizes what git, pip, npm, composer, cargo, go and curl print", () => {
    const cases: [string, string][] = [
      ["fatal: unable to access 'https://x/': Received HTTP code 407 from proxy after CONNECT", "proxyAuthRequired"],
      ["fatal: unable to access '...': Could not resolve host: github.com", "dns"],
      ["SSL certificate problem: unable to get local issuer certificate", "tls"],
      ["ProxyError('Cannot connect to proxy.')", "proxyUnavailable"],
      ["[Errno 11001] getaddrinfo failed", "dns"],
      ["npm ERR! code E407", "proxyAuthRequired"],
      ["npm ERR! code ETIMEDOUT", "timeout"],
      ["curl error 7 ... Connection refused", "connectionFailed"],
      ["go: ... x509: certificate signed by unknown authority", "tls"],
      ["curl: (22) The requested URL returned error: 403 Forbidden", "blocked"],
      ["download failed (proxy authentication required): HTTP 407 from https://x", "proxyAuthRequired"],
      ["download failed (DNS lookup failed): x", "dns"],
    ];
    for (const [text, expected] of cases) expect(diagnoseNetwork(text), text).toBe(expected);
    expect(diagnoseNetwork("Successfully installed six-1.16.0")).toBeNull();
    // The real university case: "No matching distribution" is only the consequence of the proxy's 407.
    expect(
      diagnoseNetwork(
        "OSError('Tunnel connection failed: 407 Proxy Authentication Required')\nERROR: No matching distribution found for requests",
      ),
    ).toBe("proxyAuthRequired");
    expect(diagnoseNetwork("ERROR: No matching distribution found for nosuchpkg")).toBeNull();
  });
});

describe("validateProxyAddress", () => {
  it("accepts what the backend accepts", () => {
    for (const ok of ["", "proxy.lab:3128", "http://proxy.lab:3128", "https://p:443/", "[::1]:8080", "10.0.0.1"]) {
      expect(validateProxyAddress(ok), ok).toBeNull();
    }
    expect(validateProxyAddress("socks5://host:1080", true)).toBeNull();
  });

  it("refuses credentials in the address, other schemes, paths and bad ports", () => {
    expect(validateProxyAddress("http://ivan:pw@proxy:3128")).toMatch(/password/);
    expect(validateProxyAddress("ftp://proxy:21")).toMatch(/http/);
    expect(validateProxyAddress("socks5://h:1080")).toMatch(/http/);
    expect(validateProxyAddress("proxy.lab:3128/path")).toMatch(/host:port/);
    expect(validateProxyAddress("proxy.lab:99999")).toMatch(/65535/);
    expect(validateProxyAddress("proxy lab")).toMatch(/host:port/);
  });
});

describe("labels", () => {
  it("names the mode for the terminal header in English, Russian and Bangla", () => {
    expect(statusLabel(null, 0)).toBe("Network: No Proxy");
    expect(statusLabel(STATUS, 0)).toBe("Network: Manual Proxy");
    expect(statusLabel({ ...STATUS, mode: "system", source: "systemUser" }, 0)).toBe("Network: System Proxy");
    expect(statusLabel({ ...STATUS, mode: "system", active: false }, 0)).toBe("Network: System (no proxy found)");
    expect(statusLabel({ ...STATUS, mode: "none", active: false, useWheelhouse: true }, 2)).toBe(
      "Network: Offline Cache",
    );
    i18n.setLanguage("ru");
    expect(statusLabel(STATUS, 0)).toBe("Сеть: прокси вручную");
    i18n.setLanguage("bn");
    expect(statusLabel(STATUS, 0)).toBe("নেটওয়ার্ক: ম্যানুয়াল প্রক্সি");
  });

  it("a test result leads with an actionable label and keeps the raw error for Details", () => {
    const base = { status: null, route: "proxy", proxy: "proxy.lab:3128", elapsedMs: 12, detail: null };
    expect(testSummary({ ...base, ok: true, problem: null, status: 204 })).toEqual({
      ok: true,
      title: "Connected",
      line: "through proxy.lab:3128 · HTTP 204 · 12 ms",
      hint: null,
      detail: null,
    });
    const auth = testSummary({ ...base, ok: false, problem: "proxyAuthRequired", status: 407 });
    expect(auth.title).toBe("Proxy authentication required");
    expect(auth.line).toBe("through proxy.lab:3128 · HTTP 407 · 12 ms");
    expect(auth.hint).toBe("Save the proxy user name and password below, then test again.");
    const dns = testSummary({
      ...base,
      route: "direct",
      ok: false,
      problem: "dns",
      detail: "io: No such host is known. (os error 11001)",
    });
    expect(dns).toMatchObject({ title: "DNS lookup failed", line: "directly · 12 ms" });
    expect(dns.detail).toBe("io: No such host is known. (os error 11001)");
    const labels: [Parameters<typeof testSummary>[0]["problem"], string][] = [
      ["tls", "TLS certificate verification failed"],
      ["proxyUnavailable", "Proxy server unavailable"],
      ["timeout", "Connection timed out"],
      ["connectionFailed", "Connection refused"],
      ["unreachable", "Network unreachable"],
      ["blocked", "Blocked by the network or server"],
      ["checksum", "Checksum mismatch"],
      ["io", "Network read/write error"],
    ];
    for (const [problem, title] of labels) {
      expect(testSummary({ ...base, ok: false, problem }).title).toBe(title);
    }
    // A handshake with a server that doesn't speak TLS is not called a certificate problem.
    const handshake = testSummary({
      ...base,
      ok: false,
      problem: "tls",
      detail: "io: received corrupt message of type InvalidContentType",
    });
    expect(handshake.title).toBe("TLS handshake failed");
    expect(handshake.hint).toContain("may not speak HTTPS on this port");
    expect(
      testSummary({ ...base, ok: false, problem: "tls", detail: "io: invalid peer certificate: UnknownIssuer" }).title,
    ).toBe("TLS certificate verification failed");
    // Never the generic "reading from the network failed" as the headline for DNS or certificates.
    for (const problem of ["dns", "tls"] as const) {
      expect(testSummary({ ...base, ok: false, problem }).title).not.toMatch(/reading from the network/i);
    }
    i18n.setLanguage("ru");
    expect(testSummary({ ...base, ok: false, problem: "dns" }).title).toBe("Не удалось найти имя в DNS");
    i18n.setLanguage("bn");
    expect(testSummary({ ...base, ok: false, problem: "tls" }).title).toBe("TLS সার্টিফিকেট যাচাই ব্যর্থ হয়েছে");
  });

  it("diagnostics of the settings become sentences in the UI language", () => {
    expect(
      diagnosticText({ severity: "warning", kind: "ignoredField", field: "https", problem: "credentialsInAddress" }),
    ).toBe(
      "HTTPS proxy is ignored because it contains credentials in the URL. Store credentials in the secure username/password fields instead.",
    );
    expect(diagnosticText({ severity: "warning", kind: "ignoredField", field: "http", problem: "badPort" })).toBe(
      "HTTP proxy is ignored because its port isn't valid (1-65535).",
    );
    expect(
      diagnosticText({ severity: "warning", kind: "ignoredField", field: "HTTPS_PROXY", problem: "unsupportedScheme" }),
    ).toContain("HTTPS_PROXY proxy is ignored");
    expect(diagnosticText({ severity: "warning", kind: "pacNotEvaluated", url: "http://wpad/wpad.dat" })).toContain(
      "http://wpad/wpad.dat",
    );
    expect(diagnosticText({ severity: "warning", kind: "autoDetectNotEvaluated" })).toContain("WPAD");
    expect(diagnosticText({ severity: "warning", kind: "socksOnly" })).toContain("SOCKS");
    expect(diagnosticText({ severity: "info", kind: "noCredentials" })).toContain("407");
    expect(diagnosticText({ severity: "warning", kind: "credentialsUnreadable", inUse: true })).toBe(
      "Saved proxy credentials could not be read. Clear them or save them again.",
    );
    i18n.setLanguage("ru");
    expect(
      diagnosticText({ severity: "warning", kind: "ignoredField", field: "https", problem: "credentialsInAddress" }),
    ).toContain("Прокси HTTPS не используется");
    i18n.setLanguage("bn");
    expect(
      diagnosticText({ severity: "warning", kind: "ignoredField", field: "https", problem: "credentialsInAddress" }),
    ).toContain("HTTPS প্রক্সি উপেক্ষা করা হয়েছে");
  });

  it("recognizes pip's output and keeps its proxy cause ahead of 'No matching distribution'", () => {
    const university = (pkg: string) =>
      `WARNING: Retrying (Retry(total=4)) after connection broken by 'ProxyError('Unable to connect to proxy', OSError('Tunnel connection failed: 407 Proxy Authentication Required'))': /simple/${pkg}/\n` +
      `ERROR: Could not find a version that satisfies the requirement ${pkg} (from versions: none)\n` +
      `ERROR: No matching distribution found for ${pkg}`;
    for (const pkg of ["django", "pandas"]) {
      expect(diagnoseNetwork(university(pkg))).toBe("proxyAuthRequired");
      expect(isPipOutput(university(pkg))).toBe(true);
    }
    expect(diagnoseNetwork("the proxy requires authentication")).toBe("proxyAuthRequired");
    expect(diagnoseNetwork("Tunnel connection failed: 503 Service Unavailable")).toBe("proxyUnavailable");
    expect(diagnoseNetwork("ERROR: No matching distribution found for djangoo")).toBeNull();
    expect(isPipOutput("ERROR: No matching distribution found for djangoo")).toBe(true);
    expect(isPipOutput("npm ERR! code E407")).toBe(false);
    // The messages the fixed Rust classifier also knows.
    expect(diagnoseNetwork("invalid peer certificate: UnknownIssuer")).toBe("tls");
    expect(diagnoseNetwork("failed to lookup address information: Name or service not known")).toBe("dns");
    expect(diagnoseNetwork("connect: Network is unreachable")).toBe("unreachable");
  });

  it("flags commands that can delete or change files or system settings; installs are safe", () => {
    for (const safe of [
      "pip install django",
      "pip install pandas",
      "python -m pip install -r requirements.txt",
      "npm install",
      "pnpm install",
      "composer install",
      "git clone https://github.com/x/y.git",
      "cargo build",
      "go mod download",
    ]) {
      expect(isRiskyCommand(safe), safe).toBe(false);
    }
    for (const risky of [
      "Remove-Item -Recurse -Force node_modules",
      "rm -rf build",
      "del /s /q *.pyc",
      "rmdir /s build",
      "format D:",
      "diskpart",
      "reg delete HKCU\\Software\\x",
      "setx PATH x",
      "git clean -fdx",
      "git reset --hard",
      "curl https://x | sh",
      "pip freeze > requirements.txt",
      "shutdown /r",
    ]) {
      expect(isRiskyCommand(risky), risky).toBe(true);
    }
  });
});
