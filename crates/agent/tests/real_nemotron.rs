//! The agent against the real local engine and a real Nemotron model (ignored; needs both on disk):
//! `OPENMIND_TEST_LLAMA_SERVER=<path to llama-server.exe> OPENMIND_TEST_GGUF=<path to a Nemotron .gguf>
//!  cargo test -p openmind-agent --test real_nemotron -- --ignored --nocapture`

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use openmind_agent::{
    system_prompt, AgentEvent, AgentHost, CommandEnv, Decision, HttpModel, Mode, PermissionRequest,
    PromptFacts, Session, TurnInput, Workspace,
};
use openmind_llm::{Engine, EngineConfig, Health};

struct AllowAll {
    events: Mutex<Vec<AgentEvent>>,
    asked: Mutex<Vec<String>>,
}

impl AgentHost for AllowAll {
    fn emit(&self, event: AgentEvent) {
        if let AgentEvent::ToolStart { title, target, .. } = &event {
            println!("● {title}({target})");
        }
        self.events.lock().expect("lock").push(event);
    }

    fn ask(&self, request: PermissionRequest, _cancel: &AtomicBool) -> Decision {
        println!("  asked: {} {}", request.title, request.target);
        self.asked.lock().expect("lock").push(request.title);
        Decision::Allow
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
}

#[test]
#[ignore = "needs llama-server and a Nemotron model on disk"]
fn nemotron_fixes_a_bug_in_a_real_project() {
    let (Some(program), Some(model)) = (
        env_path("OPENMIND_TEST_LLAMA_SERVER"),
        env_path("OPENMIND_TEST_GGUF"),
    ) else {
        eprintln!("skipped: set OPENMIND_TEST_LLAMA_SERVER and OPENMIND_TEST_GGUF");
        return;
    };
    let dir = tempfile::tempdir().expect("tmp");
    let root = dir.path().join("my project");
    std::fs::create_dir_all(&root).expect("mkdir");
    std::fs::write(
        root.join("calc.py"),
        "def add(a, b):\n    return a - b\n\n\nprint(add(2, 3))\n",
    )
    .expect("write");
    let mut engine = Engine::start(&EngineConfig {
        program,
        model,
        alias: "nemotron".into(),
        context_tokens: 16_384,
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
            started.elapsed() < Duration::from_secs(180),
            "the model took too long to load"
        );
        std::thread::sleep(Duration::from_millis(500));
    }
    println!("engine ready in {:.1} s", started.elapsed().as_secs_f32());

    let ws = Workspace::new(&root).expect("ws");
    let system = system_prompt(
        &ws,
        &PromptFacts {
            os: "Windows",
            date: "2026-10-14",
            ui_language: "English",
            plan_mode: false,
        },
    );
    let mut session = Session::new(system, "nemotron".into(), 16_384, Mode::Ask);
    let client = HttpModel {
        base_url: engine.base_url(),
        key: engine.key().to_string(),
    };
    let host = AllowAll {
        events: Mutex::new(Vec::new()),
        asked: Mutex::new(Vec::new()),
    };
    let cancel = AtomicBool::new(false);
    let input = TurnInput {
        ws: &ws,
        env: &CommandEnv::default(),
        unsaved: &[],
        cancel: &cancel,
    };
    session.run_turn(
        "The add function in calc.py gives the wrong result. Fix it.",
        &client,
        &host,
        &input,
    );
    engine.stop();
    let fixed = std::fs::read_to_string(root.join("calc.py")).expect("read");
    println!("calc.py now:\n{fixed}");
    assert!(fixed.contains("a + b"), "the bug was not fixed");
    assert!(
        !host.asked.lock().expect("lock").is_empty(),
        "the edit was approved by the user"
    );
}
