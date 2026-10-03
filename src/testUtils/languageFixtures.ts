import { ipcWorkspaceFeed } from "./canonicalFeeds";
import { vi } from "vitest";

import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import type {
  CommandStatus,
  FileLanguageStatus,
  FormatOption,
  LanguageDef,
  ProjectStatus,
  ToolStatus,
  WorkspaceStatus,
} from "../services/language/languageIpc";
import { LanguageSupportService } from "../services/language/languageSupportService";
import { ProjectCommandService } from "../services/language/projectCommandService";
import { createFakeIpc } from "./fakeIpcClient";

export function languageDef(id: string, overrides: Partial<LanguageDef> = {}): LanguageDef {
  return {
    id,
    name: id,
    group: "web",
    extensions: [],
    filenames: [],
    comment: "//",
    monaco: id,
    syntax: "exact",
    formatters: [],
    linters: [],
    lsp: [],
    toolchains: [],
    levels: ["syntax"],
    ...overrides,
  };
}

/** A small slice of the backend's registry: enough to exercise every matching rule. */
export const REGISTRY: LanguageDef[] = [
  languageDef("typescript", {
    name: "TypeScript",
    extensions: [".ts", ".mts"],
    formatters: ["prettier"],
    linters: ["eslint"],
    lsp: ["typescript-language-server"],
    levels: ["syntax", "lsp", "format", "lint", "run", "test", "build"],
  }),
  languageDef("go", {
    name: "Go",
    extensions: [".go"],
    formatters: ["gofmt"],
    levels: ["syntax", "format", "build", "test"],
  }),
  languageDef("rust", {
    name: "Rust",
    extensions: [".rs"],
    lsp: ["rust-analyzer"],
    formatters: ["rustfmt"],
  }),
  languageDef("dockerfile", {
    name: "Dockerfile",
    extensions: [".dockerfile"],
    filenames: ["dockerfile", "dockerfile.*", "containerfile"],
  }),
  languageDef("dockercompose", {
    name: "Docker Compose",
    monaco: "yaml",
    filenames: ["docker-compose.yml", "docker-compose.*.yml", "compose.yaml"],
  }),
  languageDef("yaml", { name: "YAML", extensions: [".yaml", ".yml"] }),
  languageDef("dotenv", {
    name: "Environment file (.env)",
    monaco: "ini",
    syntax: "approximate",
    extensions: [".env"],
    filenames: [".env", ".env.*"],
  }),
  languageDef("vue", { name: "Vue", monaco: "html", syntax: "approximate", extensions: [".vue"] }),
  languageDef("dart", { name: "Dart", monaco: "plaintext", syntax: "none", extensions: [".dart"] }),
  languageDef("plaintext", { name: "Plain Text", monaco: "plaintext", extensions: [".txt"] }),
  languageDef("cmake", {
    name: "CMake",
    monaco: "plaintext",
    syntax: "none",
    filenames: ["cmakelists.txt"],
  }),
];

/** A language of the fixture registry (throws for an id it doesn't have, so a typo fails the test). */
export function language(id: string): LanguageDef {
  const found = REGISTRY.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no fixture language ${id}`);
  return found;
}

export function tool(id: string, found: boolean, hint = `Install ${id}.`): ToolStatus {
  return {
    id,
    name: id === "node" ? "Node.js" : id,
    found: found ? { path: `C:/tools/${id}.exe`, source: "system" } : null,
    hint,
  };
}

export function commandStatus(overrides: Partial<CommandStatus> = {}): CommandStatus {
  return {
    id: "node.script.dev",
    label: "pnpm run dev",
    category: "dev",
    argv: ["pnpm", "run", "dev"],
    cwd: "",
    tools: ["node", "pnpm"],
    network: false,
    note: null,
    unavailable: null,
    available: true,
    reason: null,
    missing: [],
    ...overrides,
  };
}

export function projectStatus(overrides: Partial<ProjectStatus> = {}): ProjectStatus {
  const commandList = overrides.commandStatus ?? [commandStatus()];
  return {
    root: "",
    name: "My Project",
    detections: [
      {
        id: "vite",
        name: "Vite",
        group: "web",
        confidence: "high",
        evidence: "vite.config.ts exists",
      },
      {
        id: "react",
        name: "React",
        group: "web",
        confidence: "medium",
        evidence: "package.json depends on react",
      },
    ],
    packageManager: "pnpm",
    ambiguous: false,
    notes: [],
    tools: ["node", "pnpm"],
    commands: commandList,
    title: "Vite + React",
    toolStatus: [tool("node", true), tool("pnpm", true)],
    commandStatus: commandList,
    summary: "Detected Vite + React. Found: Node.js, pnpm. Dev: pnpm run dev.",
    ...overrides,
  };
}

export function workspaceStatus(projects: ProjectStatus[] = [projectStatus()]): WorkspaceStatus {
  return {
    os: "windows",
    projects,
    tools: [
      tool("node", true),
      tool("cargo", false, "Install Rust (rustup) — OpenMind doesn't install it."),
    ],
  };
}

export function formatOption(overrides: Partial<FormatOption> = {}): FormatOption {
  return {
    tool: "prettier",
    name: "Prettier",
    kind: "format",
    found: { path: "C:/My Project/node_modules/.bin/prettier.cmd", source: "project" },
    hint: "Add it to the project (`npm i -D prettier`).",
    argv: ["C:/My Project/node_modules/.bin/prettier.cmd", "--write", "C:/My Project/src/a.ts"],
    stdinArgv: [],
    wholeProject: false,
    ...overrides,
  };
}

export function fileStatus(overrides: Partial<FileLanguageStatus> = {}): FileLanguageStatus {
  return {
    path: "C:/My Project/src/a.ts",
    language: REGISTRY[0] ?? null,
    projectRoot: "",
    lsp: [],
    formatters: [formatOption()],
    linters: [],
    ...overrides,
  };
}

/** The language services over a fake backend. */
export function languageRig(
  options: { hasWorkspace?: boolean; workspace?: WorkspaceStatus | null } = {},
) {
  const hasWorkspace = { value: options.hasWorkspace ?? true };
  const events = new EventBus<AppEvents>();
  const ipc = createFakeIpc({
    languageRegistry: vi.fn().mockResolvedValue(REGISTRY),
    languageWorkspaceStatus: vi.fn().mockResolvedValue(options.workspace ?? workspaceStatus()),
    languageFileStatus: vi.fn().mockResolvedValue(fileStatus()),
  });
  const support = new LanguageSupportService(ipc, events, () => hasWorkspace.value);
  support.useCanonical(ipcWorkspaceFeed(() => ipc.languageWorkspaceStatus()));
  const terminal = {
    createTerminal: vi.fn().mockResolvedValue("t1"),
    write: vi.fn(),
    setActive: vi.fn(),
    getState: vi.fn().mockReturnValue({
      sessions: [
        {
          id: "t1",
          shell: "powerShell",
          title: "PowerShell",
          cwd: "",
          exited: false,
          exitCode: null,
        },
      ],
      activeId: "t1",
      shells: [],
      lastShell: null,
    }),
  };
  const showTerminal = vi.fn().mockResolvedValue(undefined);
  const projects = new ProjectCommandService({
    ipc,
    events,
    terminal,
    showTerminal,
    workspaceRoot: () => (hasWorkspace.value ? "C:/My Project" : null),
  });
  const notices: string[] = [];
  events.on("appNotice", ({ message }) => {
    notices.push(message);
  });
  return { ipc, events, support, projects, terminal, showTerminal, notices, hasWorkspace };
}
