//! Python, PHP, Ruby, Java, .NET, Go and Rust projects, and the frameworks their manifests name.

use crate::project::{
    det,
    Confidence::{High, Medium},
    Detection, Dir,
    StackGroup::{Backend, Desktop, Systems},
};

pub fn detect(dir: &Dir) -> Vec<Detection> {
    let mut out = Vec::new();
    python(&mut out, dir);
    php(&mut out, dir);
    ruby(&mut out, dir);
    java(&mut out, dir);
    dotnet(&mut out, dir);
    if dir.has("go.mod") {
        out.push(det("go", "Go", Systems, High, "go.mod"));
    }
    if dir.has("Cargo.toml") {
        out.push(det("rust", "Rust", Systems, High, "Cargo.toml"));
    }
    out
}

fn python(out: &mut Vec<Detection>, dir: &Dir) {
    let manifests = [
        "requirements.txt",
        "pyproject.toml",
        "Pipfile",
        "setup.py",
        "setup.cfg",
    ];
    let strong = ["pyproject.toml", "Pipfile", "setup.py", "manage.py"];
    let Some(first) = manifests
        .iter()
        .chain(["manage.py"].iter())
        .find(|name| dir.has(name))
    else {
        return;
    };
    let confidence = if strong.iter().any(|name| dir.has(name)) {
        High
    } else {
        Medium
    };
    out.push(det("python", "Python", Backend, confidence, *first));
    let text: String = manifests
        .iter()
        .filter_map(|name| dir.read(name))
        .collect::<Vec<_>>()
        .join("\n");
    let mut frameworks = Vec::new();
    if dir.has("manage.py") {
        out.push(det("django", "Django", Backend, High, "manage.py"));
    } else if Dir::mentions(&text, "django") {
        frameworks.push(det(
            "django",
            "Django",
            Backend,
            Medium,
            "the Python manifest mentions django",
        ));
    }
    if Dir::mentions(&text, "fastapi") {
        frameworks.push(det(
            "fastapi",
            "FastAPI",
            Backend,
            Medium,
            "the Python manifest mentions fastapi",
        ));
    }
    if Dir::mentions(&text, "flask") {
        frameworks.push(det(
            "flask",
            "Flask",
            Backend,
            Medium,
            "the Python manifest mentions flask",
        ));
    }
    out.extend(frameworks);
}

fn php(out: &mut Vec<Detection>, dir: &Dir) {
    if !dir.has("composer.json") {
        return;
    }
    out.push(det("php", "PHP", Backend, High, "composer.json"));
    let composer = dir.read("composer.json").unwrap_or_default();
    let laravel_dep = Dir::mentions(&composer, "laravel/framework");
    if dir.has("artisan") && laravel_dep {
        out.push(det(
            "laravel",
            "Laravel",
            Backend,
            High,
            "artisan and laravel/framework",
        ));
    } else if dir.has("artisan") || laravel_dep {
        out.push(det(
            "laravel",
            "Laravel",
            Backend,
            Medium,
            "artisan or laravel/framework",
        ));
    }
}

fn ruby(out: &mut Vec<Detection>, dir: &Dir) {
    if !dir.has("Gemfile") {
        return;
    }
    out.push(det("ruby", "Ruby", Backend, High, "Gemfile"));
    let rails_app = dir.path.join("config").join("application.rb").is_file();
    if rails_app {
        out.push(det(
            "rails",
            "Ruby on Rails",
            Backend,
            High,
            "config/application.rb",
        ));
    } else if Dir::mentions(&dir.read("Gemfile").unwrap_or_default(), "rails") {
        out.push(det(
            "rails",
            "Ruby on Rails",
            Backend,
            Medium,
            "Gemfile mentions rails",
        ));
    }
}

fn java(out: &mut Vec<Detection>, dir: &Dir) {
    let gradle_files = [
        "build.gradle",
        "build.gradle.kts",
        "settings.gradle",
        "settings.gradle.kts",
    ];
    let mut text = String::new();
    if dir.has("pom.xml") {
        out.push(det("maven", "Maven (Java)", Backend, High, "pom.xml"));
        text.push_str(&dir.read("pom.xml").unwrap_or_default());
    }
    if let Some(file) = gradle_files.iter().find(|name| dir.has(name)) {
        out.push(det("gradle", "Gradle (JVM)", Backend, High, *file));
        for name in gradle_files {
            text.push_str(&dir.read(name).unwrap_or_default());
        }
    }
    if text.is_empty() {
        return;
    }
    if Dir::mentions(&text, "spring-boot") || Dir::mentions(&text, "org.springframework") {
        out.push(det(
            "spring",
            "Spring",
            Backend,
            Medium,
            "the build file mentions Spring",
        ));
    }
    if Dir::mentions(&text, "javafx") {
        out.push(det(
            "javafx",
            "JavaFX",
            Desktop,
            Medium,
            "the build file mentions JavaFX",
        ));
    }
}

fn dotnet(out: &mut Vec<Detection>, dir: &Dir) {
    let project = dir
        .find("", ".csproj")
        .or_else(|| dir.find("", ".fsproj"))
        .or_else(|| dir.find("", ".vbproj"));
    let solution = dir.find("", ".sln").or_else(|| dir.find("", ".slnx"));
    let Some(marker) = solution.or(project) else {
        return;
    };
    out.push(det("dotnet", ".NET", Backend, High, marker.to_string()));
    let text = project.and_then(|name| dir.read(name)).unwrap_or_default();
    if Dir::mentions(&text, "<UseWPF>true") {
        out.push(det(
            "wpf",
            "WPF",
            Desktop,
            High,
            "the project file enables WPF",
        ));
    }
    if Dir::mentions(&text, "<UseWindowsForms>true") {
        out.push(det(
            "winforms",
            "Windows Forms",
            Desktop,
            High,
            "the project file enables Windows Forms",
        ));
    }
    if Dir::mentions(&text, "Microsoft.NET.Sdk.Web") {
        out.push(det(
            "aspnet",
            "ASP.NET Core",
            Backend,
            High,
            "the project uses Microsoft.NET.Sdk.Web",
        ));
    }
}
