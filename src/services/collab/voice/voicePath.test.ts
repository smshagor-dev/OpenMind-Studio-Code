import { describe, expect, it } from "vitest";

import { selectedPath } from "./voicePath";

function report(entries: Record<string, unknown>[]): RTCStatsReport {
  const map = new Map(entries.map((e) => [e.id, e]));
  return map as unknown as RTCStatsReport;
}

const pair = { id: "p1", type: "candidate-pair", localCandidateId: "l1", state: "succeeded" };

describe("the voice path from WebRTC statistics", () => {
  it("names the selected pair's local candidate type and the relay protocol", () => {
    const transport = { id: "t", type: "transport", selectedCandidatePairId: "p1" };
    const cases: [Record<string, unknown>, string][] = [
      [{ candidateType: "host" }, "host"],
      [{ candidateType: "srflx" }, "srflx"],
      [{ candidateType: "prflx" }, "prflx"],
      [{ candidateType: "relay", relayProtocol: "udp" }, "relayUdp"],
      [{ candidateType: "relay", relayProtocol: "tcp" }, "relayTcp"],
      [{ candidateType: "relay", relayProtocol: "tls" }, "relayTls"],
    ];
    for (const [local, path] of cases) {
      const stats = report([transport, pair, { id: "l1", type: "local-candidate", ...local }]);
      expect(selectedPath(stats)).toBe(path);
    }
  });

  it("falls back to the nominated pair and says nothing before one exists", () => {
    const nominated = { ...pair, nominated: true };
    const local = {
      id: "l1",
      type: "local-candidate",
      candidateType: "relay",
      relayProtocol: "tls",
    };
    expect(selectedPath(report([nominated, local]))).toBe("relayTls");
    expect(selectedPath(report([local]))).toBeNull();
    expect(selectedPath(report([]))).toBeNull();
  });
});
