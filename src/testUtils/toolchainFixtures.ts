import type { ToolEntry, ToolVersion, ToolchainPacks } from "../services/toolchains/toolchainIpc";

export function toolVersion(overrides: Partial<ToolVersion> = {}): ToolVersion {
  return {
    version: "2.47.0",
    path: "C:/Apps/OpenMind Studio/tools/git/2.47.0/cmd/git.exe",
    status: "bundled",
    latest: false,
    sizeBytes: null,
    license: null,
    licenseUrl: null,
    verifyArgs: null,
    ...overrides,
  };
}

export function toolEntry(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    id: "git",
    name: "Git",
    category: "vcs",
    summary: "Version control used by Source Control.",
    details: "Git powers the Source Control view.",
    usedBy: ["Source Control"],
    command: "git",
    hint: "Not bundled in this build. Copy a version into tools/ and list it in tools/toolchains.json.",
    status: "missing",
    activeVersion: null,
    versions: [],
    maxVersions: 5,
    ignoredVersions: 0,
    path: null,
    ...overrides,
  };
}

/** A Git with three bundled versions, the newest active. */
export function gitWithVersions(): ToolEntry {
  return toolEntry({
    status: "active",
    activeVersion: "2.47.1",
    path: "C:/Apps/OpenMind Studio/tools/git/2.47.1/cmd/git.exe",
    versions: [
      toolVersion({
        version: "2.47.1",
        status: "active",
        latest: true,
        path: "C:/Apps/OpenMind Studio/tools/git/2.47.1/cmd/git.exe",
        license: "GPL-2.0",
        verifyArgs: ["--version"],
      }),
      toolVersion({ version: "2.46.2" }),
      toolVersion({ version: "2.45.0", status: "broken" }),
    ],
  });
}

export function packs(tools: ToolEntry[], overrides: Partial<ToolchainPacks> = {}): ToolchainPacks {
  return {
    toolsDir: "C:/Apps/OpenMind Studio/tools",
    platform: "windows-x64",
    manifestFound: true,
    manifestError: null,
    warnings: [],
    tools,
    ...overrides,
  };
}
