# OpenMindAI Agent commands

Type `/` in the agent composer or click its `/` button. Search by name or alias, use the arrow keys and Enter to run a command, and Escape to close suggestions. Commands with arguments can be typed directly. Report panels have a Command field for follow-up actions. Failed commands keep the composer draft. Help and setup commands work before a model is installed.

| Command                                        | Behavior and examples                                                                                                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/help [command]`                              | Show all commands, usage and aliases. `/help memory`                                                                                                                                                                           |
| `/model [model-id]`                            | Open model setup, or select an installed model while idle. Alias: `/models`.                                                                                                                                                   |
| `/effort [low\|medium\|high]`                  | Show or save execution effort. Alias: `/effect`.                                                                                                                                                                               |
| `/permissions [ask\|acceptEdits\|auto\|plan]`  | Open settings or save the policy for newly queued tasks. Alias: `/permission`.                                                                                                                                                 |
| `/config [key value]`                          | Open settings, read one setting or validate/save a value. `/config maxSteps 200`, `/config autoContinue false`. Alias: `/settings`.                                                                                            |
| `/new`                                         | Stop current work and start a fresh conversation, preserving saved history.                                                                                                                                                    |
| `/clear`                                       | Start fresh, preserving saved history. It does not erase project files or saved chats.                                                                                                                                         |
| `/resume [conversation-id]`                    | Open saved chat history or restore one conversation from the current workspace. Alias: `/history`.                                                                                                                             |
| `/compact`                                     | Compact the live native model context while idle. The visible transcript remains intact.                                                                                                                                       |
| `/context`                                     | Show the live context limit, output budget, message count, checkpoint size and conservative token estimate.                                                                                                                    |
| `/memory [set <text>\|clear]`                  | Open the project-memory editor or explicitly save/clear its contents after confirmation.                                                                                                                                       |
| `/diff`                                        | Display staged and working-tree file sides, including untracked files. Requires a Git repository.                                                                                                                              |
| `/review [focus]`                              | Queue a review of current Git changes in enforced read-only plan mode, preserving the default policy for future tasks.                                                                                                         |
| `/mcp [action]`                                | List servers and live tools; add, reconnect or remove a Streamable HTTP MCP server. See below.                                                                                                                                 |
| `/plugins [action]`                            | List installed extensions; `install` opens VSIX inspection/trust; `open` opens Extensions; `enable <id>` / `disable <id>` use the existing extension service. Aliases: `/plugin`, `/pluging`.                                  |
| `/tasks [pause\|resume\|cancel <id>]`          | Display the real task queue and model todos, pause/resume dispatch, or cancel a pending/running task. Alias: `/task`.                                                                                                          |
| `/doctor`                                      | Report workspace, engine installation/runtime state, selected model, hardware, effective configured budgets, instruction/memory files and live MCP tools. It does not claim remote endpoints are healthy without a connection. |
| `/export`                                      | Choose a destination and save a Markdown conversation, including text attachments and tool previews. Binary attachments are named but their payloads are omitted.                                                              |
| `/fork`                                        | Flush the original to history, reset native context and save a separate copy with a new conversation ID. Requires history storage and no running/pending work.                                                                 |
| `/init`                                        | Create and open `OPENMIND.md` at the workspace root. Existing contents are never overwritten.                                                                                                                                  |
| `/goal [text\|pause\|resume\|clear\|complete]` | Start or manage a persistent goal. See below.                                                                                                                                                                                  |
| `/stop`                                        | Cancel current work, pause the queue and pause any active goal.                                                                                                                                                                |

Additional shortcuts: `/plan`, `/pause`, `/continue` (last interrupted task) and `/undo` (available native file undo).

## Effort and permissions

Effort changes the instruction strategy and actual per-task budgets: low = 32 steps / 2,048 output tokens; medium = 128 / 8,192; high = 256 / 16,384. Native validation further limits output to the installed model's context. This is execution budgeting, not a promise that every local model implements a separate reasoning-token API. Other settings can be adjusted independently in `/config`.

Existing tasks retain their captured model, policy and options. Model switching requires an idle queue. Plan mode excludes mutating native and MCP tools; MCP tools use command approval even if a server claims they are read-only. Review preserves the configured policy for future user tasks.

## Project memory and context

Memory is UTF-8 in `OPENMIND_MEMORY.md` at the active workspace root, up to 32,000 bytes. The first 8,000 characters (within a bounded 32 KB read) are included on future turns as project context; permissions remain enforced by the host. Saving uses the same cross-window dirty-editor check and workspace path validation as agent edits. Save/discard editor changes first if that file is open with unsaved edits.

Startup and the Welcome page never create or open a default folder. If no folder is open when an agent operation needs one, it creates and uses `OpenMind Studio` inside the OS Documents directory (for example, `Documents/OpenMind Studio`). This automatic root lasts for the current window session and is not saved as the next startup workspace. Explicitly selected projects keep their normal restore behavior. `/init` creates project instructions in the agent workspace; memory and init do not require a downloaded model.

Compaction operates on the actual native conversation and preserves the latest request, system instructions and complete tool exchanges. Estimates are conservative, not tokenizer-exact. Export, fork and history preserve the full visible transcript; restoring/forking seeds a fresh native context, so previous compaction is not a destructive history edit. A restored/forked conversation has no native undo stack.

## MCP servers

```
/mcp add local http://127.0.0.1:3000/mcp
/mcp add tools https://tools.example.org/mcp
/mcp tools
/mcp connect local
/mcp remove local
```

This client supports MCP protocol `2025-03-26` over Streamable HTTP, including initialize/initialized, session headers, paginated tool discovery, JSON or SSE tool responses and cancellation notifications. It follows OpenMind's proxy configuration and disables redirects. HTTPS is required except on loopback. Endpoints cannot contain embedded credentials or query strings. Up to eight servers and 64 tools per server are supported; responses are bounded at 2 MB and HTTP requests time out after 45 seconds.

Server configuration persists in app settings. Saved servers reconnect once per conversation before inference, sequentially through the per-window native guard. A failed optional connection produces a notice and leaves ordinary chat available; use `/mcp connect <name>` to retry. An expired session is reported with reconnection instructions. Tool identities include the endpoint, remote name and input schema so remembered approvals cannot silently transfer to a changed tool.

Authentication/OAuth, stdio subprocess servers, legacy HTTP+SSE endpoints, resources, prompts, sampling, subscriptions and unsolicited server requests are outside this client's current scope. Use a compatible local server or an unauthenticated endpoint you explicitly trust. Stop requests remote cancellation; completed remote side effects cannot be undone by stopping the chat.

## Persistent goals

`/goal Implement feature X and run its tests` starts a task and adds the goal to its model request. The agent can continue for at most eight turns per start/resume. A final answer ending in `[OPENMIND_GOAL_COMPLETE]` marks completion. Failures, cancellation, user-queued work or the turn cap pause the goal; the goal strip exposes Pause, Resume and Clear. `/goal complete` records completion manually.

Goals retain the selected permission policy, so approval requests still require answers. They restore paused after app restart or history resume, and fork into the paused state. Stop invalidates any in-flight continuation before another task can be queued. A model's completion marker records its claim; inspect its validation evidence when assessing the result.

