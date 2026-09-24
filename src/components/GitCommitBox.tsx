import { useState } from "react";

import { container } from "../services/container";

/** Asks for the author name and email when Git has none (saved in this repository's config only). */
function IdentityForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const ready = name.trim() !== "" && email.includes("@");
  return (
    <form
      className="git-identity"
      aria-label="Git identity"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void container.sourceControl.saveIdentity(name, email);
      }}
    >
      <p className="git-identity__hint">
        Git needs your name and email to commit. They are saved in this repository only.
      </p>
      <input
        className="git-input"
        aria-label="Git user name"
        placeholder="Your name"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <input
        className="git-input"
        aria-label="Git user email"
        placeholder="you@example.com"
        value={email}
        onChange={(event) => {
          setEmail(event.target.value);
        }}
      />
      <button
        type="submit"
        className="git-button"
        disabled={!ready}
        title={ready ? "Save name and email" : "Enter a name and an email address."}
      >
        Save Name and Email
      </button>
    </form>
  );
}

/** The commit message box and the Commit button (disabled with its reason). UI only. */
export function GitCommitBox() {
  const sc = container.sourceControl;
  const state = sc.getState();
  const commit = sc.commitState();
  return (
    <div className="git-commit">
      {sc.identityMissing() ? <IdentityForm /> : null}
      <textarea
        className="git-commit__message"
        aria-label="Commit message"
        placeholder="Message (Ctrl+Enter to commit)"
        rows={3}
        value={state.message}
        onChange={(event) => {
          sc.setMessage(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.ctrlKey && event.key === "Enter") {
            event.preventDefault();
            void sc.commit();
          }
        }}
      />
      <button
        type="button"
        className="git-button git-button--primary"
        disabled={!commit.enabled}
        title={commit.enabled ? "Commit the staged changes" : commit.reason}
        onClick={() => void sc.commit()}
      >
        Commit
      </button>
      {!commit.enabled && state.message.trim() !== "" ? (
        <p className="git-commit__reason" role="note">
          {commit.reason}
        </p>
      ) : null}
    </div>
  );
}
