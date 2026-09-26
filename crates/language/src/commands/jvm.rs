//! Commands of Maven, Gradle (including Android) and .NET projects.

use super::{cmd, Category, Command};
use crate::project::{Detection, Dir};
use crate::tools::Os;

/// The wrapper script a Java build ships with, typed the way the current OS runs a script in the folder.
fn wrapper(dir: &Dir, name: &str, os: Os) -> Option<String> {
    if os == Os::Windows {
        dir.has(&format!("{name}.cmd"))
            .then(|| format!(".\\{name}.cmd"))
            .or_else(|| {
                dir.has(&format!("{name}.bat"))
                    .then(|| format!(".\\{name}.bat"))
            })
    } else {
        dir.has(name).then(|| format!("./{name}"))
    }
}

fn with(mut command: Command, program: &str, args: &[&str]) -> Command {
    let mut argv = vec![program.to_string()];
    argv.extend(args.iter().map(|a| (*a).to_string()));
    command.argv = argv;
    command
}

pub fn commands(dir: &Dir, detections: &[Detection], os: Os) -> Vec<Command> {
    let has = |id: &str| detections.iter().any(|d| d.id == id);
    let mut out = Vec::new();
    if has("maven") {
        out.extend(maven(dir, has("spring"), os));
    }
    if has("gradle") {
        out.extend(gradle(dir, has("spring"), has("android"), os));
    }
    if has("dotnet") {
        out.extend(dotnet(dir, detections, os));
    }
    out
}

fn maven(dir: &Dir, spring: bool, os: Os) -> Vec<Command> {
    let (program, tools): (String, &[&str]) = match wrapper(dir, "mvnw", os) {
        Some(script) => (script, &["java"]),
        None => ("mvn".to_string(), &["mvn", "java"]),
    };
    let mut out = Vec::new();
    if spring {
        out.push(with(
            cmd(
                "maven.run",
                "Run (mvn spring-boot:run)",
                Category::Run,
                &[],
                tools,
            ),
            &program,
            &["spring-boot:run"],
        ));
    }
    out.push(
        with(
            cmd(
                "maven.build",
                "Build (mvn package)",
                Category::Build,
                &[],
                tools,
            ),
            &program,
            &["package"],
        )
        .network()
        .note("Maven downloads missing dependencies."),
    );
    out.push(
        with(
            cmd("maven.test", "Test (mvn test)", Category::Test, &[], tools),
            &program,
            &["test"],
        )
        .network()
        .note("Maven downloads missing dependencies."),
    );
    out
}

fn gradle(dir: &Dir, spring: bool, android: bool, os: Os) -> Vec<Command> {
    let (program, mut tools): (String, Vec<&str>) = match wrapper(dir, "gradlew", os) {
        Some(script) => (script, vec!["java"]),
        None => ("gradle".to_string(), vec!["gradle", "java"]),
    };
    if android {
        tools.push("android-sdk");
    }
    let mut out = Vec::new();
    if android {
        out.push(
            with(
                cmd(
                    "gradle.assemble",
                    "Build debug APK (assembleDebug)",
                    Category::Build,
                    &[],
                    &tools,
                ),
                &program,
                &["assembleDebug"],
            )
            .network()
            .note("Needs the Android SDK; no emulator or device is started by OpenMind."),
        );
        out.push(with(
            cmd("gradle.lint", "Android lint", Category::Lint, &[], &tools),
            &program,
            &["lint"],
        ));
    } else {
        let application = ["build.gradle", "build.gradle.kts"]
            .iter()
            .filter_map(|n| dir.read(n))
            .any(|t| Dir::mentions(&t, "application"));
        if spring {
            out.push(with(
                cmd(
                    "gradle.run",
                    "Run (gradle bootRun)",
                    Category::Run,
                    &[],
                    &tools,
                ),
                &program,
                &["bootRun"],
            ));
        } else if application {
            out.push(with(
                cmd("gradle.run", "Run (gradle run)", Category::Run, &[], &tools),
                &program,
                &["run"],
            ));
        }
        out.push(
            with(
                cmd(
                    "gradle.build",
                    "Build (gradle build)",
                    Category::Build,
                    &[],
                    &tools,
                ),
                &program,
                &["build"],
            )
            .network()
            .note("Gradle downloads missing dependencies."),
        );
    }
    out.push(
        with(
            cmd(
                "gradle.test",
                "Test (gradle test)",
                Category::Test,
                &[],
                &tools,
            ),
            &program,
            &["test"],
        )
        .network()
        .note("Gradle downloads missing dependencies."),
    );
    out
}

fn dotnet(dir: &Dir, detections: &[Detection], os: Os) -> Vec<Command> {
    let has = |id: &str| detections.iter().any(|d| d.id == id);
    let project = dir
        .find("", ".csproj")
        .or_else(|| dir.find("", ".fsproj"))
        .or_else(|| dir.find("", ".vbproj"));
    let text = project.and_then(|name| dir.read(name)).unwrap_or_default();
    let windows_only = has("wpf") || has("winforms");
    let mut out = Vec::new();
    let runnable = Dir::mentions(&text, "<OutputType>exe")
        || Dir::mentions(&text, "<OutputType>winexe")
        || has("aspnet");
    if runnable {
        let mut run = cmd(
            "dotnet.run",
            "Run (dotnet run)",
            Category::Run,
            &["dotnet", "run"],
            &["dotnet"],
        );
        if windows_only && os != Os::Windows {
            run = run.unavailable("WPF and Windows Forms apps run only on Windows.");
        }
        out.push(run);
    }
    out.push(
        cmd(
            "dotnet.build",
            "Build (dotnet build)",
            Category::Build,
            &["dotnet", "build"],
            &["dotnet"],
        )
        .network()
        .note("Restores NuGet packages."),
    );
    if Dir::mentions(&text, "Microsoft.NET.Test.Sdk")
        || dir
            .path
            .file_name()
            .is_some_and(|n| n.to_string_lossy().to_ascii_lowercase().contains("test"))
        || dir.find("", ".sln").is_some()
    {
        out.push(
            cmd(
                "dotnet.test",
                "Test (dotnet test)",
                Category::Test,
                &["dotnet", "test"],
                &["dotnet"],
            )
            .network()
            .note("Restores NuGet packages."),
        );
    }
    out.push(cmd(
        "dotnet.format",
        "Format (dotnet format)",
        Category::Format,
        &["dotnet", "format"],
        &["dotnet"],
    ));
    out
}
