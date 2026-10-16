/** Product commands are handled locally; unknown slash input never becomes an accidental model prompt. */
export interface AgentCommand {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
}
const command = (
  name: string,
  description: string,
  usage = "",
  aliases: string[] = [],
): AgentCommand => ({ name, description, usage, aliases });
export const AGENT_COMMANDS: readonly AgentCommand[] = [
  command("help", "Show commands and examples", "[command]"),
  command("model", "Choose a downloaded model", "[model-id]", ["models"]),
  command(
    "effort",
    "Set execution depth and output budget",
    "[low|medium|high]",
    ["effect"],
  ),
  command(
    "permissions",
    "Choose the agent approval policy",
    "[ask|acceptEdits|auto|plan]",
    ["permission"],
  ),
  command("config", "View or update agent settings", "[key value]", [
    "settings",
  ]),
  command("new", "Start a fresh saved conversation"),
  command("clear", "Start fresh while keeping saved chat history"),
  command(
    "resume",
    "Open saved conversations or restore one",
    "[conversation-id]",
    ["history"],
  ),
  command("compact", "Compact the actual model conversation"),
  command("context", "Inspect model context and token estimates"),
  command("memory", "Read or edit project memory", "[set <text>|clear]"),
  command("diff", "Inspect staged, unstaged and untracked changes"),
  command("review", "Review current Git changes without editing", "[focus]"),
  command(
    "mcp",
    "Manage Streamable HTTP MCP servers",
    "[add <name> <url>|connect <name>|remove <name>|tools]",
  ),
  command(
    "plugins",
    "Manage installed OpenMind Studio extensions",
    "[list|install|enable <id>|disable <id>|open]",
    ["plugin", "pluging"],
  ),
  command(
    "tasks",
    "Inspect or control the task queue",
    "[pause|resume|cancel <id>]",
    ["task"],
  ),
  command("doctor", "Check the local engine, model and integrations"),
  command("export", "Save this conversation as Markdown"),
  command("fork", "Copy the current conversation into a separate saved chat"),
  command(
    "init",
    "Create OPENMIND.md project instructions without overwriting",
  ),
  command(
    "goal",
    "Set a persistent goal and continue towards it",
    "[<goal>|pause|resume|clear|complete]",
  ),
  command("stop", "Stop the current task and pause automatic work"),
  command("plan", "Switch to read-only planning"),
  command("pause", "Pause queued tasks"),
  command("continue", "Continue the last interrupted task"),
  command("undo", "Undo the last agent file changes"),
];
export function parseAgentCommand(
  text: string,
): { command: AgentCommand | null; name: string; argument: string } | null {
  const match = /^\/([^\s]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const name = (match[1] ?? "").toLowerCase();
  return {
    command:
      AGENT_COMMANDS.find((c) => c.name === name || c.aliases.includes(name)) ??
      null,
    name,
    argument: (match[2] ?? "").trim(),
  };
}
export function matchingCommands(text: string): AgentCommand[] {
  const prefix = text.replace(/^\//, "").toLowerCase();
  return AGENT_COMMANDS.filter(
    (c) =>
      c.name.startsWith(prefix) || c.aliases.some((a) => a.startsWith(prefix)),
  );
}
export function commandHelp(name = ""): string {
  const selected = name
    ? AGENT_COMMANDS.filter((c) => c.name === name || c.aliases.includes(name))
    : AGENT_COMMANDS;
  if (!selected.length) throw new Error(`Unknown command: /${name}`);
  return selected
    .map(
      (c) =>
        `/${c.name}${c.usage ? ` ${c.usage}` : ""}\n${c.description}${c.aliases.length ? `\nAliases: ${c.aliases.map((a) => `/${a}`).join(", ")}` : ""}`,
    )
    .join("\n\n");
}
export interface AgentGoal {
  text: string;
  state: "active" | "paused" | "completed";
  attempts: number;
}
export function savedGoal(value: unknown): AgentGoal | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<AgentGoal>;
  if (
    typeof v.text !== "string" ||
    !v.text.trim() ||
    v.text.length > 8000 ||
    !["active", "paused", "completed"].includes(v.state ?? "")
  )
    return null;
  return {
    text: v.text,
    state: v.state === "completed" ? "completed" : "paused",
    attempts:
      typeof v.attempts === "number" && Number.isFinite(v.attempts)
        ? Math.max(0, Math.min(8, Math.floor(v.attempts)))
        : 0,
  };
}
export function transcriptMarkdown(
  entries: import("./agentModel").Entry[],
): string {
  return (
    "# OpenMindAI Agent conversation\n\n" +
    entries
      .map((e) => {
        if (e.kind === "user") return `## You\n\n${e.text}`;
        if (e.kind === "assistant")
          return `## OpenMindAI\n\n${e.text}${e.reasoning ? `\n\n### Reasoning\n\n${e.reasoning}` : ""}`;
        if (e.kind === "tool")
          return `### Tool: ${e.name}\n\nStatus: ${e.status}\n${e.target}\n\n${e.summary}\n\n${e.preview}`;
        if (e.kind === "asset")
          return `Attachment: ${e.name} (binary data omitted)`;
        if (e.kind === "document")
          return `### Attachment: ${e.name}\n\n${e.text}`;
        return e.text;
      })
      .join("\n\n---\n\n") +
    "\n"
  );
}
