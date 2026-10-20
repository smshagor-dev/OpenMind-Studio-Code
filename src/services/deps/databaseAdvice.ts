import type { DependencyIssue } from "./dependencyModel";
import type { DatabaseHost } from "./dependencyService";

type DatabaseIssue = Extract<DependencyIssue, { kind: "databaseConnection" }>;
export type DatabaseStatus = ReturnType<DatabaseHost["status"]>;
export type DatabaseAction = "start" | "copy" | "admin" | "panel";

/** MySQL's usual port: code that sets no port connects here. */
const USUAL_PORT = 3306;

/** What the database card says (an i18n key and its values) and which buttons it shows, most useful first. */
export interface DatabaseAdvice {
  title: { key: string; params: Record<string, string | number> };
  hint: { key: string; params: Record<string, string | number> };
  actions: DatabaseAction[];
}

/**
 * Pure: explains a failed database connection against OpenMind's own MySQL. The usual cause is the port — another
 * MySQL (a Windows service, XAMPP) holds 3306, so OpenMind's runs on 3307 and code without a port reaches the other one,
 * which answers "Unknown database" or "Access denied".
 */
export function databaseAdvice(issue: DatabaseIssue, db: DatabaseStatus): DatabaseAdvice {
  const title = { key: `deps.db.${issue.problem}`, params: { database: issue.database ?? "" } };
  const advise = (key: string, actions: DatabaseAction[], params: Record<string, string | number> = {}) => ({
    title,
    hint: { key: `deps.db.hint.${key}`, params: { database: issue.database ?? "", ...params } },
    actions,
  });
  if (db.state === "notInstalled") return advise("notInstalled", ["panel"]);
  if (db.state === "stopped") return advise("stopped", ["start", "panel"]);
  if (db.state === "busy" || db.port === null) return advise("busy", ["panel"]);
  const port = db.port;
  if (issue.port !== null && issue.port !== port) {
    return advise("wrongPort", ["copy", "panel"], { used: issue.port, port });
  }
  if (issue.port === null && port !== USUAL_PORT) {
    // The message doesn't say which server answered: code without a port reached the other one on 3306, code with
    // OpenMind's port reached OpenMind's. Both cases are named, the likelier first.
    switch (issue.problem) {
      case "refused":
        return advise("setPort", ["copy", "panel"], { port });
      case "unknownDatabase":
        return advise("otherServerOrNoDatabase", ["copy", "admin", "panel"], { port, usual: USUAL_PORT });
      case "accessDenied":
        return advise("otherServerOrPassword", ["copy", "panel"], { port, usual: USUAL_PORT });
    }
  }
  switch (issue.problem) {
    case "unknownDatabase":
      return advise("noDatabase", ["admin", "copy"], { port });
    case "accessDenied":
      return advise("credentials", ["copy", "panel"], { port });
    case "refused":
      return advise("running", ["copy", "panel"], { port });
  }
}
