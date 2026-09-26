//! Startup diagnostics (Milestone 16): how long the app took to get going, written to the app log. The window reports the
//! timing of each of its start-up phases once; this adds the time since the process started and the working-set memory.
//! Only phase names and millisecond counts are logged — no paths, no settings, no keys.

use std::sync::OnceLock;
use std::time::Instant;

static STARTED: OnceLock<Instant> = OnceLock::new();

/// Called first thing in `main`.
pub fn mark_process_start() {
    let _ = STARTED.set(Instant::now());
}

/// Milliseconds since `mark_process_start` (0 if it was never called).
pub fn since_start_ms() -> u64 {
    STARTED
        .get()
        .map(|started| u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// The process's working set in megabytes (Windows only; `None` elsewhere).
#[cfg(windows)]
pub fn working_set_mb() -> Option<u64> {
    use winapi::um::processthreadsapi::GetCurrentProcess;
    use winapi::um::psapi::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};

    // SAFETY: `counters` is a properly sized, zeroed PROCESS_MEMORY_COUNTERS that lives for the whole call, and
    // GetCurrentProcess returns a pseudo-handle that needs no closing.
    unsafe {
        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        let size = u32::try_from(std::mem::size_of::<PROCESS_MEMORY_COUNTERS>()).ok()?;
        counters.cb = size;
        if GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, size) == 0 {
            return None;
        }
        Some((counters.WorkingSetSize as u64) / (1024 * 1024))
    }
}

#[cfg(not(windows))]
pub fn working_set_mb() -> Option<u64> {
    None
}

/// Keeps only well-formed marks: a short name of letters, digits and `-_.:`, at most 40 marks. Anything else is dropped,
/// so the log can't be filled with arbitrary text from the window.
pub fn clean_marks(marks: Vec<(String, u64)>) -> Vec<(String, u64)> {
    marks
        .into_iter()
        .filter(|(name, _)| {
            !name.is_empty()
                && name.len() <= 40
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
        })
        .take(40)
        .collect()
}

/// One line: `startup: usable at 812 ms (process 1180 ms) | phases: settings=40 editor=95 ... | memory 62 MB`.
pub fn describe(
    marks: &[(String, u64)],
    usable_ms: u64,
    process_ms: u64,
    memory: Option<u64>,
) -> String {
    let phases: Vec<String> = marks
        .iter()
        .map(|(name, ms)| format!("{name}={ms}"))
        .collect();
    let memory = memory.map_or(String::new(), |mb| format!(" | working set {mb} MB"));
    format!(
        "startup: window usable after {usable_ms} ms (process {process_ms} ms) | phases (ms): {}{memory}",
        phases.join(" ")
    )
}

/// The window reports how long its start-up phases took; the line goes to the app log and back to the caller.
#[tauri::command]
pub fn startup_report(marks: Vec<(String, u64)>, usable_ms: u64) -> String {
    let line = describe(
        &clean_marks(marks),
        usable_ms,
        since_start_ms(),
        working_set_mb(),
    );
    tracing::info!("{line}");
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_phase_names_are_kept() {
        let marks = clean_marks(vec![
            ("settings".into(), 40),
            ("C:\\Users\\me\\secret".into(), 1),
            ("api_key=sk-123 abc".into(), 2),
            (String::new(), 3),
            ("x".repeat(41), 4),
            ("editor.ready".into(), 95),
        ]);
        assert_eq!(
            marks,
            vec![
                ("settings".to_string(), 40),
                ("editor.ready".to_string(), 95)
            ]
        );
        assert_eq!(
            clean_marks((0..100).map(|i| (format!("m{i}"), i)).collect()).len(),
            40
        );
    }

    #[test]
    fn the_line_has_times_and_memory_and_nothing_else() {
        let line = describe(
            &[("settings".into(), 40), ("editor".into(), 95)],
            812,
            1180,
            Some(62),
        );
        assert_eq!(
            line,
            "startup: window usable after 812 ms (process 1180 ms) | phases (ms): settings=40 editor=95 | working set 62 MB"
        );
        assert!(!describe(&[], 1, 2, None).contains("working set"));
    }

    #[test]
    fn the_clock_only_moves_forward() {
        mark_process_start();
        let first = since_start_ms();
        assert!(since_start_ms() >= first);
    }

    #[cfg(windows)]
    #[test]
    fn the_working_set_of_this_test_process_is_readable() {
        assert!(working_set_mb().is_some_and(|mb| mb > 0));
    }
}
