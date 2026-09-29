import { describe, expect, it } from "vitest";

import type { BrokerEvent } from "./brokerIpc";
import { failureProblem, formatBytes, isActive, MAX_DOWNLOADS, percent, providerLabel, upsertDownload } from "./downloadsModel";

const event = (id: number, patch: Partial<BrokerEvent> = {}): BrokerEvent => ({
  id,
  provider: "pypi",
  artifact: `a${String(id)}.whl`,
  phase: "downloading",
  bytes: 0,
  total: null,
  speed: 0,
  retry: null,
  failure: null,
  detail: null,
  ...patch,
});

describe("downloadsModel", () => {
  it("keeps one row per operation, newest first, and at most MAX_DOWNLOADS", () => {
    let list = upsertDownload([], event(1));
    list = upsertDownload(list, event(2));
    list = upsertDownload(list, event(1, { phase: "complete" }));
    expect(list.map((e) => [e.id, e.phase])).toEqual([
      [2, "downloading"],
      [1, "complete"],
    ]);
    for (let id = 3; id < MAX_DOWNLOADS + 10; id += 1) list = upsertDownload(list, event(id));
    expect(list).toHaveLength(MAX_DOWNLOADS);
  });

  it("percent, sizes and activity", () => {
    expect(percent(event(1, { bytes: 50, total: 200 }))).toBe(25);
    expect(percent(event(1, { bytes: 5 }))).toBeNull();
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(300 * 1024 * 1024)).toBe("300 MB");
    expect(isActive(event(1))).toBe(true);
    expect(isActive(event(1, { phase: "failed" }))).toBe(false);
    expect(providerLabel("pypi")).toBe("pip");
    expect(providerLabel("download")).toBe("openmind-fetch");
  });

  it("only network failures reach the network card", () => {
    expect(failureProblem("proxyAuthentication")).toBe("proxyAuthRequired");
    expect(failureProblem("certificate")).toBe("tls");
    expect(failureProblem("checksum")).toBe("checksum");
    expect(failureProblem("notFound")).toBeNull();
    expect(failureProblem("diskFull")).toBeNull();
  });
});
