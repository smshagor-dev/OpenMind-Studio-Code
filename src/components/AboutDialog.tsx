import { useEffect, useState } from "react";

import appIcon from "../../src-tauri/icons/128x128.png";
import { container } from "../services/container";
import type { AboutInfo } from "../services/ipc";
import "../styles/about.css";
import { AUTHOR_IMAGE, initials } from "./aboutAuthor";

const TECHNOLOGIES = [
  "Rust",
  "Tauri 2",
  "React 19",
  "TypeScript",
  "Monaco Editor",
  "xterm.js",
  "SQLite",
];

const AUTHOR_NAME = "Md Shahanur Islam Shagor";

/** The author's picture, or their initials when no picture is bundled or it can't be shown. */
export function AuthorAvatar({ src, name }: { src: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (src === null || failed) {
    return (
      <div className="about__avatar about__avatar--initials" role="img" aria-label={name}>
        {initials(name)}
      </div>
    );
  }
  return (
    <img
      className="about__avatar"
      src={src}
      alt={name}
      onError={() => {
        setFailed(true);
      }}
    />
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="about__row">
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

/** Help > About and the top-level About entry: the product, its build, the author and useful actions. */
export function AboutDialog({
  onClose,
  authorImage = AUTHOR_IMAGE,
}: {
  onClose: () => void;
  authorImage?: string | null;
}) {
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    container.ipc.aboutInfo().then(
      (loaded) => {
        if (!cancelled) setInfo(loaded);
      },
      (error: unknown) => {
        container.events.emit("appError", {
          message: `Could not read the About information: ${String(error)}`,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const copy = () => {
    if (info === null) return;
    container.ipc.clipboardWriteText(info.systemInfo).then(
      () => {
        setCopied(true);
      },
      (error: unknown) => {
        container.events.emit("appError", { message: `Could not copy: ${String(error)}` });
      },
    );
  };

  const name = info?.author.name ?? AUTHOR_NAME;
  return (
    <div
      className="modal-overlay about-overlay"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        className="modal modal--about about"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="about__cols">
          <section className="about__app" aria-label="Application">
            <img className="about__logo" src={appIcon} alt="" width={72} height={72} />
            <h2 id="about-title">OpenMind Studio</h2>
            <div className="about__chips">
              <span className="about__chip">{info ? `v${info.version}` : "…"}</span>
              {info ? <span className="about__chip about__chip--muted">{info.commit}</span> : null}
            </div>
            <p className="about__desc">
              {info?.description ??
                "A portable, native code editor with a built-in terminal, Git, language servers and a debugger."}
            </p>
            <h3>Built with</h3>
            <ul className="about__tech" aria-label="Technologies">
              {TECHNOLOGIES.map((tech) => (
                <li key={tech}>{tech}</li>
              ))}
            </ul>
          </section>
          <section className="about__author" aria-label="Author">
            <AuthorAvatar src={authorImage} name={name} />
            <h3>Author</h3>
            <p className="about__author-name">{name}</p>
            <p className="about__author-role">
              {info?.author.role ?? "Founder & Developer, OpenMind Studio"}
            </p>
            <p className="about__author-line">
              {info?.author.line ?? "Independent Researcher and Software Engineer"}
            </p>
            {info ? (
              <button
                type="button"
                className="about__link"
                title={info.author.github}
                onClick={() => {
                  container.ipc.openExternalUrl(info.author.github).catch((error: unknown) => {
                    container.events.emit("appError", {
                      message: `Could not open the link: ${String(error)}`,
                    });
                  });
                }}
              >
                GitHub · smshagor-dev
              </button>
            ) : null}
          </section>
        </div>
        <section className="about__system" aria-label="System">
          <h3>System</h3>
          <dl className="about__rows">
            <Row label="Version" value={info?.version ?? "…"} />
            <Row label="Build" value={info?.commit ?? "…"} />
            <Row label="Platform" value={info ? `${info.os} (${info.arch})` : "…"} />
            <Row label="WebView" value={info?.webview ?? "…"} />
            <Row label="Tauri" value={info?.tauriVersion ?? "…"} />
            <Row label="Compiler" value={info?.rustc ?? "…"} />
            <Row label="License" value={info?.license ?? "…"} />
          </dl>
        </section>
        <div className="modal__actions about__actions">
          <button type="button" disabled={info === null} onClick={copy}>
            {copied ? "Copied" : "Copy System Info"}
          </button>
          <button
            type="button"
            onClick={() => {
              container.run("help.openLogsFolder");
            }}
          >
            Open Logs
          </button>
          <button type="button" className="modal__confirm--primary" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
