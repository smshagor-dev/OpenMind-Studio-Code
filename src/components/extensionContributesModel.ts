import type { InstalledExtension } from "../services/extensionsIpc";

/** What an extension contributes, by name: commands, views, themes, icon themes, task types (Milestone 18). */
export function contributedLists(
  extension: InstalledExtension,
): { label: string; items: string[] }[] {
  const c = extension.manifest.contributes;
  return [
    { label: "Commands", items: c.commands.map((cmd) => `${cmd.title} (${cmd.command})`) },
    {
      label: "Views",
      items: c.views.containers.flatMap((container) =>
        container.views.map(
          (view) =>
            `${view.name} — ${view.kind === "webview" ? "webview" : "tree"} (${container.title})`,
        ),
      ),
    },
    { label: "Color themes", items: c.themes.map((theme) => theme.label) },
    { label: "File icon themes", items: c.iconThemes.map((theme) => theme.label || theme.id) },
    { label: "Task types", items: c.taskDefinitions.map((task) => task.type) },
  ];
}
