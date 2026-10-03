import type { CommandRegistry } from "../commandRegistry";
import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { IpcClient } from "../ipc";
import type { SettingsService } from "../settingsService";
import { ProfileService } from "./profileService";

/** Profiles: named sets of settings, kept in settings/profiles next to the app, and their commands. */
export function wireProfiles(deps: {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  commands: CommandRegistry;
  settings: SettingsService;
}): ProfileService {
  const { commands, settings } = deps;
  const profiles = new ProfileService(deps.ipc, deps.events, () => settings.reload());
  commands.register("profiles.manage", () => profiles.openWindow());
  commands.register("profiles.export", async () => {
    await profiles.exportProfile();
  });
  commands.register("profiles.import", async () => {
    await profiles.importProfile();
  });
  return profiles;
}
