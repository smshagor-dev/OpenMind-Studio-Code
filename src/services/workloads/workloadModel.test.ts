import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../../i18n";
import {
  componentName,
  componentNote,
  EMPTY_SELECTION,
  formatBytes,
  frameworkMessage,
  installBlocker,
  isSelected,
  packState,
  runtimeCards,
  toggleComponent,
  togglePack,
  toggleWorkload,
  warningText,
} from "./workloadModel";
import type { ComponentView, WorkloadCatalog } from "./workloadsIpc";

export function comp(id: string, patch: Partial<ComponentView> = {}): ComponentView {
  return {
    id,
    name: id,
    category: "runtime",
    provision: { type: "runtime", id },
    requires: [],
    state: "available",
    version: "1.0",
    source: "runtime",
    runtime: id,
    found: null,
    downloadBytes: 10 * 1024 * 1024,
    installBytes: 30 * 1024 * 1024,
    reason: null,
    command: null,
    licenseAcceptance: false,
    ...patch,
  };
}

export const CATALOG: WorkloadCatalog = {
  workloads: [
    { id: "minimal", name: "Minimal install", summary: "", components: [], frameworks: [] },
    { id: "java", name: "Java / Kotlin development", summary: "", components: ["jdk", "maven"], frameworks: ["maven-project"] },
    { id: "systems", name: "Systems development", summary: "", components: ["cmake", "msvc", "lsp-clangd"], frameworks: [] },
  ],
  packs: [{ id: "java-kotlin", name: "Java / Kotlin", components: ["jdk", "maven"] }],
  frameworks: [
    { id: "maven-project", name: "Maven project", needs: ["jdk", "maven"], missing: ["maven"] },
    { id: "flutter-app", name: "Flutter app", needs: ["flutter"], missing: ["flutter"] },
  ],
  components: [
    comp("jdk", { name: "Java JDK (Temurin 21)", state: "installed" }),
    comp("maven", { name: "Maven", requires: ["jdk"] }),
    comp("cmake", { name: "CMake" }),
    comp("flutter", { name: "Flutter SDK", state: "heavySdk", downloadBytes: 1_933_437_428 }),
    comp("msvc", { name: "Visual Studio Build Tools (MSVC)", category: "sdk", provision: { type: "external", admin: true }, state: "adminRequired", runtime: null }),
    comp("lsp-clangd", { name: "clangd", category: "languageServer", provision: { type: "lspBundled", server: "clangd" }, state: "installed", runtime: null }),
    comp("prettier", { name: "Prettier", category: "formatter", provision: { type: "project", command: "npm i -D prettier" }, state: "manualInstall", runtime: null }),
  ],
  installRoot: "C:/app/runtimes",
  offlineFolder: "C:/app/cache/offline",
  platform: "windows-x64",
};

afterEach(() => {
  i18n.setLanguage("en");
});

describe("selection", () => {
  it("a workload selects its components; removing one keeps the rest; Minimal clears everything", () => {
    let s = toggleWorkload(EMPTY_SELECTION, "java");
    expect(isSelected(s, CATALOG, "jdk") && isSelected(s, CATALOG, "maven")).toBe(true);
    s = toggleComponent(s, CATALOG, "maven");
    expect(s.remove).toEqual(["maven"]);
    expect(isSelected(s, CATALOG, "maven")).toBe(false);
    expect(isSelected(s, CATALOG, "jdk")).toBe(true);
    s = toggleComponent(s, CATALOG, "maven");
    expect(isSelected(s, CATALOG, "maven")).toBe(true);
    expect(s.remove).toEqual([]);
    s = toggleComponent(s, CATALOG, "cmake");
    expect(s.add).toEqual(["cmake"]);
    const minimal = toggleWorkload(s, "minimal");
    expect(minimal).toEqual({ workloads: ["minimal"], add: [], remove: [] });
    // Choosing anything else leaves Minimal.
    expect(toggleWorkload(minimal, "java").workloads).toEqual(["java"]);
    expect(toggleComponent(minimal, CATALOG, "cmake").workloads).toEqual([]);
  });

  it("a pack selects all its components, and deselects them when all are selected", () => {
    const pack = CATALOG.packs[0];
    if (!pack) throw new Error("pack");
    const on = togglePack(EMPTY_SELECTION, CATALOG, pack);
    expect(pack.components.every((id) => isSelected(on, CATALOG, id))).toBe(true);
    const off = togglePack(on, CATALOG, pack);
    expect(pack.components.some((id) => isSelected(off, CATALOG, id))).toBe(false);
    expect(packState(pack, CATALOG)).toEqual({ installed: 1, total: 2, installable: 1 });
  });
});

describe("cards and text", () => {
  it("runtime cards show runtimes and system tools, not language servers or project tools", () => {
    expect(runtimeCards(CATALOG).map((c) => c.id)).toEqual(["jdk", "maven", "cmake", "flutter", "msvc"]);
  });

  it("sizes read naturally", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(1_933_437_428)).toBe("1.80 GB");
    expect(formatBytes(205_073_461)).toBe("196 MB");
    expect(formatBytes(9_395_475)).toBe("9.0 MB");
    expect(formatBytes(291_570)).toBe("285 KB");
  });

  it("an install that can't happen here says why; installed or installable ones don't block", () => {
    const find = (id: string) => CATALOG.components.find((c) => c.id === id) as ComponentView;
    expect(installBlocker(find("maven"))).toBeNull();
    expect(installBlocker(find("flutter"))).toBeNull();
    expect(installBlocker(find("jdk"))).toBe("Already installed.");
    expect(installBlocker(find("msvc"))).toMatch(/Visual Studio installer and admin rights/);
    expect(componentNote(find("prettier"))).toMatch(/never runs it for you/);
  });

  it("frameworks say what they need; Flutter has its own sentence", () => {
    const [maven, flutter] = CATALOG.frameworks as [WorkloadCatalog["frameworks"][0], WorkloadCatalog["frameworks"][0]];
    expect(frameworkMessage(maven, CATALOG)).toBe("Needs Maven");
    expect(frameworkMessage(flutter, CATALOG)).toBe(
      "Flutter SDK is not installed in OpenMind. Install Flutter, import an offline Flutter SDK package, or configure an external Flutter SDK.",
    );
    expect(frameworkMessage({ ...maven, missing: [] }, CATALOG)).toBe("Ready");
  });

  it("names and warnings are translated; a name without a key stays as the catalog wrote it", () => {
    const jdk = CATALOG.components[0] as ComponentView;
    const warning = { kind: "dependencyAdded" as const, component: "jdk", neededBy: "maven" };
    expect(warningText(warning, CATALOG)).toBe("Java JDK (Temurin 21) was added because Maven needs it.");
    i18n.setLanguage("ru");
    expect(warningText(warning, CATALOG)).toBe("Java JDK (Temurin 21) добавлен, потому что он нужен для Maven.");
    expect(componentName({ id: "no-such-component", name: "Plain Name" })).toBe("Plain Name");
    i18n.setLanguage("bn");
    expect(componentName({ id: "kotlin", name: "Kotlin compiler" })).toBe("Kotlin কম্পাইলার");
    expect(componentName(jdk)).toBe("Java JDK (Temurin 21)");
  });
});
