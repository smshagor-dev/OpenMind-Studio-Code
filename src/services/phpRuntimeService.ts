import type { FeatureStatus, InstalledVersion, RuntimeStatus } from "./ipc";
import type { MariaDbService } from "./mariaDbService";
import type { PhpMyAdminService } from "./phpMyAdminService";
import type { PhpServerService } from "./phpServerService";
import type { Availability, InjectionView, RuntimeService } from "./runtimeService";
import { describeProgress, injectionStatus } from "./runtimeService";

/** The runtimes the PHP Server window manages, in the order they are shown. */
export const PHP_RUNTIME_IDS = ["php", "composer", "mariadb", "phpmyadmin"] as const;
export type PhpRuntimeId = (typeof PHP_RUNTIME_IDS)[number];

const NAMES: Record<PhpRuntimeId, string> = {
  php: "PHP",
  composer: "Composer",
  mariadb: "MariaDB",
  phpmyadmin: "phpMyAdmin",
};

/** What each provides, shown (as "not installed") before any version exists to check. */
const FEATURE_LABELS: Record<PhpRuntimeId, readonly string[]> = {
  php: ["PHP CLI", "Built-in server (php -S)", "php.ini (OpenMind)"],
  composer: ["Composer PHAR"],
  mariadb: ["Server (mysqld)", "Database initializer", "Admin tool (ping/shutdown)"],
  phpmyadmin: ["Web interface"],
};

/** How many leading version components make a "line" (PHP 8.3, Composer 2): an update stays in its line. */
const LINE_DEPTH: Record<PhpRuntimeId, number> = { php: 2, composer: 1, mariadb: 2, phpmyadmin: 1 };

/** PHP 8.4 is the one recommended to install. */
const RECOMMENDED_PHP_LINE = "8.4.";

export interface VersionView {
  version: string;
  installed: boolean;
  active: boolean;
  healthy: boolean;
  /** The manifest's default (PHP 8.4). */
  recommended: boolean;
  install: Availability;
  setActive: Availability;
  repair: Availability;
  remove: Availability;
  /** Only for installed versions: what that install can actually do. */
  features: FeatureStatus[];
  terminal: InjectionView | null;
}

export interface FeatureView {
  label: string;
  available: boolean;
  note: string;
}

export interface UpdateView {
  version: string;
  availability: Availability;
}

export interface CardView {
  id: PhpRuntimeId;
  name: string;
  installed: boolean;
  /** The active version, or `null` when none is. */
  activeVersion: string | null;
  installedVersions: VersionView[];
  availableVersions: VersionView[];
  source: "portable" | "system" | "none";
  sourceLabel: string;
  terminal: InjectionView;
  features: FeatureView[];
  update: UpdateView | null;
  /** Something the user should know (a running PHP server on an older PHP, Composer without PHP, ...). */
  notice: string | null;
  working: boolean;
  progressLabel: string | null;
  error: string | null;
}

/** Composer's relationship to PHP, shown on its card. */
export interface ComposerDependency {
  ok: boolean;
  label: string;
}

function numbers(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compare(a: string, b: string): number {
  const left = numbers(a);
  const right = numbers(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function line(id: PhpRuntimeId, version: string): string {
  return version.split(".").slice(0, LINE_DEPTH[id]).join(".");
}

/**
 * The PHP and Composer version manager shown in the PHP Server window: what is
 * installed and active, which versions can be installed (PHP 8.0 to 8.4), and
 * every action's enabled state with its reason. A *view model* over
 * `RuntimeService` (which does the installing) and `PhpServerService` (which
 * knows whether a running server is holding a PHP version).
 */
export class PhpRuntimeService {
  constructor(
    private readonly runtime: RuntimeService,
    private readonly php: PhpServerService,
    /** The running database services pin their runtime, like the PHP server pins its PHP. */
    private readonly stack: { mariadb: MariaDbService; pma: PhpMyAdminService } | null = null,
  ) {}

  cards(): CardView[] {
    return PHP_RUNTIME_IDS.map((id) => this.card(id));
  }

  card(id: PhpRuntimeId): CardView {
    const status = this.runtime.getState().runtimes.find((entry) => entry.id === id);
    const working = id in this.runtime.getState().working;
    const progress = this.runtime.getState().progress[id];
    const installed = status?.installed ?? [];
    const active = installed.find((entry) => entry.active) ?? null;
    const shown = active ?? installed[0] ?? null;
    const hasInstall = installed.length > 0;
    const systemVersion = status?.globalVersion ?? null;
    const source: CardView["source"] = hasInstall ? "portable" : systemVersion ? "system" : "none";
    return {
      id,
      name: NAMES[id],
      installed: hasInstall,
      activeVersion: active?.version ?? null,
      installedVersions: installed
        .map((entry) => this.versionView(id, status, entry.version))
        .sort((a, b) => compare(b.version, a.version)),
      availableVersions: (status?.availableVersions ?? [])
        .filter((version) => !installed.some((entry) => entry.version === version))
        .map((version) => this.versionView(id, status, version))
        .sort((a, b) => compare(b.version, a.version)),
      source,
      sourceLabel: sourceLabel(source, systemVersion),
      terminal: active
        ? injectionStatus(active)
        : { injected: false, label: hasInstall ? "Not active in new terminals" : "Not active" },
      features: featureViews(id, shown),
      update: status ? this.updateFor(id, status) : null,
      notice: this.noticeFor(id),
      working,
      progressLabel: working && progress ? describeProgress(progress).label : null,
      error: this.runtime.getState().errors[id] ?? null,
    };
  }

  /** Composer runs on the active portable PHP; this says whether one exists. */
  composerDependency(): ComposerDependency {
    const php = this.card("php");
    if (php.activeVersion === null) {
      return {
        ok: false,
        label: php.installed
          ? "No PHP is active — Composer can't run. Set a PHP version active."
          : "PHP isn't installed — Composer needs OpenMind's portable PHP.",
      };
    }
    return { ok: true, label: `Runs on the active PHP ${php.activeVersion}` };
  }

  // --- Actions (each already refuses what its availability forbids) ---

  install(id: PhpRuntimeId, version: string): Promise<boolean> {
    return this.runtime.install(id, version);
  }

  setActive(id: PhpRuntimeId, version: string): Promise<boolean> {
    return this.runtime.setActive(id, version);
  }

  repair(id: PhpRuntimeId, version: string): Promise<boolean> {
    return this.runtime.repair(id, version);
  }

  remove(id: PhpRuntimeId, version: string): Promise<boolean> {
    return this.runtime.remove(id, version);
  }

  // --- Internals ---

  private versionView(
    id: PhpRuntimeId,
    status: RuntimeStatus | undefined,
    version: string,
  ): VersionView {
    const entry = status?.installed.find((candidate) => candidate.version === version);
    const recommended =
      id === "php" ? version.startsWith(RECOMMENDED_PHP_LINE) : version === status?.defaultVersion;
    if (status === undefined) {
      const none: Availability = { enabled: false, reason: "Runtimes are still loading." };
      return {
        version,
        installed: false,
        active: false,
        healthy: false,
        recommended,
        install: none,
        setActive: none,
        repair: none,
        remove: none,
        features: [],
        terminal: null,
      };
    }
    const inUse = this.inUse(id, version);
    return {
      version,
      installed: entry !== undefined,
      active: entry?.active ?? false,
      healthy: entry?.healthy ?? false,
      recommended,
      install: this.installFor(id, status, version),
      setActive: this.runtime.activateAvailability(status, version),
      repair: inUse ?? this.runtime.repairAvailability(status, version),
      remove: inUse ?? this.runtime.deleteAvailability(status),
      features: entry?.features ?? [],
      terminal: entry ? injectionStatus(entry) : null,
    };
  }

  private installFor(id: PhpRuntimeId, status: RuntimeStatus, version: string): Availability {
    if (id === "composer" && this.card("php").installedVersions.length === 0) {
      return { enabled: false, reason: "Install PHP first — Composer runs on it." };
    }
    if (id === "phpmyadmin" && this.card("php").installedVersions.length === 0) {
      return { enabled: false, reason: "Install PHP first — phpMyAdmin runs on it." };
    }
    return this.runtime.installAvailability(status, version);
  }

  private updateFor(id: PhpRuntimeId, status: RuntimeStatus): UpdateView | null {
    let best: string | null = null;
    for (const entry of status.installed) {
      for (const version of status.availableVersions) {
        const newer = compare(version, entry.version) > 0;
        const sameLine = line(id, version) === line(id, entry.version);
        const have = status.installed.some((candidate) => candidate.version === version);
        if (newer && sameLine && !have && (best === null || compare(version, best) > 0)) {
          best = version;
        }
      }
    }
    return best === null
      ? null
      : { version: best, availability: this.installFor(id, status, best) };
  }

  /** Why this version can't be deleted or repaired right now, if a running service uses it. */
  private inUse(id: PhpRuntimeId, version: string): Availability | null {
    if (id === "mariadb" && this.stack?.mariadb.isRunning() === true) {
      return { enabled: false, reason: "MariaDB is running. Stop it first." };
    }
    if (id === "phpmyadmin" && this.stack?.pma.isRunning() === true) {
      return { enabled: false, reason: "phpMyAdmin is running. Stop it first." };
    }
    return id === "php" || id === "composer" ? this.php.versionInUse(id, version) : null;
  }

  private noticeFor(id: PhpRuntimeId): string | null {
    if (id === "php") return this.php.restartNotice();
    if (id === "mariadb") return null;
    if (id === "phpmyadmin") return this.stack?.pma.restartNotice() ?? null;
    const dependency = this.composerDependency();
    const composer = this.runtime.getState().runtimes.find((entry) => entry.id === "composer");
    return dependency.ok || (composer?.installed.length ?? 0) === 0 ? null : dependency.label;
  }
}

function sourceLabel(source: CardView["source"], systemVersion: string | null): string {
  if (source === "portable") return "OpenMind portable";
  if (source === "system") {
    return `System detected (${systemVersion ?? "unknown"}) — OpenMind never uses it`;
  }
  return "Not installed";
}

function featureViews(id: PhpRuntimeId, install: InstalledVersion | null): FeatureView[] {
  if (install === null) {
    return FEATURE_LABELS[id].map((label) => ({ label, available: false, note: "Not installed" }));
  }
  return install.features.map((feature) => ({
    label: feature.label,
    available: feature.available,
    note: feature.note,
  }));
}
