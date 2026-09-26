//! Commands of Python, PHP, Ruby, Rust, Go, Flutter/Dart, C/C++ and container projects, and the notes that go with
//! a project (platform limits, SDKs).

use super::{cmd, Category, Command};
use crate::project::{Detection, Dir};
use crate::tools::Os;

pub fn commands(dir: &Dir, detections: &[Detection], os: Os) -> Vec<Command> {
    let has = |id: &str| detections.iter().any(|d| d.id == id);
    let mut out = Vec::new();
    if has("rust") {
        out.extend(rust(dir));
    }
    if has("tauri") && dir.script("tauri").is_none() {
        out.push(
            cmd(
                "tauri.cargo.dev",
                "Tauri dev (cargo tauri dev)",
                Category::Dev,
                &["cargo", "tauri", "dev"],
                &["cargo"],
            )
            .note("Needs the Tauri CLI (`cargo install tauri-cli`)."),
        );
        out.push(
            cmd(
                "tauri.cargo.build",
                "Tauri build (cargo tauri build)",
                Category::Build,
                &["cargo", "tauri", "build"],
                &["cargo"],
            )
            .note("Needs the Tauri CLI (`cargo install tauri-cli`)."),
        );
    }
    if has("go") {
        out.extend(go(dir));
    }
    if has("python") {
        out.extend(python(dir, detections));
    }
    if has("php") {
        out.extend(php(dir, has("laravel")));
    }
    if has("ruby") {
        out.extend(ruby(has("rails")));
    }
    if has("flutter") || has("dart") {
        out.extend(flutter(dir, has("flutter"), os));
    }
    out.extend(native(detections, os));
    out
}

fn rust(dir: &Dir) -> Vec<Command> {
    let mut out = Vec::new();
    let binary = dir.path.join("src").join("main.rs").is_file()
        || dir
            .read("Cargo.toml")
            .is_some_and(|t| t.contains("[[bin]]"));
    if binary {
        out.push(cmd(
            "cargo.run",
            "Run (cargo run)",
            Category::Run,
            &["cargo", "run"],
            &["cargo"],
        ));
    }
    out.push(cmd(
        "cargo.build",
        "Build (cargo build)",
        Category::Build,
        &["cargo", "build"],
        &["cargo"],
    ));
    out.push(cmd(
        "cargo.test",
        "Test (cargo test)",
        Category::Test,
        &["cargo", "test"],
        &["cargo"],
    ));
    out.push(
        cmd(
            "cargo.clippy",
            "Lint (cargo clippy)",
            Category::Lint,
            &["cargo", "clippy"],
            &["cargo"],
        )
        .note("Needs the clippy component (`rustup component add clippy`)."),
    );
    out.push(cmd(
        "cargo.fmt",
        "Format (cargo fmt)",
        Category::Format,
        &["cargo", "fmt"],
        &["cargo", "rustfmt"],
    ));
    out
}

fn go(dir: &Dir) -> Vec<Command> {
    let mut out = Vec::new();
    if dir.has("main.go") {
        out.push(cmd(
            "go.run",
            "Run (go run .)",
            Category::Run,
            &["go", "run", "."],
            &["go"],
        ));
    }
    out.push(cmd(
        "go.build",
        "Build (go build ./...)",
        Category::Build,
        &["go", "build", "./..."],
        &["go"],
    ));
    out.push(cmd(
        "go.test",
        "Test (go test ./...)",
        Category::Test,
        &["go", "test", "./..."],
        &["go"],
    ));
    out.push(cmd(
        "go.vet",
        "Lint (go vet ./...)",
        Category::Lint,
        &["go", "vet", "./..."],
        &["go"],
    ));
    out.push(cmd(
        "go.fmt",
        "Format (gofmt -w .)",
        Category::Format,
        &["gofmt", "-w", "."],
        &["gofmt"],
    ));
    out
}

/// The FastAPI app file and the `module:app` name for uvicorn, when the project plainly defines `app = FastAPI(`.
fn fastapi_target(dir: &Dir) -> Option<String> {
    for (file, module) in [("main.py", "main"), ("app.py", "app")] {
        if dir
            .read(file)
            .is_some_and(|t| t.contains("app = FastAPI(") || t.contains("app=FastAPI("))
        {
            return Some(format!("{module}:app"));
        }
    }
    let nested = dir.path.join("app").join("main.py");
    let text = std::fs::read_to_string(nested).ok()?;
    (text.contains("app = FastAPI(") || text.contains("app=FastAPI("))
        .then(|| "app.main:app".to_string())
}

fn python(dir: &Dir, detections: &[Detection]) -> Vec<Command> {
    let has = |id: &str| detections.iter().any(|d| d.id == id);
    let mut out = Vec::new();
    if dir.has("requirements.txt") {
        out.push(
            cmd(
                "python.install",
                "Install requirements (pip install -r requirements.txt)",
                Category::Install,
                &["python", "-m", "pip", "install", "-r", "requirements.txt"],
                &["python"],
            )
            .network()
            .note("Installs into the active environment; create a virtual environment first."),
        );
    }
    if has("django") && dir.has("manage.py") {
        out.push(cmd(
            "django.run",
            "Run server (manage.py runserver)",
            Category::Run,
            &["python", "manage.py", "runserver"],
            &["python"],
        ));
        out.push(cmd(
            "django.test",
            "Test (manage.py test)",
            Category::Test,
            &["python", "manage.py", "test"],
            &["python"],
        ));
    }
    if has("fastapi") {
        if let Some(target) = fastapi_target(dir) {
            out.push(cmd(
                "fastapi.run",
                &format!("Run (uvicorn {target} --reload)"),
                Category::Run,
                &["uvicorn", &target, "--reload"],
                &["uvicorn"],
            ));
        }
    }
    if has("flask") && dir.has_any(&["app.py", "wsgi.py"]) {
        out.push(
            cmd(
                "flask.run",
                "Run (flask run)",
                Category::Run,
                &["flask", "run"],
                &["flask"],
            )
            .note("Flask finds app.py or wsgi.py in this folder."),
        );
    }
    let script = ["main.py", "app.py"].into_iter().find(|f| dir.has(f));
    if let Some(file) = script.filter(|_| !has("django") && !has("fastapi") && !has("flask")) {
        out.push(cmd(
            "python.run",
            &format!("Run (python {file})"),
            Category::Run,
            &["python", file],
            &["python"],
        ));
    }
    let pytest = dir.is_dir("tests")
        || ["pyproject.toml", "requirements.txt", "setup.cfg"]
            .iter()
            .filter_map(|n| dir.read(n))
            .any(|t| Dir::mentions(&t, "pytest"));
    if pytest {
        out.push(cmd(
            "python.pytest",
            "Test (pytest)",
            Category::Test,
            &["pytest"],
            &["pytest"],
        ));
    }
    let ruff = dir
        .read("pyproject.toml")
        .is_some_and(|t| Dir::mentions(&t, "ruff"))
        || dir.has("ruff.toml");
    if ruff {
        out.push(cmd(
            "python.ruff",
            "Lint (ruff check .)",
            Category::Lint,
            &["ruff", "check", "."],
            &["ruff"],
        ));
    }
    out
}

fn php(dir: &Dir, laravel: bool) -> Vec<Command> {
    let mut out = Vec::new();
    if !dir.is_dir("vendor") {
        out.push(
            cmd(
                "composer.install",
                "Install dependencies (composer install)",
                Category::Install,
                &["composer", "install"],
                &["composer", "php"],
            )
            .network()
            .note("Downloads the project's packages; vendor/ is missing."),
        );
    }
    if laravel {
        out.push(
            cmd(
                "laravel.serve",
                "Run (php artisan serve)",
                Category::Run,
                &["php", "artisan", "serve"],
                &["php"],
            )
            .note("Needs vendor/ (composer install) and a .env file."),
        );
        out.push(cmd(
            "laravel.test",
            "Test (php artisan test)",
            Category::Test,
            &["php", "artisan", "test"],
            &["php"],
        ));
    } else if dir
        .read("composer.json")
        .is_some_and(|t| t.contains("\"test\""))
    {
        out.push(cmd(
            "composer.test",
            "Test (composer test)",
            Category::Test,
            &["composer", "run", "test"],
            &["composer", "php"],
        ));
    }
    out
}

fn ruby(rails: bool) -> Vec<Command> {
    let mut out = vec![cmd(
        "bundle.install",
        "Install gems (bundle install)",
        Category::Install,
        &["bundle", "install"],
        &["bundle", "ruby"],
    )
    .network()];
    if rails {
        out.push(cmd(
            "rails.server",
            "Run (bundle exec rails server)",
            Category::Run,
            &["bundle", "exec", "rails", "server"],
            &["bundle", "ruby"],
        ));
        out.push(cmd(
            "rails.test",
            "Test (bundle exec rails test)",
            Category::Test,
            &["bundle", "exec", "rails", "test"],
            &["bundle", "ruby"],
        ));
    }
    out
}

fn flutter(dir: &Dir, flutter: bool, os: Os) -> Vec<Command> {
    if !flutter {
        return vec![
            cmd(
                "dart.run",
                "Run (dart run)",
                Category::Run,
                &["dart", "run"],
                &["dart"],
            ),
            cmd(
                "dart.test",
                "Test (dart test)",
                Category::Test,
                &["dart", "test"],
                &["dart"],
            ),
            cmd(
                "dart.analyze",
                "Lint (dart analyze)",
                Category::Lint,
                &["dart", "analyze"],
                &["dart"],
            ),
            cmd(
                "dart.format",
                "Format (dart format .)",
                Category::Format,
                &["dart", "format", "."],
                &["dart"],
            ),
        ];
    }
    let mut out = Vec::new();
    if !dir.is_dir(".dart_tool") {
        out.push(
            cmd(
                "flutter.pub",
                "Get packages (flutter pub get)",
                Category::Install,
                &["flutter", "pub", "get"],
                &["flutter"],
            )
            .network(),
        );
    }
    out.push(
        cmd(
            "flutter.run",
            "Run (flutter run)",
            Category::Run,
            &["flutter", "run"],
            &["flutter"],
        )
        .note(
            "Runs on a connected device or the desktop target; OpenMind doesn't manage emulators.",
        ),
    );
    if dir.is_dir("windows") {
        let mut build = cmd(
            "flutter.build.windows",
            "Build Windows app (flutter build windows)",
            Category::Build,
            &["flutter", "build", "windows"],
            &["flutter"],
        );
        if os != Os::Windows {
            build = build.unavailable("A Windows build needs Windows.");
        }
        out.push(build);
    }
    if dir.is_dir("android") {
        out.push(cmd(
            "flutter.build.apk",
            "Build APK (flutter build apk)",
            Category::Build,
            &["flutter", "build", "apk"],
            &["flutter", "android-sdk"],
        ));
    }
    if dir.is_dir("linux") && os == Os::Linux {
        out.push(cmd(
            "flutter.build.linux",
            "Build Linux app (flutter build linux)",
            Category::Build,
            &["flutter", "build", "linux"],
            &["flutter"],
        ));
    }
    if dir.is_dir("macos") && os == Os::MacOs {
        out.push(cmd(
            "flutter.build.macos",
            "Build macOS app (flutter build macos)",
            Category::Build,
            &["flutter", "build", "macos"],
            &["flutter"],
        ));
    }
    if dir.is_dir("web") {
        out.push(cmd(
            "flutter.build.web",
            "Build web app (flutter build web)",
            Category::Build,
            &["flutter", "build", "web"],
            &["flutter"],
        ));
    }
    out.push(cmd(
        "flutter.test",
        "Test (flutter test)",
        Category::Test,
        &["flutter", "test"],
        &["flutter"],
    ));
    out.push(cmd(
        "flutter.analyze",
        "Lint (flutter analyze)",
        Category::Lint,
        &["flutter", "analyze"],
        &["flutter"],
    ));
    out.push(cmd(
        "flutter.format",
        "Format (dart format .)",
        Category::Format,
        &["dart", "format", "."],
        &["dart"],
    ));
    out
}

fn native(detections: &[Detection], os: Os) -> Vec<Command> {
    let has = |id: &str| detections.iter().any(|d| d.id == id);
    let mut out = Vec::new();
    if has("cmake") {
        out.push(cmd(
            "cmake.configure",
            "Configure (cmake -S . -B build)",
            Category::Build,
            &["cmake", "-S", ".", "-B", "build"],
            &["cmake"],
        ));
        out.push(
            cmd(
                "cmake.build",
                "Build (cmake --build build)",
                Category::Build,
                &["cmake", "--build", "build"],
                &["cmake"],
            )
            .note("Run Configure first."),
        );
    } else if has("make") {
        out.push(cmd(
            "make.build",
            "Build (make)",
            Category::Build,
            &["make"],
            &["make"],
        ));
    }
    if has("docker-compose") {
        out.push(
            cmd(
                "compose.up",
                "Run (docker compose up)",
                Category::Run,
                &["docker", "compose", "up"],
                &["docker"],
            )
            .network()
            .note("May pull images."),
        );
        out.push(
            cmd(
                "compose.build",
                "Build (docker compose build)",
                Category::Build,
                &["docker", "compose", "build"],
                &["docker"],
            )
            .network()
            .note("May pull images."),
        );
    }
    if has("docker") && !has("docker-compose") {
        out.push(
            cmd(
                "docker.build",
                "Build image (docker build .)",
                Category::Build,
                &["docker", "build", "."],
                &["docker"],
            )
            .network()
            .note("May pull base images."),
        );
    }
    if has("ios") {
        let mut list = cmd(
            "ios.list",
            "List Xcode schemes (xcodebuild -list)",
            Category::Build,
            &["xcodebuild", "-list"],
            &["xcodebuild"],
        );
        if os != Os::MacOs {
            list = list.unavailable("iOS builds require macOS and Xcode.");
        }
        out.push(list);
    }
    out
}

/// Things to know about a project that aren't commands.
pub fn notes(dir: &Dir, detections: &[Detection], os: Os) -> Vec<String> {
    let has = |id: &str| detections.iter().any(|d| d.id == id);
    let mut notes = Vec::new();
    let shell =
        has("react-native") || has("expo") || has("ionic") || has("capacitor") || has("flutter");
    let ios_target = has("ios") || (shell && (dir.is_dir("ios") || dir.script("ios").is_some()));
    if ios_target && os != Os::MacOs {
        notes.push(
            "iOS builds require macOS and Xcode; on this computer OpenMind only shows the project."
                .to_string(),
        );
    }
    if has("android") || has("react-native") || has("expo") || has("flutter") {
        notes.push(
            "Mobile projects need their own SDK; OpenMind doesn't manage emulators or devices."
                .to_string(),
        );
    }
    if has("flutter-desktop") {
        notes
            .push("Flutter desktop targets are present (windows/linux/macos folders).".to_string());
    }
    if has("laravel") && !dir.has(".env") {
        notes.push("There is no .env file yet (copy .env.example).".to_string());
    }
    if has("jupyter") {
        notes.push("Notebooks are detected only: OpenMind has no notebook editor.".to_string());
    }
    if has("swift-package") {
        notes.push(
            "Swift packages need the Swift toolchain; OpenMind offers no Swift commands."
                .to_string(),
        );
    }
    notes
}
