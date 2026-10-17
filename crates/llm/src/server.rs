//! The local model engine: llama.cpp's `llama-server`, started only when the agent needs it. It listens on 127.0.0.1
//! only, on a free port, and requires a random key made for this run, so no other program on the PC (or the network)
//! can use it. On Windows it runs in a Job Object, so it dies with the app even after a crash.

use std::fs::File;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use crate::error::LlmError;

#[derive(Debug, Clone)]
pub struct EngineConfig {
    /// `llama-server.exe` from the Runtime Manager's `llamacpp` install.
    pub program: PathBuf,
    /// The model's first file.
    pub model: PathBuf,
    /// The name the engine reports for the model (the catalog id).
    pub alias: String,
    pub context_tokens: u32,
    pub use_gpu: bool,
    /// Where the engine writes what it prints (the app's logs folder).
    pub log_file: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Health {
    Ready,
    /// The engine answers but is still loading the model.
    Loading,
    /// Nothing answers (yet).
    Down,
}

pub struct Engine {
    child: Child,
    #[cfg(windows)]
    tree: Option<openmind_process::ProcessTree>,
    port: u16,
    key: String,
    pub alias: String,
    /// Context allocated by llama-server at startup.
    pub context_tokens: u32,
    log_file: PathBuf,
}

fn free_port() -> Result<u16, LlmError> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|err| LlmError::EngineStart(err.to_string()))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|err| LlmError::EngineStart(err.to_string()))
}

fn random_key() -> Result<String, LlmError> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|err| LlmError::EngineStart(err.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The command line, as a list (never a shell).
pub fn arguments(config: &EngineConfig, port: u16, key: &str) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--model".into(),
        config.model.to_string_lossy().into_owned(),
        "--alias".into(),
        config.alias.clone(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "--api-key".into(),
        key.into(),
        "--ctx-size".into(),
        config.context_tokens.to_string(),
        // One conversation at a time gets the whole context.
        "--parallel".into(),
        "1".into(),
        "--jinja".into(),
        // Thinking arrives apart from the answer (`reasoning_content`), so the panel can fold it away.
        "--reasoning-format".into(),
        "deepseek".into(),
        "--no-webui".into(),
        "--offline".into(),
    ];
    args.push("--gpu-layers".into());
    args.push(if config.use_gpu { "auto" } else { "0" }.into());
    args
}

impl Engine {
    pub fn start(config: &EngineConfig) -> Result<Self, LlmError> {
        if !config.program.is_file() {
            return Err(LlmError::EngineMissing);
        }
        if !config.model.is_file() {
            return Err(LlmError::NotDownloaded(config.alias.clone()));
        }
        let port = free_port()?;
        let key = random_key()?;
        if let Some(parent) = config.log_file.parent() {
            std::fs::create_dir_all(parent).map_err(|err| LlmError::io(parent, err))?;
        }
        let log =
            File::create(&config.log_file).map_err(|err| LlmError::io(&config.log_file, err))?;
        let log_err = log
            .try_clone()
            .map_err(|err| LlmError::io(&config.log_file, err))?;
        let mut command = Command::new(&config.program);
        command
            .args(arguments(config, port, &key))
            .current_dir(config.program.parent().unwrap_or(Path::new(".")))
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let child = command
            .spawn()
            .map_err(|err| LlmError::EngineStart(err.to_string()))?;
        #[cfg(windows)]
        let tree = {
            use std::os::windows::io::AsRawHandle;
            let tree = openmind_process::ProcessTree::new().ok();
            if let Some(tree) = &tree {
                if let Err(err) = tree.assign(child.as_raw_handle()) {
                    tracing::warn!(%err, "could not put the model engine in a job object");
                }
            }
            tree
        };
        tracing::info!(model = %config.alias, port, "local model engine started");
        Ok(Self {
            child,
            #[cfg(windows)]
            tree,
            port,
            key,
            alias: config.alias.clone(),
            context_tokens: config.context_tokens,
            log_file: config.log_file.clone(),
        })
    }

    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// `None` while running; the exit code (or -1) once it stopped.
    pub fn exited(&mut self) -> Option<i32> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
            Ok(None) => None,
            Err(_) => Some(-1),
        }
    }

    pub fn health(&self) -> Health {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(2)))
            .build()
            .into();
        let url = format!("http://127.0.0.1:{}/health", self.port);
        match agent
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.key))
            .call()
        {
            Ok(response) if response.status() == 200 => Health::Ready,
            Ok(_) => Health::Loading,
            Err(_) => Health::Down,
        }
    }

    /// The last lines the engine printed: the reason when it stopped by itself.
    pub fn log_tail(&self, lines: usize) -> String {
        let text = std::fs::read_to_string(&self.log_file).unwrap_or_default();
        let all: Vec<&str> = text.lines().collect();
        all[all.len().saturating_sub(lines)..].join("\n")
    }

    pub fn stop(&mut self) {
        #[cfg(windows)]
        if let Some(tree) = &self.tree {
            tree.terminate();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        tracing::info!(model = %self.alias, "local model engine stopped");
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        if self.exited().is_none() {
            self.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> EngineConfig {
        EngineConfig {
            program: PathBuf::from("llama-server.exe"),
            model: PathBuf::from("C:/Models/My Model/a.gguf"),
            alias: "nemotron".into(),
            context_tokens: 32768,
            use_gpu: true,
            log_file: PathBuf::from("engine.log"),
        }
    }

    #[test]
    fn allocated_context_is_forwarded_to_llama_server() {
        let mut config = config();
        config.context_tokens = 4_096;
        let args = arguments(&config, 4242, "key");
        let index = args.iter().position(|arg| arg == "--ctx-size").unwrap();
        assert_eq!(args[index + 1], "4096");
    }

    #[test]
    fn cpu_mode_disables_gpu_offload_and_gpu_mode_uses_auto() {
        let mut config = config();
        for (enabled, expected) in [(false, "0"), (true, "auto")] {
            config.use_gpu = enabled;
            let args = arguments(&config, 4242, "key");
            let index = args.iter().position(|arg| arg == "--gpu-layers").unwrap();
            assert_eq!(args[index + 1], expected);
        }
    }

    #[test]
    fn the_engine_listens_on_loopback_only_with_a_key() {
        let args = arguments(&config(), 4242, "secret");
        let pair = |flag: &str| {
            args.iter()
                .position(|a| a == flag)
                .and_then(|i| args.get(i + 1))
                .cloned()
        };
        assert_eq!(pair("--host").as_deref(), Some("127.0.0.1"));
        assert_eq!(pair("--port").as_deref(), Some("4242"));
        assert_eq!(pair("--api-key").as_deref(), Some("secret"));
        assert_eq!(
            pair("--model").as_deref(),
            Some("C:/Models/My Model/a.gguf")
        );
        assert!(args.contains(&"--no-webui".to_string()));
        assert!(args.contains(&"--offline".to_string()));
    }

    #[test]
    fn a_missing_engine_or_model_is_reported_before_anything_starts() {
        assert!(matches!(
            Engine::start(&config()),
            Err(LlmError::EngineMissing)
        ));
        let dir = tempfile::tempdir().expect("tmp");
        let program = dir.path().join("llama-server.exe");
        std::fs::write(&program, b"").expect("write");
        let mut cfg = config();
        cfg.program = program;
        assert!(matches!(
            Engine::start(&cfg),
            Err(LlmError::NotDownloaded(_))
        ));
    }

    #[test]
    fn keys_are_random_and_long() {
        let a = random_key().expect("key");
        let b = random_key().expect("key");
        assert_eq!(a.len(), 48);
        assert_ne!(a, b);
    }
}
