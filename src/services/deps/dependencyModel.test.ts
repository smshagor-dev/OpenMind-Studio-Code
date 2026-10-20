import { describe, expect, it } from "vitest";

import {
  diagnoseDatabase,
  diagnoseDependency,
  isMissingInputError,
  needsInteractiveInput,
  npmPackageOf,
} from "./dependencyModel";

describe("diagnoseDependency: Python", () => {
  it("a missing third-party package gets the pip name", () => {
    expect(diagnoseDependency("ModuleNotFoundError: No module named 'requests'")).toEqual({
      kind: "pythonPackage",
      module: "requests",
      package: "requests",
      guessed: false,
    });
    expect(diagnoseDependency("  File \"x.py\", line 1\nModuleNotFoundError: No module named 'pandas'")).toMatchObject({
      package: "pandas",
      guessed: false,
    });
    // Import names that differ from the package, and the old ImportError wording.
    expect(diagnoseDependency("ModuleNotFoundError: No module named 'cv2'")).toMatchObject({ package: "opencv-python", guessed: false });
    expect(diagnoseDependency("ModuleNotFoundError: No module named 'PIL'")).toMatchObject({ package: "Pillow" });
    expect(diagnoseDependency("ImportError: No module named 'yaml'")).toMatchObject({ package: "PyYAML" });
    // A name the terminal wrapped (no closing quote on the line) is never guessed from its first half; nor is Python 2's
    // unquoted form, which can't be told apart from a cut one.
    expect(diagnoseDependency("ModuleNotFoundError: No module named 'reques")).toBeNull();
    expect(diagnoseDependency("ImportError: No module named yaml")).toBeNull();
    // A sub-module is the top-level package; an unknown name is only a guess.
    expect(diagnoseDependency("ModuleNotFoundError: No module named 'sklearn.linear_model'")).toMatchObject({ package: "scikit-learn" });
    expect(diagnoseDependency("ModuleNotFoundError: No module named 'foobarlib'")).toMatchObject({ package: "foobarlib", guessed: true });
  });

  it("tkinter and other parts of Python are never pip packages", () => {
    for (const module of ["tkinter", "_tkinter", "turtle"]) {
      expect(diagnoseDependency(`ModuleNotFoundError: No module named '${module}'`)).toEqual({
        kind: "pythonComponent",
        module,
        tk: true,
      });
    }
    for (const module of ["sqlite3", "_sqlite3", "ssl", "ctypes", "venv"]) {
      expect(diagnoseDependency(`ModuleNotFoundError: No module named '${module}'`)).toEqual({
        kind: "pythonComponent",
        module,
        tk: false,
      });
    }
    // Tcl/Tk files missing from an installed tkinter.
    expect(diagnoseDependency("_tkinter.TclError: Can't find a usable init.tcl in the following directories")).toEqual({
      kind: "pythonComponent",
      module: "tkinter",
      tk: true,
    });
  });
});

describe("diagnoseDependency: Node, commands and headers", () => {
  it("a missing npm module gets its package; built-ins and local files don't", () => {
    expect(diagnoseDependency("Error: Cannot find module 'lodash'\nRequire stack:")).toEqual({
      kind: "nodePackage",
      module: "lodash",
      package: "lodash",
    });
    expect(diagnoseDependency("Error: Cannot find module 'lodash/fp'")).toMatchObject({ package: "lodash" });
    expect(diagnoseDependency("Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@scope/pkg' imported from x")).toMatchObject({
      package: "@scope/pkg",
    });
    expect(diagnoseDependency("Error: Cannot find module './helpers'")).toBeNull();
    expect(diagnoseDependency("Error: Cannot find module 'C:\\work\\app.js'")).toBeNull();
    expect(npmPackageOf("fs")).toBeNull();
    expect(npmPackageOf("node:path")).toBeNull();
    expect(npmPackageOf("Bad Name")).toBeNull();
  });

  it("a missing compiler or runtime points to its Runtime Manager item in every shell's wording", () => {
    const cases: [string, string, string | null][] = [
      ["javac : The term 'javac' is not recognized as the name of a cmdlet, function, script file", "javac", "jdk"],
      ["'gcc' is not recognized as an internal or external command,", "gcc", "llvm-mingw"],
      ["bash: g++: command not found", "g++", "llvm-mingw"],
      ["java : The term 'java' is not recognized", "java", "jdk"],
      ["'rustc' is not recognized as an internal or external command,", "rustc", null],
      ["npm : The term 'npm' is not recognized", "npm", "node"],
    ];
    for (const [text, tool, runtime] of cases) {
      expect(diagnoseDependency(text), text).toMatchObject({ kind: "toolMissing", tool, runtime });
    }
    // An unknown command isn't guessed at.
    expect(diagnoseDependency("'foo' is not recognized as an internal or external command,")).toBeNull();
  });

  it("a missing C/C++ header is reported, never fixed", () => {
    expect(diagnoseDependency("main.c:1:10: fatal error: curl/curl.h: No such file or directory")).toEqual({
      kind: "headerMissing",
      header: "curl/curl.h",
    });
    expect(diagnoseDependency("main.cpp:2:10: fatal error: 'boost/asio.hpp' file not found")).toMatchObject({
      header: "boost/asio.hpp",
    });
  });

  it("ordinary output is nothing", () => {
    for (const text of ["Hello", "Successfully installed six-1.17.0", "Status: Adult", "ERROR: No matching distribution found for x"]) {
      expect(diagnoseDependency(text), text).toBeNull();
    }
  });
});

describe("interactive input", () => {
  it("recognizes programs that read the keyboard in the languages Run Code runs", () => {
    expect(needsInteractiveInput("py", 'name = input("Enter your name: ")')).toBe(true);
    // What `extensionOf` returns (with the dot) works the same.
    expect(needsInteractiveInput(".py", 'age = int(input("Enter your age: "))')).toBe(true);
    expect(needsInteractiveInput("py", "import sys\ndata = sys.stdin.read()")).toBe(true);
    expect(needsInteractiveInput("py", "print('hi')\nuser_input = 3")).toBe(false);
    expect(needsInteractiveInput("py", "value = obj.input(3)")).toBe(false);
    expect(needsInteractiveInput("js", "const rl = readline.createInterface({ input: process.stdin })")).toBe(true);
    expect(needsInteractiveInput("ts", "console.log(1)")).toBe(false);
    expect(needsInteractiveInput("php", "$name = trim(fgets(STDIN));")).toBe(true);
    expect(isMissingInputError("EOFError: EOF when reading a line")).toBe(true);
    expect(isMissingInputError("Status: Adult")).toBe(false);
  });

  it("recognizes standard input in C, C++, Java and Rust, and nothing that only looks like it", () => {
    const reads: [string, string][] = [
      ["c", 'scanf("%99s", name);'],
      [".c", "int c = getchar();"],
      ["c", "fgets(line, sizeof line, stdin);"],
      ["c", "fscanf(stdin, \"%d\", &n);"],
      ["cpp", "std::cin >> age;"],
      ["cpp", "using namespace std;\ncin >> age;"],
      ["cpp", "std::getline(std::cin, name);"],
      ["cc", "getline(cin, country);"],
      ["cpp", 'scanf("%d", &n);'],
      ["java", "Scanner scanner = new Scanner(System.in);"],
      ["java", "new BufferedReader(new InputStreamReader(System.in))"],
      ["java", "String line = System.console().readLine();"],
      ["rs", "io::stdin().read_line(&mut line).expect(\"read\");"],
      ["rs", "let mut input = std::io::stdin().lock();"],
      ["rs", "use std::io::stdin;\nstdin().read_line(&mut s);"],
    ];
    for (const [extension, text] of reads) expect(needsInteractiveInput(extension, text), text).toBe(true);
    const notReads: [string, string][] = [
      ["c", 'sscanf(text, "%d", &n);'],
      ["c", 'fgets(line, sizeof line, file);\nprintf("stdin is closed");'],
      ["c", "int getchar_count = 0;"],
      ["cpp", 'std::cout << "cin >> is how you read" ;'.replace("cin >>", "c-in")],
      ["java", "Scanner scanner = new Scanner(new File(\"data.txt\"));"],
      ["java", 'System.out.println("Hello");'],
      ["rs", "let reader = BufReader::new(File::open(path)?);\nreader.read_line(&mut line)?;"],
      ["rs", 'println!("no input");'],
    ];
    for (const [extension, text] of notReads) expect(needsInteractiveInput(extension, text), text).toBe(false);
    expect(isMissingInputError('Exception in thread "main" java.util.NoSuchElementException: No line found')).toBe(true);
  });

  it("recognizes standard input in Fortran and Pascal, and not reads from files", () => {
    const reads: [string, string][] = [
      [".f90", "read (*, *) age"],
      ["f90", "read(*,'(a)') name"],
      ["f95", "read *, x"],
      ["f08", "READ (UNIT=INPUT_UNIT, FMT=*) N"],
      ["f", "      READ(5,*) N"],
      ["for", "      READ (5, 100) N"],
      [".pas", "readln(name);"],
      ["pas", "Write('Age: ');\nReadLn(age);"],
      ["pp", "repeat until KeyPressed; c := ReadKey;"],
      ["pas", "writeln('Press Enter'); readln;"],
    ];
    for (const [extension, text] of reads) expect(needsInteractiveInput(extension, text), text).toBe(true);
    const notReads: [string, string][] = [
      ["f90", "open(newunit=u, file='data.txt')\nread (u, *) x"],
      ["f90", "read (10, *) x"],
      ["f90", "print *, 'thread count'"],
      ["pas", "readln(f, line);"],
      ["pas", "AssignFile(f, 'data.txt'); Reset(f); Read(f, x);"],
      ["pp", "writeln('ReadFile is a Windows call');"],
      ["pas", "writeln('Please read the manual');"],
    ];
    for (const [extension, text] of notReads) expect(needsInteractiveInput(extension, text), text).toBe(false);
    expect(
      isMissingInputError("At line 6 of file E:/w\\input.f90 (unit = 5, file = 'stdin')"),
    ).toBe(true);
    expect(isMissingInputError("At line 6 of file E:/w\\read.f90 (unit = 10, file = 'data.txt')")).toBe(false);
  });
});

describe("diagnoseDependency: Python MySQL drivers", () => {
  it("`import mysql.connector` installs mysql-connector-python, not the old `mysql` shim", () => {
    expect(diagnoseDependency("ModuleNotFoundError: No module named 'mysql'")).toMatchObject({
      package: "mysql-connector-python",
      guessed: false,
    });
    expect(diagnoseDependency("ModuleNotFoundError: No module named 'mysql.connector'")).toMatchObject({
      package: "mysql-connector-python",
    });
    expect(diagnoseDependency("ModuleNotFoundError: No module named 'MySQLdb'")).toMatchObject({ package: "mysqlclient" });
    expect(diagnoseDependency("ModuleNotFoundError: No module named 'pymysql'")).toMatchObject({ guessed: false });
    expect(diagnoseDependency("ModuleNotFoundError: No module named 'mariadb'")).toMatchObject({ guessed: false });
  });
});

describe("diagnoseDatabase", () => {
  // The messages below are the real ones of each driver against MariaDB 11.8 and MySQL 8.0 on Windows.
  const db = (problem: string, database: string | null = null, port: number | null = null) => ({
    kind: "databaseConnection",
    problem,
    database,
    port,
  });

  it("an unknown database, from every driver", () => {
    for (const line of [
      `pymysql.err.OperationalError: (1049, "Unknown database 'school'")`,
      "mysql.connector.errors.ProgrammingError: 1049 (42000): Unknown database 'school'",
      "mariadb.ProgrammingError: Unknown database 'school'",
      "PHP Fatal error:  Uncaught mysqli_sql_exception: Unknown database 'school' in C:/w/db.php:3",
      "PDOException: SQLSTATE[HY000] [1049] Unknown database 'school'",
      "Error: Unknown database 'school' { code: 'ER_BAD_DB_ERROR', errno: 1049 }",
    ]) {
      expect(diagnoseDatabase(line), line).toEqual(db("unknownDatabase", "school"));
    }
  });

  it("a refused password, including MariaDB's switch to Windows login that clients report instead", () => {
    for (const line of [
      `MySQLdb.OperationalError: (1045, "Access denied for user 'root'@'::1' (using password: YES)")`,
      "mysql.connector.errors.ProgrammingError: 1045 (28000): Access denied for user 'root'@'localhost' (using password: YES)",
      `pymysql.err.OperationalError: (2059, "Authentication plugin 'b'auth_gssapi_client'' not configured")`,
      "mysqli_sql_exception: The server requested authentication method unknown to the client [auth_gssapi_client]",
      "PDOException: SQLSTATE[HY000] [2054] The server requested authentication method unknown to the client [auth_gssapi_client]",
      "AUTH_SWITCH_PLUGIN_ERROR Server requests authentication using unknown plugin auth_gssapi_client.",
    ]) {
      expect(diagnoseDatabase(line), line).toEqual(db("accessDenied"));
    }
  });

  it("nothing listening, with the port when the message names one", () => {
    expect(diagnoseDatabase("2003 (HY000): Can't connect to MySQL server on 'localhost:3306' (10061)")).toEqual(
      db("refused", null, 3306),
    );
    expect(diagnoseDatabase(`(2003, "Can't connect to MySQL server on 'localhost' ([WinError 10061] ...)")`)).toEqual(
      db("refused"),
    );
    expect(diagnoseDatabase("mariadb.OperationalError: Can't connect to server on 'localhost' (10061)")).toEqual(db("refused"));
    expect(diagnoseDatabase("Error: connect ECONNREFUSED 127.0.0.1:3306")).toEqual(db("refused", null, 3306));
    expect(diagnoseDatabase("Error: connect ECONNREFUSED ::1:3307")).toEqual(db("refused", null, 3307));
    expect(
      diagnoseDatabase("PDOException: SQLSTATE[HY000] [2002] No connection could be made because the target machine actively refused it"),
    ).toEqual(db("refused"));
    expect(diagnoseDatabase("mysqli_sql_exception: No connection could be made because the target machine actively refused it")).toEqual(
      db("refused"),
    );
    expect(diagnoseDatabase("com.mysql.cj.jdbc.exceptions.CommunicationsException: Communications link failure")).toEqual(db("refused"));
    expect(diagnoseDatabase("Unable to connect to any of the specified MySQL hosts.")).toEqual(db("refused"));
  });

  it("other servers' refusals are not database problems", () => {
    expect(diagnoseDatabase("Error: connect ECONNREFUSED 127.0.0.1:8080")).toBeNull();
    expect(diagnoseDatabase("Error: connect ECONNREFUSED 127.0.0.1:33060")).toBeNull();
    expect(diagnoseDatabase("No connection could be made because the target machine actively refused it")).toBeNull();
    expect(diagnoseDatabase("curl: (7) Failed to connect to localhost port 80: Connection refused")).toBeNull();
  });

  it("is part of diagnoseDependency", () => {
    expect(diagnoseDependency("Unknown database 'shop'")).toEqual(db("unknownDatabase", "shop"));
  });
});
