/**
 * Which kind of path a voice connection's audio takes, read from WebRTC statistics: the selected candidate pair's local
 * candidate type and, for a relay, how this side reaches the TURN server. Diagnostics only — no address, port or
 * candidate string ever leaves this function.
 */
export type VoicePath = "host" | "srflx" | "prflx" | "relayUdp" | "relayTcp" | "relayTls";

type Stat = Record<string, unknown>;

function text(stat: Stat | undefined, key: string): string | undefined {
  const value = stat?.[key];
  return typeof value === "string" ? value : undefined;
}

function stats(report: RTCStatsReport): Stat[] {
  const all: Stat[] = [];
  report.forEach((value: unknown) => {
    if (typeof value === "object" && value !== null) all.push(value as Stat);
  });
  return all;
}

/** The kind of path of the pair the connection uses now (`null` while none is selected). */
export function selectedPath(report: RTCStatsReport): VoicePath | null {
  const all = stats(report);
  const selectedId = all
    .filter((s) => s.type === "transport")
    .map((s) => text(s, "selectedCandidatePairId"))
    .find((id) => id !== undefined);
  const pair =
    all.find(
      (s) => s.type === "candidate-pair" && selectedId !== undefined && s.id === selectedId,
    ) ??
    all.find((s) => s.type === "candidate-pair" && s.nominated === true && s.state === "succeeded");
  const localId = text(pair, "localCandidateId");
  const local = all.find((s) => s.id === localId);
  switch (text(local, "candidateType")) {
    case "host":
      return "host";
    case "srflx":
      return "srflx";
    case "prflx":
      return "prflx";
    case "relay": {
      const protocol = text(local, "relayProtocol");
      return protocol === "tls" ? "relayTls" : protocol === "tcp" ? "relayTcp" : "relayUdp";
    }
    default:
      return null;
  }
}
