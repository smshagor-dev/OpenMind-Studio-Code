import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../../i18n";
import type { NetworkStatus } from "./networkIpc";
import { diagnoseNetwork, statusLabel, testText, validateProxyAddress } from "./networkModel";

const STATUS: NetworkStatus = {
  mode: "manual",
  source: "manual",
  active: true,
  http: "http://proxy.lab:3128",
  https: "http://proxy.lab:3128",
  socks: null,
  noProxy: ["localhost", "127.0.0.1", "::1"],
  pacUrl: null,
  problems: [],
  hasCredentials: false,
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

  it("describes a test result with its category and route", () => {
    const base = { status: null, route: "proxy", proxy: "proxy.lab:3128", elapsedMs: 12, detail: null };
    expect(testText({ ...base, ok: true, problem: null, status: 204 })).toBe(
      "Connected through proxy.lab:3128: HTTP 204 in 12 ms.",
    );
    expect(testText({ ...base, ok: false, problem: "proxyAuthRequired", status: 407 })).toBe(
      "Failed through proxy.lab:3128: the proxy requires a user name and password (HTTP 407).",
    );
    expect(testText({ ...base, route: "direct", ok: false, problem: "dns" })).toBe(
      "Failed directly: the server's name could not be found (DNS).",
    );
  });
});
