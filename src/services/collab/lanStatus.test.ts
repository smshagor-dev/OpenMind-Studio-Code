import { describe, expect, it } from "vitest";

import { failureMessage, firewallMessage, routeLabel } from "./lanStatus";

describe("local-network status text", () => {
  it("names the route and explains every failure category", () => {
    expect(routeLabel("localLan")).toBe("Connected directly over the local network");
    expect(routeLabel("internetRelay")).toBe("Connected through the signaling server");
    expect(failureMessage("blocked")).toContain("Windows Firewall");
    expect(failureMessage("blocked")).toContain("client isolation");
    expect(failureMessage("notFound")).toContain("Check the code");
    expect(failureMessage("notFound")).not.toContain("address");
    expect(failureMessage("refused")).toBe("The room refused the connection.");
  });

  it("says what Windows Firewall means for a hosted room, and nothing when it allows it", () => {
    expect(firewallMessage({ verdict: "blocked", networks: ["public"] })).toContain("block");
    expect(firewallMessage({ verdict: "noRule", networks: ["public"] })).toContain("Allow");
    expect(firewallMessage({ verdict: "allowed", networks: ["private"] })).toBeNull();
    expect(firewallMessage({ verdict: "unknown", networks: [] })).toBeNull();
  });
});
