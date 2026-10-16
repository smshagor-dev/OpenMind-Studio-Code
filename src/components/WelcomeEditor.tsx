import appIcon from "../../src-tauri/icons/128x128.png";
import type { Recents } from "../appHooks";
import { container } from "../services/container";
import { CloseIcon } from "./icons";
import { StartPage, type WelcomeCard } from "./StartPage";
import { useWelcome } from "./useWelcome";
import { t } from "../i18n";

/** The Welcome page's tab (VS Code shows it italic, like a preview tab), closable with its ×. */
export function WelcomeTab() {
  return (
    <div className="tab-bar" role="tablist" aria-label={t("editor.openEditors")}>
      <div className="tab tab--active tab--preview tab--welcome" role="tab" aria-selected="true">
        <img className="tab__app-icon" src={appIcon} alt="" width={16} height={16} />
        <span className="tab__label">{t("welcome.title")}</span>
        <button
          type="button"
          className="tab__close"
          title={t("welcome.closeTitle")}
          aria-label={t("welcome.close")}
          onClick={() => {
            container.welcome.close();
          }}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="tab-bar__filler" />
    </div>
  );
}

function cards(): WelcomeCard[] {
  const card = (
    id: string,
    command: string,
    title: string,
    description: string,
    icon: WelcomeCard["icon"],
  ): WelcomeCard => ({
    id,
    title,
    description,
    icon,
    enabled: container.commands.isEnabled(command),
    onOpen: () => {
      container.run(command);
    },
  });
  return [
    card(
      "runtimes",
      "runtime.manage",
      t("welcome.card.runtimes"),
      t("welcome.card.runtimesText"),
      "runtime",
    ),
    card(
      "php",
      "php.openWindow",
      t("welcome.card.php"),
      t("welcome.card.phpText"),
      "server",
    ),
    card(
      "language",
      "lsp.manage",
      t("runtimes.tab.tools"),
      t("welcome.card.languageText"),
      "language",
    ),
    card(
      "keyboard",
      "preferences.openKeybindings",
      t("preferences.tab.keybindings"),
      t("welcome.card.keysText"),
      "keyboard",
    ),
    card(
      "settings",
      "preferences.openSettings",
      t("preferences.tab.settings"),
      t("welcome.card.settingsText"),
      "settings",
    ),
  ];
}

/** The Welcome tab's content. */
export function WelcomeContent({ recents }: { recents: Recents }) {
  const welcome = useWelcome();
  return (
    <StartPage
      recentFiles={recents.files}
      recentFolders={recents.folders}
      pinnedFolders={recents.pinnedFolders}
      cards={cards()}
      showOnStartup={welcome.showOnStartup}
      onNewFile={() => {
        container.run("file.new");
      }}
      onOpenFile={() => {
        container.run("file.open");
      }}
      onOpenFolder={() => {
        container.run("file.openFolder");
      }}
      onCloneRepository={() => {
        container.run("git.clone");
      }}
      onNewWindow={() => {
        container.run("workbench.newWindow");
      }}
      onOpenRecentFile={(path) => { container.welcome.close(); void container.workspace.openPath(path); }}
      onOpenRecentFolder={(path) => void container.workspace.openFolder(path)}
      onUnpinFolder={(path) => void container.workspace.unpinFolder(path)}
      onShowOnStartupChange={(show) => void container.welcome.setShowOnStartup(show)}
    />
  );
}

const WATERMARK: readonly { label: string; command: string }[] = [
  { label: "titlebar.showAllCommands", command: "workbench.commandPalette" },
  { label: "watermark.openFile", command: "file.open" },
  { label: "watermark.openFolder", command: "file.openFolder" },
  { label: "openEditors.newUntitled", command: "file.new" },
  { label: "watermark.toggleTerminal", command: "terminal.toggle" },
];

/** What an empty editor shows once the Welcome tab is closed: the logo and a few shortcuts. */
export function EditorWatermark() {
  return (
    <div className="editor-watermark">
      <img className="editor-watermark__logo" src={appIcon} alt="" />
      <dl className="editor-watermark__shortcuts">
        {WATERMARK.map((entry) => {
          const key = container.keybindings.labelFor(entry.command);
          return key === undefined ? null : (
            <div key={entry.command} className="editor-watermark__row">
              <dt>{t(entry.label)}</dt>
              <dd>
                {key.split(" ").map((chord) => (
                  <kbd key={chord}>{chord}</kbd>
                ))}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

