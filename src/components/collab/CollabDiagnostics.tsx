import { useEffect, useState } from "react";

import { t } from "../../i18n";
import { container } from "../../services/container";
import type { IcePath, NetDiagnostics } from "../../services/collab/collabNetIpc";
import type { VoicePath } from "../../services/collab/voice/voicePath";
import { failureMessage, firewallMessage } from "../../services/collab/lanStatus";

const FIREWALL_KEYS = {
  allowed: "collab.diag.firewall.allowed",
  blocked: "collab.diag.firewall.blocked",
  noRule: "collab.diag.firewall.noRule",
  unknown: "collab.diag.firewall.unknown",
} as const;

function turnText(turn: NetDiagnostics["turn"]): string {
  if (turn.status === "notConfigured") return t("collab.diag.turn.notConfigured");
  if (turn.status === "noLogin") return t("collab.diag.turn.noLogin");
  const protocols = turn.protocols.map((p) => t(`collab.diag.turn.protocol.${p}`)).join(", ");
  const text = t("collab.diag.turn.configured", { protocols });
  return turn.relayOnly ? `${text} · ${t("collab.diag.turn.relayOnly")}` : text;
}

function pathRows(diag: NetDiagnostics, voice: VoicePath[]): [string, string][] {
  const name = (path: IcePath) => t(`collab.diag.path.${path}`);
  const rows: [string, string][] = Object.values(diag.paths).map((path) => [
    t("collab.diag.path"),
    name(path),
  ]);
  for (const paths of Object.values(diag.hostPaths)) {
    if (paths.length === 0) continue;
    const counts = new Map<IcePath, number>();
    for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
    const summary = [...counts].map(([path, n]) => `${name(path)} × ${String(n)}`).join(", ");
    rows.push([t("collab.diag.memberPaths"), summary]);
  }
  if (voice.length > 0) {
    rows.push([
      t("collab.diag.voicePath"),
      voice.map((path) => t(`collab.diag.voicePath.${path}`)).join(", "),
    ]);
  }
  return rows;
}

/** Why collaboration does or doesn't work on this computer (no Room Code, key, identity, TURN host or login). */
export function CollabDiagnostics({ onClose }: { onClose: () => void }) {
  const [diag, setDiag] = useState<NetDiagnostics | null>(null);
  const [voice, setVoice] = useState<VoicePath[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    container.collab.manage
      .diagnostics()
      .then(setDiag)
      .catch(() => {
        setFailed(true);
      });
    container.collab.voice
      .paths()
      .then(setVoice)
      .catch(() => undefined);
  }, []);
  const rows: [string, string][] = diag
    ? [
        [t("collab.diag.lan"), diag.lanEnabled ? t("collab.diag.on") : t("collab.diag.off")],
        [
          t("collab.diag.internet"),
          diag.signalingConfigured ? t("collab.diag.on") : t("collab.diag.off"),
        ],
        [t("collab.diag.turn"), turnText(diag.turn)],
        [
          t("collab.diag.interface"),
          diag.interfaces[0]?.addresses.join(", ") ?? t("collab.diag.none"),
        ],
        ...Object.values(diag.hosting).map((h): [string, string] => [
          t("collab.diag.rendezvous"),
          h.listening
            ? String(h.rendezvousPort)
            : t("collab.diag.rendezvousStopped", { port: String(h.rendezvousPort) }),
        ]),
        [
          t("collab.diag.firewall"),
          diag.firewall
            ? t(FIREWALL_KEYS[diag.firewall.verdict])
            : t("collab.diag.firewall.notHosting"),
        ],
        [
          t("collab.diag.lastJoin"),
          diag.lastJoin?.failure
            ? t(`collab.diag.failure.${diag.lastJoin.failure}`)
            : diag.lastJoin?.route
              ? t("collab.diag.joined")
              : t("collab.diag.none"),
        ],
        ...pathRows(diag, voice),
      ]
    : [];
  const firewall = diag?.firewall ? firewallMessage(diag.firewall) : null;
  return (
    <div className="modal-overlay" role="presentation">
      <div
        className="modal collab-diag"
        role="dialog"
        aria-modal="true"
        aria-label={t("collab.diag.title")}
      >
        <h2>{t("collab.diag.title")}</h2>
        {failed ? <p>{t("collab.diag.unavailable")}</p> : null}
        <dl className="collab-diag__list">
          {rows.map(([label, value], i) => (
            <div key={`${label}-${String(i)}`} className="collab-diag__row">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {firewall ? <p className="collab-diag__hint">{firewall}</p> : null}
        {diag?.lastJoin?.failure ? (
          <p className="collab-diag__hint">{failureMessage(diag.lastJoin.failure)}</p>
        ) : null}
        <div className="modal__actions">
          <button type="button" className="modal__confirm--primary" onClick={onClose} autoFocus>
            {t("collab.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
