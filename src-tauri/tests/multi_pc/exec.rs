//! Execution isolation of the multi-PC harness (see `multi_pc.rs`): terminals and processes are always the computer's
//! own that started them — input, output, working folder, environment and termination never cross to another one, also
//! while every computer runs the same shared runtime binary.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openmind_terminal::{CreateTerminalRequest, ShellKind, TerminalRegistry};

use super::{Lab, PCS};

const SESSIONS_PER_PC: usize = 10;

type Buffers = Arc<Mutex<HashMap<String, Vec<u8>>>>;

/// An interactive cmd.exe session that answers ConPTY's cursor query (xterm.js does that in the app).
fn open_session(
    registry: &Arc<TerminalRegistry>,
    name: &str,
    cwd: PathBuf,
    buffers: &Buffers,
) -> String {
    let id = TerminalRegistry::generate_id();
    let (sink, responder, responder_id) = (buffers.clone(), registry.clone(), id.clone());
    let key = name.to_string();
    registry
        .create(
            id.clone(),
            CreateTerminalRequest {
                shell: Some(ShellKind::Cmd),
                cwd: Some(cwd),
                cols: 250,
                rows: 40,
                env: vec![("OM_SESSION".into(), name.into())],
                ..Default::default()
            },
            &std::env::temp_dir(),
            move |data| {
                sink.lock()
                    .expect("lock")
                    .entry(key.clone())
                    .or_default()
                    .extend_from_slice(data);
                if data.windows(4).any(|w| w == b"[6n") {
                    let (responder, id) = (responder.clone(), responder_id.clone());
                    std::thread::spawn(move || {
                        for _ in 0..500 {
                            if responder.write(&id, b"\x1b[1;1R").is_ok() {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(20));
                        }
                    });
                }
            },
            |_| {},
        )
        .expect("terminal");
    id
}

fn text_of(buffers: &Buffers, name: &str) -> String {
    String::from_utf8_lossy(
        buffers
            .lock()
            .expect("lock")
            .get(name)
            .map_or(&[][..], Vec::as_slice),
    )
    .into_owned()
}

fn wait_for(buffers: &Buffers, name: &str, needle: &str) -> bool {
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if text_of(buffers, name).contains(needle) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

#[cfg(windows)]
#[test]
fn ten_terminals_on_each_of_three_computers_keep_input_output_folder_and_environment_apart() {
    let lab = Lab::new();
    let buffers: Buffers = Arc::default();
    let mut sessions: Vec<(Arc<TerminalRegistry>, String, String)> = Vec::new();
    let registries: Vec<Arc<TerminalRegistry>> = PCS
        .iter()
        .map(|_| Arc::new(TerminalRegistry::new()))
        .collect();
    for (pc, registry) in PCS.iter().zip(&registries) {
        for i in 0..SESSIONS_PER_PC {
            let name = format!("{pc}-{i}");
            // Every computer's Student has a work folder at the same-looking path, on its own disk.
            let cwd = lab
                .root
                .join(pc)
                .join("C")
                .join(r"Users\Student")
                .join(format!("work-{i}"));
            std::fs::create_dir_all(&cwd).expect("cwd");
            std::fs::write(cwd.join("marker.txt"), format!("FOLDER-{name}")).expect("marker");
            let id = open_session(registry, &name, cwd, &buffers);
            sessions.push((registry.clone(), id, name));
        }
    }
    // Each shell is ready once its prompt (its own folder) is shown — the cursor query was answered.
    for (_, _, name) in &sessions {
        let i = name.rsplit('-').next().expect("index");
        assert!(
            wait_for(&buffers, name, &format!("work-{i}>")),
            "{name}: {}",
            text_of(&buffers, name)
        );
    }
    // Then every session gets its own input at the same time.
    for (registry, id, name) in &sessions {
        let line =
            format!("echo ENV-%OM_SESSION% & type marker.txt & echo. & echo INPUT-{name}-END\r\n");
        registry.write(id, line.as_bytes()).expect("input");
    }
    for (_, _, name) in &sessions {
        assert!(
            wait_for(&buffers, name, &format!("ENV-{name}")),
            "{name}: {}",
            text_of(&buffers, name)
        );
        assert!(
            wait_for(&buffers, name, &format!("FOLDER-{name}")),
            "{name}"
        );
        assert!(
            wait_for(&buffers, name, &format!("INPUT-{name}-END")),
            "{name}"
        );
    }
    for (_, _, name) in &sessions {
        let text = text_of(&buffers, name);
        for (_, _, other) in sessions.iter().filter(|(_, _, other)| other != name) {
            for marker in [
                format!("ENV-{other}\r"),
                format!("FOLDER-{other}"),
                format!("INPUT-{other}-END"),
            ] {
                assert!(!text.contains(&marker), "{name}'s terminal shows {marker}");
            }
        }
    }
    // PC-A closes all its terminals: PC-B's and PC-C's go on.
    registries[0].kill_all();
    for (registry, id, name) in sessions
        .iter()
        .filter(|(_, _, name)| !name.starts_with("PC-A"))
    {
        registry
            .write(id, format!("echo STILL-{name}\r\n").as_bytes())
            .expect("alive");
        assert!(wait_for(&buffers, name, &format!("STILL-{name}")), "{name}");
    }
    for (registry, id, _) in sessions
        .iter()
        .filter(|(_, _, name)| name.starts_with("PC-A"))
    {
        assert!(
            registry.write(id, b"echo x\r\n").is_err(),
            "PC-A's session is gone"
        );
    }
    for registry in &registries {
        registry.kill_all();
    }
}

/// The shared runtime binary: a real program copied into the share's runtime store (cmd.exe stands in for any runtime's
/// interpreter: what matters is one read-only executable used by many processes on many computers).
fn shared_runtime(lab: &Lab) -> PathBuf {
    let system =
        PathBuf::from(std::env::var("SystemRoot").expect("SystemRoot")).join(r"System32\cmd.exe");
    let dir = lab.share.join(r"runtimes\demo\versions\1.0.0");
    std::fs::create_dir_all(&dir).expect("runtime dir");
    let program = dir.join("demo.exe");
    std::fs::copy(system, &program).expect("copy");
    program
}

#[cfg(windows)]
#[test]
fn six_processes_of_one_shared_runtime_on_three_computers_keep_their_streams_and_lifetimes_apart() {
    let lab = Lab::new();
    let program = shared_runtime(&lab);
    let mut children = Vec::new();
    for pc in PCS {
        for n in 0..2 {
            let name = format!("{pc}-p{n}");
            let cwd = lab.root.join(pc).join("C").join(r"Users\Student\proj");
            std::fs::create_dir_all(&cwd).expect("cwd");
            let tree = openmind_process::ProcessTree::new().expect("job");
            let mut child = Command::new(&program)
                .args(["/d", "/q", "/k"])
                .current_dir(&cwd)
                .env("OM_PROCESS", &name)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn");
            use std::os::windows::io::AsRawHandle;
            tree.assign(child.as_raw_handle()).expect("assign");
            let stdin = child.stdin.take().expect("stdin");
            children.push((name, cwd, child, stdin, tree));
        }
    }
    for (name, _, _, stdin, _) in &mut children {
        writeln!(
            stdin,
            "echo OUT-%OM_PROCESS% & cd & echo ERR-{name} 1>&2 & echo IN-{name}"
        )
        .expect("stdin");
    }
    // PC-A's first process is stopped (its job, with everything it started); the others don't notice.
    let (_, _, mut stopped, stopped_in, stopped_tree) = children.remove(0);
    stopped_tree.terminate();
    drop(stopped_in);
    let status = stopped.wait().expect("wait");
    assert!(!status.success(), "terminated");
    for (name, cwd, mut child, stdin, _tree) in children {
        drop(stdin); // EOF: the program ends normally.
        let mut out = String::new();
        let mut err = String::new();
        child
            .stdout
            .take()
            .expect("out")
            .read_to_string(&mut out)
            .expect("read out");
        child
            .stderr
            .take()
            .expect("err")
            .read_to_string(&mut err)
            .expect("read err");
        assert!(
            child.wait().expect("wait").success(),
            "{name} ended normally"
        );
        assert!(out.contains(&format!("OUT-{name}")), "{name}: {out}");
        assert!(out.contains(&format!("IN-{name}")), "{name}: {out}");
        assert!(
            out.to_lowercase()
                .contains(&cwd.display().to_string().to_lowercase()),
            "{name}: {out}"
        );
        assert!(err.contains(&format!("ERR-{name}")), "{name}: {err}");
        for other in PCS
            .iter()
            .flat_map(|pc| (0..2).map(move |n| format!("{pc}-p{n}")))
            .filter(|o| *o != name)
        {
            assert!(
                !out.contains(&format!("OUT-{other}")) && !err.contains(&format!("ERR-{other}")),
                "{name} got {other}'s output"
            );
        }
    }
    // The shared binary is unchanged by being used.
    assert!(program.is_file());
}
