//! Realistic tasks for the agent against the real local engine and a Nemotron model (ignored; needs both on disk).
//! Each task runs in its own folder and conversation; the results are printed as a table and every failure is listed
//! before the test fails, so one run shows everything that went wrong:
//! `OPENMIND_TEST_LLAMA_SERVER=<llama-server.exe> OPENMIND_TEST_GGUF=<model .gguf>
//!  cargo test -p openmind-agent --test real_tasks -- --ignored --nocapture`
//! `OPENMIND_TEST_TASK=<name>` runs one task only.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use openmind_agent::{
    system_prompt, AgentEvent, AgentHost, CommandEnv, Decision, HttpModel, Mode, PermissionRequest,
    PromptFacts, Session, TurnInput, Workspace,
};
use openmind_llm::{Engine, EngineConfig, Health};

const CONTEXT: u32 = 16_384;

#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<AgentEvent>>,
}

impl AgentHost for Recorder {
    fn emit(&self, event: AgentEvent) {
        match &event {
            AgentEvent::ToolStart { title, target, .. } => println!("  ● {title}({target})"),
            AgentEvent::ToolEnd { ok, summary, .. } => {
                println!("    ⎿ {}{summary}", if *ok { "" } else { "FAILED " })
            }
            AgentEvent::Text { text } if !text.trim().is_empty() => {
                println!("  » {}", text.trim().replace('\n', "\n    "))
            }
            AgentEvent::TurnEnd { reason, message } => {
                println!("  ■ end: {reason} {}", message.clone().unwrap_or_default())
            }
            _ => {}
        }
        self.events.lock().expect("lock").push(event);
    }

    fn ask(&self, _request: PermissionRequest, _cancel: &AtomicBool) -> Decision {
        Decision::Allow
    }
}

impl Recorder {
    fn end_reason(&self) -> String {
        self.events
            .lock()
            .expect("lock")
            .iter()
            .rev()
            .find_map(|e| match e {
                AgentEvent::TurnEnd { reason, .. } => Some(reason.clone()),
                _ => None,
            })
            .unwrap_or_else(|| "none".into())
    }

    fn answer(&self) -> String {
        self.events
            .lock()
            .expect("lock")
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    fn changed_files(&self) -> usize {
        self.events
            .lock()
            .expect("lock")
            .iter()
            .filter(|e| matches!(e, AgentEvent::ToolEnd { changed: Some(_), .. }))
            .count()
    }

    fn tool_calls(&self) -> usize {
        self.events
            .lock()
            .expect("lock")
            .iter()
            .filter(|e| matches!(e, AgentEvent::ToolStart { .. }))
            .count()
    }
}

struct Task {
    name: &'static str,
    files: &'static [(&'static str, &'static str)],
    prompt: &'static str,
    /// Problems with the result; empty = passed.
    check: fn(&Path, &Recorder) -> Vec<String>,
}

fn python(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("python")
        .args(args)
        .current_dir(root)
        .env("PYTHONNOUSERSITE", "1")
        .output()
        .map_err(|e| format!("python could not start: {e}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if out.status.success() {
        Ok(text)
    } else {
        Err(text)
    }
}

fn read(root: &Path, name: &str) -> String {
    std::fs::read_to_string(root.join(name)).unwrap_or_default()
}

fn ended_done(rec: &Recorder) -> Vec<String> {
    let reason = rec.end_reason();
    if reason == "done" {
        Vec::new()
    } else {
        vec![format!("the turn ended with `{reason}`, not `done`")]
    }
}

fn has_cyrillic(text: &str) -> bool {
    text.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c))
}

fn tasks() -> Vec<Task> {
    vec![
        Task {
            name: "fix-bug",
            files: &[("calc.py", "def add(a, b):\n    return a - b\n\n\nprint(add(2, 3))\n")],
            prompt: "The add function in calc.py gives the wrong result. Fix it.",
            check: |root, rec| {
                let mut p = ended_done(rec);
                if !read(root, "calc.py").contains("a + b") {
                    p.push("calc.py still subtracts".into());
                }
                p
            },
        },
        Task {
            name: "rename-across-files",
            files: &[
                ("utils.py", "def get_total(items):\n    return sum(i['price'] for i in items)\n"),
                ("main.py", "from utils import get_total\n\nitems = [{'price': 2}, {'price': 3}]\nprint('total', get_total(items))\n"),
                ("report.py", "import utils\n\n\ndef report(items):\n    return f\"Total: {utils.get_total(items)}\"\n"),
            ],
            prompt: "Rename the function get_total to compute_total everywhere in this project, then run main.py to check it still works.",
            check: |root, rec| {
                let mut p = ended_done(rec);
                for f in ["utils.py", "main.py", "report.py"] {
                    let text = read(root, f);
                    if text.contains("get_total") {
                        p.push(format!("{f} still says get_total"));
                    }
                    if !text.contains("compute_total") {
                        p.push(format!("{f} has no compute_total"));
                    }
                }
                match python(root, &["main.py"]) {
                    Ok(out) if out.contains("total 5") => {}
                    Ok(out) | Err(out) => p.push(format!("main.py output: {}", out.trim())),
                }
                p
            },
        },
        Task {
            name: "feature-with-tests",
            files: &[("text_tools.py", "def shout(s):\n    return s.upper() + '!'\n")],
            prompt: "Add a function is_palindrome(s) to text_tools.py that ignores case and spaces. Write unittest tests for it in test_text_tools.py and run them.",
            check: |root, rec| {
                let mut p = ended_done(rec);
                if !root.join("test_text_tools.py").is_file() {
                    p.push("no test_text_tools.py".into());
                }
                let probe = "from text_tools import is_palindrome as f; assert f('Never odd or even') and f('abba') and not f('abc'); print('ok')";
                if let Err(out) = python(root, &["-c", probe]) {
                    p.push(format!("is_palindrome is wrong: {}", out.trim()));
                }
                if let Err(out) = python(root, &["-m", "unittest", "-q"]) {
                    p.push(format!("the tests fail: {}", out.trim()));
                }
                p
            },
        },
        Task {
            name: "fix-failing-tests",
            files: &[
                ("shop.py", "def discount(price, percent):\n    return price * percent / 100\n\n\ndef total(prices):\n    t = 0\n    for p in prices[1:]:\n        t += p\n    return t\n"),
                ("test_shop.py", "import unittest\nfrom shop import discount, total\n\n\nclass ShopTest(unittest.TestCase):\n    def test_discount(self):\n        self.assertEqual(discount(200, 25), 150)\n\n    def test_total(self):\n        self.assertEqual(total([1, 2, 3]), 6)\n\n\nif __name__ == '__main__':\n    unittest.main()\n"),
            ],
            prompt: "Run the tests in this project and fix the code so they pass. Don't change the tests.",
            check: |root, rec| {
                let mut p = ended_done(rec);
                if !read(root, "test_shop.py").contains("assertEqual(discount(200, 25), 150)") {
                    p.push("the tests were changed".into());
                }
                if let Err(out) = python(root, &["-m", "unittest", "-q"]) {
                    p.push(format!("the tests still fail: {}", out.trim()));
                }
                p
            },
        },
        Task {
            name: "question-only",
            files: &[("main.py", "import sys\n\n\ndef greet(name):\n    return f'Hello, {name}!'\n\n\nif __name__ == '__main__':\n    print(greet(sys.argv[1] if len(sys.argv) > 1 else 'world'))\n")],
            prompt: "What does main.py do? Answer briefly.",
            check: |_root, rec| {
                let mut p = ended_done(rec);
                if rec.changed_files() > 0 {
                    p.push("a question changed files".into());
                }
                let answer = rec.answer().to_lowercase();
                if !answer.contains("greet") && !answer.contains("hello") {
                    p.push(format!("the answer doesn't describe the file: {answer:?}"));
                }
                p
            },
        },
        Task {
            name: "russian",
            files: &[],
            prompt: "Создай файл hello.txt с текстом «Привет, мир».",
            check: |root, rec| {
                let mut p = ended_done(rec);
                if !read(root, "hello.txt").contains("Привет, мир") {
                    p.push(format!("hello.txt: {:?}", read(root, "hello.txt")));
                }
                let answer = rec.answer();
                if !answer.trim().is_empty() && !has_cyrillic(&answer) {
                    p.push(format!("the answer isn't Russian: {answer:?}"));
                }
                p
            },
        },
    ]
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
}

fn command_env() -> CommandEnv {
    let mut vars = vec![("PYTHONNOUSERSITE".to_string(), "1".to_string())];
    if let Some(path) = std::env::var_os("PATH") {
        vars.push(("PATH".into(), path.to_string_lossy().into_owned()));
    }
    CommandEnv { vars }
}

fn run_task(task: &Task, base: &Path, engine: &Engine) -> (Vec<String>, Duration, usize) {
    let root = base.join(format!("{} project", task.name));
    std::fs::create_dir_all(&root).expect("mkdir");
    for (name, text) in task.files {
        std::fs::write(root.join(name), text).expect("write");
    }
    let ws = Workspace::new(&root).expect("ws");
    let system = system_prompt(
        &ws,
        &PromptFacts {
            os: "Windows",
            date: "2026-10-26",
            ui_language: "English",
            plan_mode: false,
        },
    );
    let mut session = Session::new(system, "nemotron".into(), CONTEXT, Mode::Ask);
    let client = HttpModel {
        base_url: engine.base_url(),
        key: engine.key().to_string(),
    };
    let rec = Recorder::default();
    let cancel = AtomicBool::new(false);
    let env = command_env();
    let input = TurnInput {
        ws: &ws,
        env: &env,
        unsaved: &[],
        cancel: &cancel,
    };
    println!("\n=== {}: {}", task.name, task.prompt);
    let started = Instant::now();
    session.run_turn(task.prompt, &client, &rec, &input);
    let took = started.elapsed();
    ((task.check)(&root, &rec), took, rec.tool_calls())
}

#[test]
#[ignore = "needs llama-server and a Nemotron model on disk"]
fn nemotron_handles_realistic_tasks() {
    let (Some(program), Some(model)) = (
        env_path("OPENMIND_TEST_LLAMA_SERVER"),
        env_path("OPENMIND_TEST_GGUF"),
    ) else {
        eprintln!("skipped: set OPENMIND_TEST_LLAMA_SERVER and OPENMIND_TEST_GGUF");
        return;
    };
    let only = std::env::var("OPENMIND_TEST_TASK").ok();
    let dir = tempfile::tempdir().expect("tmp");
    let mut engine = Engine::start(&EngineConfig {
        program,
        model,
        alias: "nemotron".into(),
        context_tokens: CONTEXT,
        use_gpu: true,
        log_file: dir.path().join("engine.log"),
    })
    .expect("engine");
    let started = Instant::now();
    while engine.health() != Health::Ready {
        assert!(
            engine.exited().is_none(),
            "the engine stopped: {}",
            engine.log_tail(20)
        );
        assert!(
            started.elapsed() < Duration::from_secs(300),
            "the model took too long to load"
        );
        std::thread::sleep(Duration::from_millis(500));
    }
    println!("engine ready in {:.1} s", started.elapsed().as_secs_f32());

    let mut failures = Vec::new();
    let mut table = Vec::new();
    for task in tasks()
        .iter()
        .filter(|t| only.as_deref().is_none_or(|o| o == t.name))
    {
        let (problems, took, calls) = run_task(task, dir.path(), &engine);
        table.push(format!(
            "{:<20} {:<5} {:>6.1} s {:>3} tool calls",
            task.name,
            if problems.is_empty() { "PASS" } else { "FAIL" },
            took.as_secs_f32(),
            calls
        ));
        failures.extend(problems.into_iter().map(|p| format!("{}: {p}", task.name)));
    }
    engine.stop();
    println!("\n{}", table.join("\n"));
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
