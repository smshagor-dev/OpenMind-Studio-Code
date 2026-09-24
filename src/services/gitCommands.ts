import type { CommandRegistry } from "./commandRegistry";
import type { GitBlameService } from "./gitBlameService";
import type { GitCloneService } from "./gitCloneService";
import type { LayoutService } from "./layoutService";

/**
 * Git commands for the command registry (and any future palette or menu):
 * `git.clone` opens the Source Control view with the Clone form, `git.blame`
 * blames the active file. Each is disabled with the reason its button shows.
 */
export function registerGitCommands(
  commands: CommandRegistry,
  layout: LayoutService,
  clone: GitCloneService,
  blame: GitBlameService,
): void {
  commands.register(
    "git.clone",
    async () => {
      await layout.showView("scm");
      clone.openForm();
    },
    { enabled: () => clone.entryState().enabled },
  );
  commands.register(
    "git.blame",
    async () => {
      await blame.open();
    },
    { enabled: () => blame.state().enabled },
  );
}
