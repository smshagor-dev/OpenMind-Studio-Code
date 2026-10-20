/**
 * Pure helpers of the dependency helper: what a failed program's output says is missing, and whether a file reads
 * interactive input (Run Code's Output has no keyboard). The rules mirror `openmind_network::packages` (the backend
 * checks again before anything is installed).
 */

/** Something a program needs that isn't there. */
export type DependencyIssue =
  /** A third-party Python package: `package` is what pip installs (`guessed` when it is only the module's name). */
  | { kind: "pythonPackage"; module: string; package: string; guessed: boolean }
  /** Part of Python itself (tkinter, sqlite3, ssl ...): the Python build lacks it; pip can't install it. */
  | { kind: "pythonComponent"; module: string; tk: boolean }
  | { kind: "nodePackage"; module: string; package: string }
  /** A command isn't installed: `runtime` is the Runtime Manager item that provides it (`null`: installed outside OpenMind). */
  | { kind: "toolMissing"; tool: string; runtime: string | null; label: string }
  /** A C/C++ header: reported only — OpenMind never downloads libraries by itself. */
  | { kind: "headerMissing"; header: string }
  /**
   * A MySQL/MariaDB driver couldn't connect or log in. `port` is the port the program used when the error names it;
   * `database` the database it asked for. The card compares them with OpenMind's own MySQL (often on 3307, because
   * another MySQL — a Windows service, XAMPP — already holds 3306, and code that sets no port connects there).
   */
  | { kind: "databaseConnection"; problem: DatabaseProblem; database: string | null; port: number | null };

/** Why a database connection failed: no such database, user/password refused, or nothing answered on the port. */
export type DatabaseProblem = "unknownDatabase" | "accessDenied" | "refused";

/** Modules that ship with Python (the backend's `PYTHON_STDLIB` has the full list). */
const PYTHON_STDLIB = new Set([
  "tkinter", "_tkinter", "turtle", "turtledemo", "idlelib", "sqlite3", "_sqlite3", "ssl", "_ssl", "hashlib",
  "_hashlib", "ctypes", "_ctypes", "venv", "ensurepip", "lzma", "_lzma", "bz2", "_bz2", "zlib", "readline",
  "curses", "_curses", "dbm", "decimal", "_decimal", "uuid", "json", "os", "sys", "re", "math", "random",
  "datetime", "time", "pathlib", "subprocess", "threading", "asyncio", "socket", "http", "urllib", "email", "xml",
  "csv", "logging", "unittest", "collections", "itertools", "functools", "typing", "statistics", "string",
  "struct", "shutil", "glob", "tempfile", "pickle", "copy", "argparse", "zipfile", "tarfile", "gzip", "base64",
  "secrets", "html", "io", "enum", "dataclasses", "platform", "queue", "multiprocessing", "concurrent",
  "winreg", "winsound", "msvcrt", "tomllib", "zoneinfo", "calendar", "webbrowser", "smtplib", "wave",
]);

const TK_MODULES = new Set(["tkinter", "_tkinter", "turtle", "turtledemo", "idlelib"]);

/** Import names whose pip package is called something else. */
const IMPORT_TO_PACKAGE: Record<string, string> = {
  // `import mysql.connector`: the PyPI package "mysql" is an old shim that builds mysqlclient from source.
  mysql: "mysql-connector-python",
  mysqlx: "mysql-connector-python",
  MySQLdb: "mysqlclient",
  cv2: "opencv-python",
  PIL: "Pillow",
  sklearn: "scikit-learn",
  yaml: "PyYAML",
  bs4: "beautifulsoup4",
  dateutil: "python-dateutil",
  serial: "pyserial",
  Crypto: "pycryptodome",
  dotenv: "python-dotenv",
  jwt: "PyJWT",
  OpenSSL: "pyOpenSSL",
  win32api: "pywin32",
  win32con: "pywin32",
  attr: "attrs",
  magic: "python-magic",
  docx: "python-docx",
  pptx: "python-pptx",
  fitz: "PyMuPDF",
  telegram: "python-telegram-bot",
  git: "GitPython",
};

/** The packages pip certainly installs under the import's own name (no guess needed). */
const KNOWN_SAME_NAME = new Set([
  "requests", "pandas", "numpy", "flask", "django", "matplotlib", "scipy", "seaborn", "pytest", "sqlalchemy",
  "fastapi", "uvicorn", "pydantic", "httpx", "aiohttp", "rich", "click", "jinja2", "openpyxl", "xlrd", "lxml",
  "selenium", "pygame", "tqdm", "torch", "torchvision", "transformers", "tensorflow", "keras", "sympy",
  "networkx", "plotly", "streamlit", "psutil", "paramiko", "boto3", "redis", "pymongo", "psycopg2", "pymysql",
  "mariadb",
]);

const NODE_BUILTINS = new Set([
  "fs", "path", "os", "http", "https", "url", "util", "events", "stream", "crypto", "child_process", "net", "dns",
  "zlib", "buffer", "readline", "assert", "process", "querystring", "timers", "tty", "worker_threads", "cluster",
  "module", "vm", "perf_hooks", "string_decoder", "async_hooks", "inspector", "v8",
]);

/** Commands and the Runtime Manager item that provides them (`null`: installed outside OpenMind). */
const TOOLS: Record<string, { runtime: string | null; label: string }> = {
  javac: { runtime: "jdk", label: "Java JDK" },
  java: { runtime: "jdk", label: "Java JDK" },
  jar: { runtime: "jdk", label: "Java JDK" },
  gcc: { runtime: "llvm-mingw", label: "C/C++ toolchain (LLVM-MinGW)" },
  "g++": { runtime: "llvm-mingw", label: "C/C++ toolchain (LLVM-MinGW)" },
  clang: { runtime: "llvm-mingw", label: "C/C++ toolchain (LLVM-MinGW)" },
  "clang++": { runtime: "llvm-mingw", label: "C/C++ toolchain (LLVM-MinGW)" },
  cc: { runtime: "llvm-mingw", label: "C/C++ toolchain (LLVM-MinGW)" },
  "c++": { runtime: "llvm-mingw", label: "C/C++ toolchain (LLVM-MinGW)" },
  nasm: { runtime: "assembly", label: "Assembly toolchain (NASM)" },
  ndisasm: { runtime: "assembly", label: "Assembly toolchain (NASM)" },
  gdb: { runtime: "assembly", label: "Assembly toolchain (GDB)" },
  objdump: { runtime: "assembly", label: "Assembly toolchain (GNU binutils)" },
  cmake: { runtime: "cmake", label: "CMake" },
  ninja: { runtime: "ninja", label: "Ninja" },
  node: { runtime: "node", label: "Node.js" },
  npm: { runtime: "node", label: "Node.js" },
  npx: { runtime: "node", label: "Node.js" },
  python: { runtime: "python", label: "Python" },
  python3: { runtime: "python", label: "Python" },
  pip: { runtime: "python", label: "Python" },
  go: { runtime: "go", label: "Go" },
  dotnet: { runtime: "dotnet", label: ".NET SDK" },
  mvn: { runtime: "maven", label: "Maven" },
  gradle: { runtime: "gradle", label: "Gradle" },
  kotlinc: { runtime: "kotlin", label: "Kotlin compiler" },
  php: { runtime: "php", label: "PHP" },
  composer: { runtime: "composer", label: "Composer" },
  git: { runtime: "git", label: "Git" },
  flutter: { runtime: "flutter", label: "Flutter SDK" },
  dart: { runtime: "dart", label: "Dart SDK" },
  rustc: { runtime: null, label: "Rust (rustup)" },
  cargo: { runtime: null, label: "Rust (rustup)" },
  rustup: { runtime: null, label: "Rust (rustup)" },
};

function pythonIssue(module: string): DependencyIssue {
  const top = module.split(".")[0] ?? module;
  if (PYTHON_STDLIB.has(top)) return { kind: "pythonComponent", module: top, tk: TK_MODULES.has(top) };
  const mapped = IMPORT_TO_PACKAGE[top];
  if (mapped !== undefined) return { kind: "pythonPackage", module: top, package: mapped, guessed: false };
  return { kind: "pythonPackage", module: top, package: top, guessed: !KNOWN_SAME_NAME.has(top.toLowerCase()) };
}

/** The npm package of a module specifier (`lodash/fp` -> `lodash`, `@scope/pkg/x` -> `@scope/pkg`), or `null` for a
 * built-in or a local file. */
export function npmPackageOf(specifier: string): string | null {
  const spec = specifier.replace(/^node:/, "");
  if (specifier.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0] ?? spec)) return null;
  if (/^[./\\]/.test(spec) || /^[A-Za-z]:[\\/]/.test(spec)) return null;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name) ? name : null;
}

/** What a failed program's (or terminal's) output says is missing, or `null`. */
export function diagnoseDependency(output: string): DependencyIssue | null {
  // Both quotes are required: a terminal that wraps "No module named 'reques" / "ts'" must not offer to install "reques".
  const py = /(?:ModuleNotFoundError: No module named|ImportError: No module named) (['"])([A-Za-z_][\w.]*)\1/.exec(output);
  if (py?.[2] !== undefined) return pythonIssue(py[2]);
  if (/_tkinter\.TclError: Can't find a usable (?:init|tk)\.tcl|Tcl\/Tk .*not (?:found|installed)/i.test(output)) {
    return { kind: "pythonComponent", module: "tkinter", tk: true };
  }
  const node = /(?:Cannot find module|Cannot find package) '([^']+)'/.exec(output);
  if (node?.[1] !== undefined) {
    const pkg = npmPackageOf(node[1]);
    if (pkg !== null) return { kind: "nodePackage", module: node[1], package: pkg };
  }
  const database = diagnoseDatabase(output);
  if (database !== null) return database;
  const header = /fatal error: ['"]?([\w./\\-]+\.(?:h|hpp|hh|hxx))['"]?(?::)? (?:No such file or directory|file not found)/.exec(output);
  if (header?.[1] !== undefined) return { kind: "headerMissing", header: header[1] };
  // PowerShell: "The term 'javac' is not recognized"; cmd: "'javac' is not recognized as an internal or external command";
  // bash: "javac: command not found".
  const tool =
    /The term '([\w+.-]+)' is not recognized/.exec(output) ??
    /'([\w+.-]+)' is not recognized as an internal or external command/.exec(output) ??
    /(?:^|\s)([\w+.-]+): command not found/.exec(output);
  const name = tool?.[1]?.toLowerCase().replace(/\.exe$/, "");
  if (name !== undefined) {
    const known = TOOLS[name];
    if (known !== undefined) return { kind: "toolMissing", tool: name, runtime: known.runtime, label: known.label };
  }
  return null;
}

/** The port in "server on 'localhost:3307'" or "ECONNREFUSED 127.0.0.1:3307", if the message names one. */
function portIn(text: string | undefined): number | null {
  const port = /:(\d{2,5})$/.exec(text ?? "")?.[1];
  return port === undefined ? null : Number(port);
}

/**
 * A MySQL/MariaDB connection failure in a program's output (the messages of PyMySQL, mysql-connector, mysqlclient,
 * mariadb, PHP mysqli/PDO, Node mysql/mysql2, JDBC and Connector/NET), or `null`. Only database-specific wording is
 * read: a plain "connection refused" could be any server.
 */
export function diagnoseDatabase(output: string): DependencyIssue | null {
  const issue = (problem: DatabaseProblem, database: string | null = null, port: number | null = null) =>
    ({ kind: "databaseConnection", problem, database, port }) as const;
  const unknown = /Unknown database '([^']{1,64})'/.exec(output);
  if (unknown?.[1] !== undefined) return issue("unknownDatabase", unknown[1]);
  // MariaDB on Windows offers its Windows-login method after a wrong password, so clients without it report that
  // method ("auth_gssapi_client") instead of "Access denied": both mean the user name or password was refused.
  if (/Access denied for user '[^']*'@'[^']*'|auth_gssapi_client/.test(output)) return issue("accessDenied");
  const server = /Can't connect to (?:MySQL |MariaDB )?server on '([^']+)'/.exec(output);
  if (server !== null) return issue("refused", null, portIn(server[1]));
  const node = /ECONNREFUSED (?:127\.0\.0\.1|::1|localhost):(33\d\d)(?!\d)/.exec(output);
  if (node?.[1] !== undefined) return issue("refused", null, Number(node[1]));
  if (
    /SQLSTATE\[HY000\] \[2002\]|mysqli_sql_exception: No connection could be made|Communications link failure|Unable to connect to any of the specified MySQL hosts/.test(
      output,
    )
  ) {
    return issue("refused");
  }
  return null;
}

/**
 * Whether a file reads the keyboard (Run Code's Output can't answer it). Conservative: only the usual calls of the
 * languages Run Code runs (Python, JavaScript/TypeScript, PHP, C/C++, Java, Rust, Fortran, Pascal). Comments aren't
 * parsed, so a commented-out `input(` counts.
 */
export function needsInteractiveInput(extension: string, text: string): boolean {
  // `extensionOf` gives ".py"; accept "py" too.
  switch (extension.toLowerCase().replace(/^\./, "")) {
    case "py":
    case "pyw":
      return /(?<![\w.])input\s*\(|sys\.stdin|getpass\s*\(/.test(text);
    case "js":
    case "mjs":
    case "cjs":
    case "ts":
    case "mts":
    case "cts":
      return /readline|process\.stdin|prompt-sync|inquirer|\bprompt\s*\(/.test(text);
    case "php":
      return /STDIN|readline\s*\(|php:\/\/stdin/.test(text);
    // Compiled languages: only calls that read standard input (`sscanf`, `new Scanner(file)`, a file's
    // `read_line` don't count).
    case "c":
      return C_STDIN.test(text);
    case "cpp":
    case "cc":
    case "cxx":
      return C_STDIN.test(text) || /\bcin\s*>>|\bstd::cin\b|getline\s*\(\s*(?:std::)?cin\b/.test(text);
    case "java":
      return /\bSystem\.in\b|\bSystem\.console\s*\(/.test(text);
    case "rs":
      return /\bstdin\s*\(\s*\)|\bio::stdin\b|\bstd::io::Stdin\b/.test(text);
    case "f":
    case "for":
    case "f90":
    case "f95":
    case "f03":
    case "f08":
      return FORTRAN_STDIN.test(text);
    case "pas":
    case "pp":
      return PASCAL_STDIN.test(text);
    case "asm":
    case "nasm":
    case "s":
      return ASM_STDIN.test(text) || (/\bGetStdHandle\b/.test(text) && /\bRead(?:Console[AW]?|File)\b/.test(text));
    default:
      return false;
  }
}

/**
 * Assembly reading the keyboard through the C runtime (`call scanf`, `call [getchar]`, `call _fgets` in 32-bit code);
 * the Windows API form (`GetStdHandle` + `ReadConsole`/`ReadFile`) is checked next to it.
 */
const ASM_STDIN = /\bcall\s+(?:qword\s+|dword\s+)?\[?\s*_?(?:scanf|getchar|gets|fgets|getline|_getch|getch)\b/i;

/** Fortran reading the keyboard: `read *, x`, `read (*, *) x`, `read (5, ...)`, `read (unit=input_unit, ...)`. */
const FORTRAN_STDIN = /\bread\s*(?:\*\s*,|\(\s*(?:unit\s*=\s*)?(?:\*|5|input_unit)\s*[,)])/i;

/** Pascal reading the keyboard: `readln`, `read(x)`, `readln(name)` — not `read(f, x)` from a file variable. */
const PASCAL_STDIN = /\b(?:readln\b|read\s*[(;])(?!\s*\(?\s*[a-z_]\w*\s*,)|\breadkey\b/i;

/** C's ways of reading the keyboard: `scanf`, `getchar`, `gets`, and `fgets`/`fscanf`/`getc`/`fgetc`/`getline` on `stdin`. */
const C_STDIN =
  /\bscanf\s*\(|\bgetchar\s*\(|\bgets\s*\(|\b(?:fgets|fscanf|getc|fgetc|getline)\s*\([^)]*\bstdin\b/;

/**
 * The error a program shows when it asked for input and got none (Run Code's Output has no keyboard): Python's
 * EOFError, Java's `Scanner` ("No line found") and gfortran's runtime error on unit 5 (`At line 6 of file x.f90
 * (unit = 5, file = 'stdin')`). C, C++, Rust and Pascal just read nothing, with no error to recognize.
 */
export function isMissingInputError(line: string): boolean {
  return /EOFError: EOF when reading a line|java\.util\.NoSuchElementException: No line found|\(unit = 5, file = 'stdin'\)/.test(
    line,
  );
}
