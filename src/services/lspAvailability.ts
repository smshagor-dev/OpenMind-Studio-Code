import type { LspCapabilities, LspServerInfo, LspSyncOutcome } from "./ipc";
import { lspLanguageId } from "./lspLanguages";

/** The language features the editor can ask a server for. */
export type LspAction =
  | "hover"
  | "completion"
  | "signatureHelp"
  | "definition"
  | "declaration"
  | "typeDefinition"
  | "implementation"
  | "references"
  | "rename"
  | "formatting"
  | "documentSymbol";

const ACTION_LABEL: Record<LspAction, string> = {
  hover: "hover",
  completion: "completion",
  signatureHelp: "signature help",
  definition: "Go to Definition",
  declaration: "Go to Declaration",
  typeDefinition: "Go to Type Definition",
  implementation: "Go to Implementations",
  references: "Find References",
  rename: "Rename Symbol",
  formatting: "Format Document",
  documentSymbol: "document symbols",
};

/** The server capability behind each action. */
const CAPABILITY: Record<LspAction, keyof LspCapabilities> = {
  hover: "hover",
  completion: "completion",
  signatureHelp: "signatureHelp",
  definition: "definition",
  declaration: "declaration",
  typeDefinition: "typeDefinition",
  implementation: "implementation",
  references: "references",
  rename: "rename",
  formatting: "formatting",
  documentSymbol: "documentSymbol",
};

/** What is known about one file's language support. */
export interface FileLspStatus {
  path: string | null;
  /** The server for the file's language, if the backend lists one. */
  server: LspServerInfo | null;
  /** What the last sync of the file said (null before the first one). */
  outcome: LspSyncOutcome | null;
}

export interface Availability {
  enabled: boolean;
  /** Why not — always present when disabled. */
  reason?: string;
}

function preparingText(server: LspServerInfo): string {
  return server.bundled
    ? "The language server is being unpacked from the offline bundle."
    : "The language server is being installed.";
}

/** Why this file has no language features right now, or `null` when a server is running for it. */
export function fileProblem(file: FileLspStatus): string | null {
  if (file.path === null) return "Save the file to use language features.";
  if (lspLanguageId(file.path) === null) return "No language server supports this file type.";
  switch (file.outcome?.state) {
    case "unsupported":
      return "No language server supports this file type.";
    case "turnedOff":
      return "The language server is turned off in Settings (Assembly > Enable Language Server).";
    case "noWorkspace":
      return "Open a folder to use language servers.";
    case "outsideWorkspace":
      return "This file is outside the open folder.";
    case "otherWindowFolder":
      return "Language servers serve the main window's folder; this window's folder doesn't get them yet.";
    case "nodeMissing":
      return "Node.js runtime is not installed yet.";
    case "notInstalled":
      return "Language server is not installed yet.";
    case "failed":
      return file.outcome.message;
    default:
      break;
  }
  const server = file.server;
  if (server === null) return "Language server status is not known yet.";
  if (!server.installed && !server.bundled) return "Language server is not installed yet.";
  if (server.state === "installing") return preparingText(server);
  if (server.state === "error") return server.message ?? "The language server stopped.";
  if (server.state !== "running") return "The language server isn't running.";
  return null;
}

export function actionAvailability(action: LspAction, file: FileLspStatus): Availability {
  const problem = fileProblem(file);
  if (problem !== null) return { enabled: false, reason: problem };
  const capabilities = file.server?.capabilities;
  if (!capabilities?.[CAPABILITY[action]]) {
    return {
      enabled: false,
      reason: `${file.server?.name ?? "The language server"} doesn't support ${ACTION_LABEL[action]}.`,
    };
  }
  return { enabled: true };
}

/** Whether "Restart Language Server" applies to the file (a server exists for it and is installed). */
export function restartAvailability(file: FileLspStatus): Availability {
  if (file.path === null)
    return { enabled: false, reason: "Save the file to use language features." };
  if (lspLanguageId(file.path) === null) {
    return { enabled: false, reason: "No language server supports this file type." };
  }
  if (file.server === null) {
    return { enabled: false, reason: "Language server status is not known yet." };
  }
  if (!file.server.installed && !file.server.bundled) {
    return { enabled: false, reason: "Language server is not installed yet." };
  }
  if (file.server.state === "installing") {
    return { enabled: false, reason: preparingText(file.server) };
  }
  return { enabled: true };
}

/** A short line for the status bar: "TypeScript Language Server", "Language server is not installed yet.", ... */
export function statusBarText(file: FileLspStatus): { text: string; ok: boolean } | null {
  if (file.path === null || lspLanguageId(file.path) === null) return null;
  const problem = fileProblem(file);
  if (problem === null) return { text: file.server?.name ?? "Language server", ok: true };
  return { text: problem, ok: false };
}

/**
 * Why a language server can't be removed from Language Tools (`null` = it can): only one that was downloaded (npm or
 * pip) is removed; one unpacked from the offline bundle comes back on its own, so there is nothing to remove.
 */
export function removeBlocked(server: {
  name: string;
  installed: boolean;
  installSource: "bundle" | "download" | null;
  state: string;
}): string | null {
  if (!server.installed) return `${server.name} is not installed.`;
  if (server.state === "installing") return `${server.name} is installing. Wait for it to finish.`;
  if (server.installSource === "bundle") {
    return `${server.name} comes from OpenMind Studio's offline bundle; there is nothing to remove.`;
  }
  return null;
}
