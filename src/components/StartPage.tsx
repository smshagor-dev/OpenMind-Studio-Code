import { useState, type ReactNode } from "react";

import type { PinnedFolderEntry, RecentFileInfo, WorkspaceInfo } from "../services/ipc";
import {
  GearIcon,
  KeyboardIcon,
  NewFileIcon,
  NewFolderIcon,
  NewWindowIcon,
  PinIcon,
  RuntimeIcon,
  ServerIcon,
  SourceControlIcon,
} from "./icons";

/** A card in the right-hand column: a real feature, opened by its command. */
export interface WelcomeCard {
  id: string;
  title: string;
  description: string;
  icon: "runtime" | "server" | "language" | "keyboard" | "settings";
  enabled: boolean;
  onOpen: () => void;
}

interface StartPageProps {
  recentFiles: RecentFileInfo[];
  recentFolders: WorkspaceInfo[];
  pinnedFolders: PinnedFolderEntry[];
  cards: WelcomeCard[];
  showOnStartup: boolean;
  onNewFile: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onCloneRepository: () => void;
  onNewWindow: () => void;
  onOpenRecentFile: (path: string) => void;
  onOpenRecentFolder: (path: string) => void;
  onUnpinFolder: (path: string) => void;
  onShowOnStartupChange: (show: boolean) => void;
}

/** VS Code lists five recent entries, then "More...". */
const RECENT_LIMIT = 5;

function parentDir(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

function baseName(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(index + 1) : path;
}

const CARD_ICONS = {
  runtime: <RuntimeIcon />,
  server: <ServerIcon />,
  language: <NewFileIcon />,
  keyboard: <KeyboardIcon />,
  settings: <GearIcon />,
} as const;

/** The Welcome tab's page, laid out like VS Code's: Start + Recent on the left, cards on the right. */
export function StartPage(props: StartPageProps) {
  const [allRecent, setAllRecent] = useState(false);
  const recent = [
    ...props.recentFolders.map((folder) => ({
      key: `folder:${folder.path}`,
      name: folder.name,
      path: folder.path,
      open: () => {
        props.onOpenRecentFolder(folder.path);
      },
    })),
    ...props.recentFiles.map((file) => ({
      key: `file:${file.path}`,
      name: baseName(file.path),
      path: file.path,
      open: () => {
        props.onOpenRecentFile(file.path);
      },
    })),
  ];
  const shown = allRecent ? recent : recent.slice(0, RECENT_LIMIT);
  return (
    <div className="welcome">
      <div className="welcome__inner">
        <header className="welcome__header">
          <h1 className="welcome__title">OpenMind Studio</h1>
          <p className="welcome__subtitle">Portable AI-ready development environment</p>
        </header>
        <div className="welcome__columns">
          <div className="welcome__column">
            <section className="welcome__section">
              <h2>Start</h2>
              <ul className="welcome__list">
                <StartLink icon={<NewFileIcon />} label="New File..." onClick={props.onNewFile} />
                <StartLink icon={<NewFileIcon />} label="Open File..." onClick={props.onOpenFile} />
                <StartLink
                  icon={<NewFolderIcon />}
                  label="Open Folder..."
                  onClick={props.onOpenFolder}
                />
                <StartLink
                  icon={<SourceControlIcon />}
                  label="Clone Git Repository..."
                  onClick={props.onCloneRepository}
                />
                <StartLink
                  icon={<NewWindowIcon />}
                  label="New Window"
                  onClick={props.onNewWindow}
                />
              </ul>
            </section>
            {props.pinnedFolders.length > 0 ? (
              <section className="welcome__section">
                <h2>Pinned</h2>
                <ul className="welcome__list">
                  {props.pinnedFolders.map((folder) => (
                    <li key={`pinned:${folder.path}`} className="welcome__recent">
                      <button
                        type="button"
                        className="welcome__link"
                        title={folder.path}
                        onClick={() => {
                          props.onOpenRecentFolder(folder.path);
                        }}
                      >
                        {folder.label ?? baseName(folder.path)}
                      </button>
                      <span className="welcome__recent-path">{parentDir(folder.path)}</span>
                      <button
                        type="button"
                        className="welcome__unpin"
                        title="Unpin Folder"
                        aria-label="Unpin Folder"
                        onClick={() => {
                          props.onUnpinFolder(folder.path);
                        }}
                      >
                        <PinIcon filled size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {recent.length > 0 ? (
              <section className="welcome__section">
                <h2>Recent</h2>
                <ul className="welcome__list">
                  {shown.map((entry) => (
                    <li key={entry.key} className="welcome__recent">
                      <button
                        type="button"
                        className="welcome__link"
                        title={entry.path}
                        onClick={entry.open}
                      >
                        {entry.name}
                      </button>
                      <span className="welcome__recent-path">{parentDir(entry.path)}</span>
                    </li>
                  ))}
                </ul>
                {recent.length > RECENT_LIMIT ? (
                  <button
                    type="button"
                    className="welcome__link welcome__more"
                    onClick={() => {
                      setAllRecent(!allRecent);
                    }}
                  >
                    {allRecent ? "Less..." : "More..."}
                  </button>
                ) : null}
              </section>
            ) : null}
          </div>
          <div className="welcome__column">
            <section className="welcome__section">
              <h2>Get Started</h2>
              <ul className="welcome__cards">
                {props.cards.map((card) => (
                  <li key={card.id}>
                    <button
                      type="button"
                      className="welcome__card"
                      disabled={!card.enabled}
                      onClick={card.onOpen}
                    >
                      <span className="welcome__card-icon">{CARD_ICONS[card.icon]}</span>
                      <span className="welcome__card-text">
                        <span className="welcome__card-title">{card.title}</span>
                        <span className="welcome__card-description">{card.description}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
        <label className="welcome__startup">
          <input
            type="checkbox"
            checked={props.showOnStartup}
            onChange={(event) => {
              props.onShowOnStartupChange(event.target.checked);
            }}
          />
          Show welcome page on startup
        </label>
      </div>
    </div>
  );
}

function StartLink(props: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <li>
      <button type="button" className="welcome__link" onClick={props.onClick}>
        {props.icon} {props.label}
      </button>
    </li>
  );
}
