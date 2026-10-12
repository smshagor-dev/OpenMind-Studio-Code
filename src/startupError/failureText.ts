import { i18n, t } from "../i18n";
import type { StartupFailure } from "./startupErrorApi";

/** The page's text for one failure: from the UI language by the failure's stable `kind`, else the backend's English. */
export interface FailureText {
  category: string;
  title: string;
  explanation: string;
  nextSteps: string[];
}

const STEPS: Record<string, string[]> = {
  checksumMismatch: ["exitAndUse", "backUp"],
  unknownMigration: ["useNewer", "backUp"],
  partialMigration: ["backUp", "reportKept"],
  migrationFailed: ["exitAndUse", "backUp"],
  locked: ["closeOther"],
  inUseElsewhere: ["closeOtherComputer", "ownDataPerComputer"],
  corrupt: ["backUp", "restoreBackup"],
  readOnly: ["checkWritable"],
  cannotOpen: ["checkWritable"],
  createFolder: ["checkWritable"],
  diskFull: ["freeSpace"],
  other: ["report", "backUp"],
};

/** Kinds that share one text (the folder can't be read or written, for different reasons). */
const TEXT_OF: Record<string, string> = {
  cannotOpen: "readOnly",
  createFolder: "readOnly",
};

export function failureText(failure: StartupFailure): FailureText {
  const kind = failure.failure.kind;
  const steps = STEPS[kind];
  const textKind = TEXT_OF[kind] ?? kind;
  const base = `databaseError.kind.${textKind}`;
  if (!steps || i18n.english(`${base}.title`) === undefined) {
    return {
      category: failure.category,
      title: failure.title,
      explanation: failure.explanation,
      nextSteps: failure.nextSteps,
    };
  }
  const version = failure.failure.version ?? undefined;
  const explanationKey =
    kind === "migrationFailed" && version === undefined
      ? `${base}.explanationNoVersion`
      : `${base}.explanation`;
  return {
    category: t(`${base}.category`),
    title: t(`${base}.title`),
    explanation: t(explanationKey, version === undefined ? undefined : { version }),
    nextSteps: steps.map((step) => t(`databaseError.step.${step}`)),
  };
}
