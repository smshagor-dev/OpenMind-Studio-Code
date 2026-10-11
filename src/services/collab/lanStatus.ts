import { t } from "../../i18n";
import type { ConnectionRoute, FirewallStatus, RouteFailure } from "./collabNetIpc";

/** "Connected directly over the local network" / "... through the signaling server", in the user's language. */
export function routeLabel(route: ConnectionRoute): string {
  return route === "localLan"
    ? t("collab.lan.route.localLan")
    : t("collab.lan.route.internetRelay");
}

/**
 * Why joining over the local network failed, in the user's language: not found, blocked (Windows Firewall, the
 * network's policy, client isolation) or refused by the room.
 */
export function failureMessage(failure: RouteFailure): string {
  switch (failure) {
    case "notFound":
      return t("collab.lan.failure.notFound");
    case "blocked":
      return t("collab.lan.failure.blocked");
    case "refused":
      return t("collab.lan.failure.refused");
  }
}

/**
 * What Windows Firewall means for a room hosted here, in the user's language; `null` when there is nothing to say
 * (allowed, or not readable).
 */
export function firewallMessage(status: FirewallStatus): string | null {
  switch (status.verdict) {
    case "blocked":
      return t("collab.lan.firewall.blocked");
    case "noRule":
      return t("collab.lan.firewall.noRule");
    case "allowed":
    case "unknown":
      return null;
  }
}
