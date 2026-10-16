import type { AgentService } from "./agentService";
import { commandHelp, parseAgentCommand } from "./agentCommands";
import { agentOptions, DEFAULT_AGENT_OPTIONS } from "./agentOptions";
import type { AgentMode } from "./agentIpc";

export async function executeAgentCommand(
  agent: AgentService,
  input: string,
): Promise<boolean> {
  const parsed = parseAgentCommand(input);
  if (!parsed) return false;
  const { command, argument, name } = parsed;
  if (!command) {
    agent.commandReport(
      "Unknown command",
      `/${name}\nType /help for supported commands.`,
    );
    return false;
  }
  try {
    if (
      [
        "model",
        "permissions",
        "config",
        "resume",
        "new",
        "clear",
        "review",
        "goal",
        "stop",
      ].includes(command.name)
    )
      agent.closeCommandPanel();
    switch (command.name) {
      case "help":
        agent.commandReport("Command help", commandHelp(argument));
        break;
      case "model":
        if (argument) {
          const model = agent
            .getState()
            .overview?.models.find((m) => m.id === argument);
          if (!model || model.local.state !== "ready")
            throw new Error("Choose an installed model from /model.");
          if (
            agent.getState().transcript.busy ||
            agent
              .getState()
              .taskState?.tasks.some(
                (t) => t.status === "pending" || t.status === "running",
              )
          )
            throw new Error("Stop the current task before changing the model.");
          await agent.selectModel(argument);
        } else agent.openSetup(true);
        break;
      case "effort": {
        if (!argument) {
          agent.commandReport(
            "Execution effort",
            `Current: ${agent.options().effort}\n/effort low | medium | high\nControls instruction depth, output budget and step limit; native model reasoning support may vary.`,
          );
          break;
        }
        if (!["low", "medium", "high"].includes(argument))
          throw new Error("Usage: /effort low|medium|high");
        const level = argument as "low" | "medium" | "high";
        await agent.updateOptions({
          effort: level,
          maxOutputTokens: { low: 2048, medium: 8192, high: 16384 }[level],
          maxSteps: { low: 32, medium: 128, high: 256 }[level],
        });
        agent.commandReport(
          "Execution effort",
          `Saved: ${level}. Applies to the next queued task.`,
        );
        break;
      }
      case "permissions":
        if (!argument) {
          agent.openSettings(true);
          break;
        }
        if (!["ask", "acceptEdits", "auto", "plan"].includes(argument))
          throw new Error("Usage: /permissions ask|acceptEdits|auto|plan");
        await agent.setMode(argument as AgentMode);
        agent.commandReport(
          "Permissions",
          `Policy: ${argument}. Applies to newly queued tasks.`,
        );
        break;
      case "config": {
        if (!argument) {
          agent.openSettings(true);
          break;
        }
        const [key, ...parts] = argument.split(/\s+/);
        const raw = parts.join(" ");
        if (
          !key ||
          !(key in DEFAULT_AGENT_OPTIONS) ||
          ["__proto__", "constructor", "prototype"].includes(key)
        )
          throw new Error(
            "Unknown setting. Open /config to see available options.",
          );
        if (!raw) {
          agent.commandReport(
            key,
            String(agent.options()[key as keyof typeof DEFAULT_AGENT_OPTIONS]),
          );
          break;
        }
        const original =
          DEFAULT_AGENT_OPTIONS[key as keyof typeof DEFAULT_AGENT_OPTIONS];
        const value =
          typeof original === "boolean"
            ? raw === "true"
              ? true
              : raw === "false"
                ? false
                : undefined
            : typeof original === "number"
              ? Number(raw)
              : raw;
        if (
          value === undefined ||
          (typeof value === "number" && !Number.isFinite(value))
        )
          throw new Error("Invalid setting value.");
        const next = agentOptions({ ...agent.options(), [key]: value });
        if (next[key as keyof typeof next] !== value)
          throw new Error("Value is outside this setting's supported range.");
        await agent.updateOptions(next);
        agent.commandReport("Configuration", `Saved ${key}: ${String(value)}`);
        break;
      }
      case "new":
      case "clear":
        return await agent.newChat();
      case "resume":
        if (argument) return await agent.restoreHistory(argument);
        await agent.showHistory(true);
        break;
      case "context":
      case "compact":
        return await agent.contextCommand(command.name);
      case "memory":
        return await agent.memoryCommand(argument);
      case "diff":
      case "review":
        return await agent.diffCommand(command.name === "review", argument);
      case "mcp":
        return await agent.mcpCommand(argument);
      case "plugins":
        return await agent.pluginsCommand(argument);
      case "tasks":
        return await agent.tasksCommand(argument);
      case "doctor":
        return await agent.doctorCommand();
      case "export":
        return await agent.exportCommand();
      case "fork":
        return await agent.forkCommand();
      case "init":
        return await agent.initCommand();
      case "goal":
        return await agent.goalCommand(argument);
      case "stop":
        await agent.stop();
        break;
      case "plan":
        await agent.setMode("plan");
        break;
      case "pause":
        agent.pauseQueue();
        break;
      case "continue":
        return await agent.continueTask();
      case "undo":
        await agent.undo();
        break;
    }
    return true;
  } catch (error) {
    agent.commandReport(`/${command.name}`, String(error), "error");
    return false;
  }
}
