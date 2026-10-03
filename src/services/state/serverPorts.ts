import { MARIADB_PORT_SOURCE } from "../mariaDbService";
import { PMA_PORT_SOURCE } from "../phpMyAdminService";
import { PHP_PORT_SOURCE } from "../phpServerService";
import type { PortRegistration, PortsService } from "../portsService";
import type { ServersState } from "./canonicalIpc";

/** The managed servers' ports, from the canonical servers state (the same entries the services register). */
export function portsFromServers(servers: ServersState): PortRegistration[] {
  const ports: PortRegistration[] = [];
  if (servers.php !== null) {
    ports.push({ port: servers.php.port, label: "PHP Server", url: servers.php.url, source: PHP_PORT_SOURCE });
  }
  const mariadb = servers.mysql.mariadb;
  if (mariadb !== null) {
    ports.push({
      port: mariadb.port,
      label: mariadb.ready ? "MariaDB" : "MariaDB (starting)",
      url: null,
      source: MARIADB_PORT_SOURCE,
    });
  }
  const pma = servers.mysql.phpmyadmin;
  if (pma !== null) {
    ports.push({ port: pma.port, label: "phpMyAdmin", url: pma.url ?? null, source: PMA_PORT_SOURCE });
  }
  return ports;
}

const MANAGED_SOURCES = [PHP_PORT_SOURCE, MARIADB_PORT_SOURCE, PMA_PORT_SOURCE];

/**
 * The Ports view's managed-server entries follow the canonical servers state in every window: a server that starts
 * appears, one that stops disappears, whichever window (or the PHP control panel) started it. Ports registered under
 * other sources are left alone.
 */
export function followServerPorts(
  ports: Pick<PortsService, "register" | "unregisterSource" | "list">,
  servers: ServersState,
): void {
  const wanted = portsFromServers(servers);
  for (const source of MANAGED_SOURCES) {
    const keep = wanted.filter((port) => port.source === source);
    const stale = ports.list().filter((entry) => entry.source === source && !keep.some((p) => p.port === entry.port));
    if (stale.length > 0) ports.unregisterSource(source);
  }
  for (const registration of wanted) ports.register(registration);
}
