//! Plans for a project's build tools: Cargo, Maven, Gradle (the project's wrapper first) and CMake. Rust stays external
//! (rustup is never run), Maven/Gradle/CMake come from the Runtime Manager or PATH, builds stay in the project.

use std::path::Path;

use crate::others;
use crate::plan::{
    err, finish, Network, Op, Plan, PlanContext, PlanError, Resolved, RUST_EXTERNAL,
};

pub(crate) fn plan_build(op: &Op, ctx: &PlanContext<'_>) -> Result<Plan, PlanError> {
    let folder = ctx.project.display().to_string();
    let (manager, program, args, target, network, notes): (
        &str,
        Resolved,
        Vec<String>,
        String,
        Network,
        Vec<String>,
    ) = match op {
        Op::Cargo { command } => {
            if !["check", "build", "test", "run"].contains(&command.as_str())
                || !ctx.project.join("Cargo.toml").is_file()
            {
                return err("Not a Cargo command for this project.");
            }
            let cargo = (ctx.tool)("cargo").ok_or_else(|| PlanError(RUST_EXTERNAL.into()))?;
            let target = format!(
                "{} (this project's target folder)",
                ctx.project.join("target").display()
            );
            (
                "cargo",
                cargo,
                vec![command.clone()],
                target,
                Network::May,
                vec!["Cargo downloads crates that aren't in its cache yet.".into()],
            )
        }
        Op::Maven { goal } => {
            if !["compile", "test", "package"].contains(&goal.as_str())
                || !ctx.project.join("pom.xml").is_file()
            {
                return err("Not a Maven goal for this project.");
            }
            let mvn = (ctx.tool)("mvn").ok_or_else(|| {
                PlanError(
                    "Maven was not found. Install Maven (and a JDK) from the Runtime Manager."
                        .into(),
                )
            })?;
            ("maven", mvn, vec![goal.clone()], folder.clone(), Network::May, vec!["Maven downloads dependencies and plugins into its own repository (~/.m2) when missing.".into()])
        }
        Op::Gradle { task } => {
            let info = others::read_java(ctx.project).filter(|java| java.gradle);
            if !["build", "test"].contains(&task.as_str()) || info.is_none() {
                return err("Not a Gradle task for this project.");
            }
            let wrapper = ctx.project.join(if cfg!(windows) {
                "gradlew.bat"
            } else {
                "gradlew"
            });
            let gradle = if wrapper.is_file() {
                Resolved {
                    path: wrapper,
                    source: "project Gradle wrapper".into(),
                }
            } else {
                (ctx.tool)("gradle").ok_or_else(|| PlanError("Gradle was not found and the project has no Gradle wrapper. Install Gradle from the Runtime Manager.".into()))?
            };
            (
                "gradle",
                gradle,
                vec![task.clone()],
                folder.clone(),
                Network::May,
                vec!["Gradle (or its wrapper) downloads what it needs the first time.".into()],
            )
        }
        Op::CmakeConfigure { .. } | Op::CmakeBuild | Op::CmakeClean => return plan_cmake(op, ctx),
        _ => return err("Not a build operation."),
    };
    let action = args.first().cloned().unwrap_or_default();
    finish(
        ctx,
        manager,
        &action,
        Vec::new(),
        program,
        args,
        target,
        network,
        notes,
    )
}

pub(crate) fn plan_cmake(op: &Op, ctx: &PlanContext<'_>) -> Result<Plan, PlanError> {
    let info = others::read_cmake(ctx.project)
        .ok_or_else(|| PlanError("This folder has no CMakeLists.txt.".into()))?;
    let cmake = (ctx.tool)("cmake").ok_or_else(|| {
        PlanError("CMake was not found. Install CMake from the Runtime Manager.".into())
    })?;
    let build = ctx.project.join("build");
    let text = |path: &Path| path.to_string_lossy().into_owned();
    let (action, args) = match op {
        Op::CmakeConfigure {
            preset: Some(preset),
        } => {
            if !info.presets.contains(preset) {
                return err(format!(
                    "\"{preset}\" isn't a configure preset of this project."
                ));
            }
            ("configure", vec!["--preset".to_string(), preset.clone()])
        }
        Op::CmakeConfigure { preset: None } => {
            let mut args = vec![
                "-S".to_string(),
                text(ctx.project),
                "-B".to_string(),
                text(&build),
            ];
            if (ctx.tool)("ninja").is_some() {
                args.extend(["-G".to_string(), "Ninja".to_string()]);
            }
            ("configure", args)
        }
        Op::CmakeBuild | Op::CmakeClean if !info.configured => {
            return err("Configure the project first (build/CMakeCache.txt doesn't exist).")
        }
        Op::CmakeBuild => ("build", vec!["--build".to_string(), text(&build)]),
        Op::CmakeClean => (
            "clean",
            vec![
                "--build".to_string(),
                text(&build),
                "--target".into(),
                "clean".into(),
            ],
        ),
        _ => return err("Not a CMake operation."),
    };
    let target = format!("{} (build folder)", build.display());
    finish(
        ctx,
        "cmake",
        action,
        Vec::new(),
        cmake,
        args,
        target,
        Network::None,
        Vec::new(),
    )
}
