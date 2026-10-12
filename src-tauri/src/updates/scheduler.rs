//! The automatic update check: once, a little after start-up, then every few hours; after a failure again sooner, with a
//! growing pause (`policy::backoff`), never in a tight loop and never on a UI action. Offline is just a failed check:
//! the app keeps working and asks again later.

use std::time::Duration;

use tauri::{AppHandle, Manager};

use super::policy::{self, SelfUpdate};
use super::{flow, UpdateState};

/// The pause before the first check (shorter in a development build when `OPENMIND_UPDATE_FIRST_CHECK_SECS` is set, so
/// the update path can be tested end to end).
fn first_delay() -> Duration {
    if cfg!(debug_assertions) {
        if let Some(seconds) = std::env::var("OPENMIND_UPDATE_FIRST_CHECK_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
        {
            return Duration::from_secs(seconds);
        }
    }
    policy::FIRST_CHECK_DELAY
}

/// Starts the schedule (once, from the main window's setup).
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(first_delay()).await;
        let mut failures = 0u32;
        loop {
            let pause = match cycle(&app).await {
                Ok(()) => {
                    failures = 0;
                    policy::CHECK_INTERVAL
                }
                Err(err) => {
                    failures += 1;
                    tracing::info!(failures, %err, "update check failed; trying again later");
                    policy::backoff(failures)
                }
            };
            tokio::time::sleep(pause).await;
        }
    });
}

/// One round: check, and — when automatic updates are on and this copy updates itself — download and verify.
async fn cycle(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<UpdateState>();
    if state.pending.lock().ok().is_some_and(|p| p.is_some()) {
        return Ok(()); // downloaded and verified already; it is installed at the next close
    }
    let found = flow::check(app).await?;
    if !found || !super::automatic(app) {
        return Ok(());
    }
    if let SelfUpdate::Managed(_) = super::mode(app) {
        return Ok(()); // a shared installation: its computers are only told
    }
    flow::download(app).await
}
