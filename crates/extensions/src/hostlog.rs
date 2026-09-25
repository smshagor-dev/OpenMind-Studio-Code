//! `extensions/logs/extension-host.log`: what the host and the extensions print, one timestamped line each.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// The log is rotated to `.1` past this size.
const MAX_BYTES: u64 = 2 * 1024 * 1024;

pub struct HostLog {
    path: PathBuf,
    lock: Mutex<()>,
}

impl HostLog {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    /// Appends one line (a failure to write is logged, never raised: logging must not break the host).
    pub fn line(&self, text: &str) {
        let Ok(_guard) = self.lock.lock() else {
            return;
        };
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::metadata(&self.path).is_ok_and(|meta| meta.len() > MAX_BYTES) {
            let _ = fs::rename(&self.path, self.path.with_extension("log.1"));
        }
        let result = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut file| {
                writeln!(file, "{} {}", timestamp(), text.replace(['\r', '\n'], " "))
            });
        if let Err(err) = result {
            tracing::warn!("couldn't write the extension host log: {err}");
        }
    }

    /// The log's text (empty when there is none yet).
    pub fn read(&self) -> String {
        fs::read_to_string(&self.path).unwrap_or_default()
    }
}

/// `YYYY-MM-DD HH:MM:SS` in UTC.
pub fn timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    format_utc(seconds)
}

fn format_utc(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    // Civil date from a day count (days since 1970-01-01).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_utc_calendar_dates() {
        assert_eq!(format_utc(0), "1970-01-01 00:00:00");
        assert_eq!(format_utc(951_782_400), "2000-02-29 00:00:00");
        assert_eq!(format_utc(1_700_000_000), "2023-11-14 22:13:20");
    }

    #[test]
    fn lines_are_appended_one_per_line_and_read_back() {
        let dir = tempfile::tempdir().expect("tempdir");
        let log = HostLog::new(dir.path().join("logs").join("extension-host.log"));
        assert_eq!(log.read(), "");
        log.line("first");
        log.line("second\nwith a break");
        let text = log.read();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with(" first"));
        assert!(lines[1].ends_with("second with a break"));
    }
}
