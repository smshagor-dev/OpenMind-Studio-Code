import { useEffect, useState, useSyncExternalStore } from "react";

import { container } from "../../services/container";
import type { ProfileSummary } from "../../services/profiles/profilesIpc";
import "../../styles/profiles.css";

function Row({ profile, busy }: { profile: ProfileSummary; busy: boolean }) {
  const service = container.profiles;
  const [editing, setEditing] = useState<string | null>(null);
  const blocker = service.deleteBlocker(profile);
  return (
    <li className="profile__row">
      <div className="profile__what">
        {editing === null ? (
          <span className="profile__name">
            {profile.name}
            {profile.active ? <span className="profile__chip">Active</span> : null}
          </span>
        ) : (
          <input
            className="profile__input"
            aria-label={`New name for ${profile.name}`}
            value={editing}
            autoFocus
            onChange={(event) => {
              setEditing(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void service.rename(profile.id, editing).then((done) => {
                  if (done) setEditing(null);
                });
              } else if (event.key === "Escape") {
                event.stopPropagation();
                setEditing(null);
              }
            }}
          />
        )}
        <span className="profile__meta">
          {profile.settingCount === 0
            ? "every covered setting at its default"
            : `${String(profile.settingCount)} setting${profile.settingCount === 1 ? "" : "s"}`}
        </span>
      </div>
      <div className="profile__actions">
        <button
          type="button"
          disabled={busy || profile.active}
          title={profile.active ? "This profile is already in use." : undefined}
          onClick={() => {
            void service.switchTo(profile.id);
          }}
        >
          Switch
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setEditing(profile.name);
          }}
        >
          Rename
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void service.duplicate(profile.id, `${profile.name} copy`);
          }}
        >
          Duplicate
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void service.exportProfile(profile.id);
          }}
        >
          Export
        </button>
        <button
          type="button"
          disabled={busy || blocker !== undefined}
          title={blocker}
          onClick={() => {
            void service.remove(profile.id);
          }}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

/** Profiles: switch, create, rename, duplicate, delete (not Default), export and import. */
export function ProfilesDialog() {
  const { list, busy, open } = useSyncExternalStore(
    container.profiles.subscribe,
    container.profiles.getState,
  );
  const [name, setName] = useState("");
  const [fromCurrent, setFromCurrent] = useState(true);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") container.profiles.closeWindow();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!open) return null;
  const create = () => {
    void container.profiles.create(name, fromCurrent).then((done) => {
      if (done) setName("");
    });
  };
  return (
    <div
      className="modal-overlay"
      onClick={() => {
        container.profiles.closeWindow();
      }}
    >
      <div
        className="modal modal--profiles"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profiles-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id="profiles-title">Profiles</h2>
        <p className="profile__lead">
          A profile is a set of settings you can switch between. It covers appearance (theme, icon
          theme), the editor (font, tabs, minimap ...), formatting and Auto Save, search indexing,
          the AI switch and marketplace auto-load. Keyboard shortcuts, extensions and runtimes are
          shared by all profiles. Profiles stay on this computer.
        </p>
        {list === null ? (
          <p className="profile__meta">Loading...</p>
        ) : (
          <ul className="profile__list" aria-label="Profiles">
            {list.profiles.map((profile) => (
              <Row key={profile.id} profile={profile} busy={busy} />
            ))}
          </ul>
        )}
        {list !== null && list.problems.length > 0 ? (
          <p className="profile__problem" role="alert">
            Skipped damaged profile files (they were left untouched): {list.problems.join("; ")}
          </p>
        ) : null}
        <div className="profile__create">
          <input
            className="profile__input"
            aria-label="New profile name"
            placeholder="New profile name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && name.trim() !== "") create();
            }}
          />
          <label className="profile__check">
            <input
              type="checkbox"
              checked={fromCurrent}
              onChange={(event) => {
                setFromCurrent(event.target.checked);
              }}
            />
            Start from my current settings
          </label>
          <button type="button" disabled={busy || name.trim() === ""} onClick={create}>
            Create
          </button>
        </div>
        <div className="modal__actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void container.profiles.importProfile();
            }}
          >
            Import Profile...
          </button>
          <button
            type="button"
            className="modal__confirm--primary"
            onClick={() => {
              container.profiles.closeWindow();
            }}
            autoFocus
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
