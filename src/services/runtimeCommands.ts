import type { CommandRegistry } from "./commandRegistry";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";

/** `runtime.manage` (Terminal / Manage menus): opens the Runtime Manager dialog. */
export function registerRuntimeCommands(commands: CommandRegistry, events: EventBus<AppEvents>) {
  commands.register("runtime.manage", () => {
    events.emit("showRuntimeManager", undefined);
  });
}
