import type { Problem } from "./markerService";

/** One compiler line read as a problem, with the file the compiler named (as it printed it). */
export interface BuildLineProblem {
  /** The file as printed: absolute, relative to the source's folder, or `null` when the line names none. */
  file: string | null;
  problem: Problem;
}

/** The problems of one build, grouped per file for the Problems panel. */
export interface BuildProblemFile {
  path: string;
  title: string;
  problems: Problem[];
}

const GCC = /^(.*?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/i;
const FPC = /^(.*?)\((\d+)(?:,(\d+))?\)\s+(Fatal|Error|Warning|Note|Hint):\s*(.*)$/i;
const FPC_SUMMARY = /^There were \d+ errors? compiling module, stopping$/;
/** PascalABC.NET's `pabcnetcclear`: `[line,col] file.pas: text` (it lists errors only). */
const PASCALABC = /^\[(\d+),(\d+)\]\s+(.+?\.(?:pas|pp|inc|pcu)):\s*(.*)$/i;
/** A linker error has no line: it is shown on the first line of the file that was built. */
const UNDEFINED = /undefined reference to [`'](.+?)'/;

function severityOf(kind: string): Problem["severity"] {
  const lower = kind.toLowerCase();
  if (lower.includes("warning")) return "warning";
  if (lower.includes("note") || lower.includes("hint")) return "info";
  return "error";
}

function at(severity: Problem["severity"], message: string, line: number, column: number): Problem {
  const lineNumber = Number.isFinite(line) && line > 0 ? line : 1;
  const columnNumber = Number.isFinite(column) && column > 0 ? column : 1;
  return {
    severity,
    message,
    source: "compiler",
    line: lineNumber,
    column: columnNumber,
    endLine: lineNumber,
    endColumn: columnNumber + 1,
  };
}

/**
 * A line of gcc/clang/gfortran (`file:line:col: error: text`, gfortran with `-fdiagnostics-plain-output`) or Free
 * Pascal (`file(line,col) Error: text`) or PascalABC.NET (`[line,col] file.pas: text`) output, or a linker's
 * "undefined reference".
 */
export function parseBuildLine(line: string): BuildLineProblem | null {
  const abc = PASCALABC.exec(line.trim());
  if (abc) {
    return {
      file: (abc[3] ?? "").trim() || null,
      problem: at("error", abc[4] ?? line, Number(abc[1]), Number(abc[2])),
    };
  }
  const match = GCC.exec(line) ?? FPC.exec(line);
  // Free Pascal's closing summary repeats the errors already listed.
  if (match && FPC_SUMMARY.test(match[5] ?? "")) return null;
  if (match) {
    const file = (match[1] ?? "").trim();
    return {
      file: file === "" ? null : file,
      problem: at(severityOf(match[4] ?? ""), match[5] ?? line, Number(match[2]), Number(match[3] ?? "1")),
    };
  }
  const undefinedSymbol = UNDEFINED.exec(line);
  if (undefinedSymbol) {
    return { file: null, problem: at("error", `undefined reference to \`${undefinedSymbol[1] ?? ""}' (linker)`, 1, 1) };
  }
  return null;
}

export function parseBuildProblem(line: string): Problem | null {
  return parseBuildLine(line)?.problem ?? null;
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function isAbsolute(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith("/") || path.startsWith("\\\\");
}

function titleOf(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

/**
 * Where a problem belongs: the file the compiler named (relative names are next to the built file, which is
 * where the compiler ran), else the built file itself.
 */
export function problemPath(builtFile: string, named: string | null): string {
  if (named === null) return builtFile;
  const separator = builtFile.includes("\\") ? "\\" : "/";
  const folder = builtFile.slice(0, Math.max(builtFile.lastIndexOf("/"), builtFile.lastIndexOf("\\")));
  const candidate = isAbsolute(named) ? named : `${folder}${separator}${named.replace(/[\\/]/g, separator)}`;
  return normalize(candidate) === normalize(builtFile) ? builtFile : candidate;
}

/** Adds one parsed line to a build's per-file groups; the same problem printed twice is kept once. */
export function addBuildProblem(files: BuildProblemFile[], builtFile: string, parsed: BuildLineProblem): BuildProblemFile[] {
  const path = problemPath(builtFile, parsed.file);
  const existing = files.find((file) => normalize(file.path) === normalize(path));
  const same = (p: Problem) =>
    p.line === parsed.problem.line && p.column === parsed.problem.column && p.message === parsed.problem.message;
  if (existing === undefined) return [...files, { path, title: titleOf(path), problems: [parsed.problem] }];
  if (existing.problems.some(same)) return files;
  return files.map((file) => (file === existing ? { ...file, problems: [...file.problems, parsed.problem] } : file));
}
