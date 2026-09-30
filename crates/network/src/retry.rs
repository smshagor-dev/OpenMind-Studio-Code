//! Retrying a download: each address a few times with a growing pause (only for failures a retry can fix), then the
//! next mirror. A failure only the user can fix (proxy authentication, cancel) stops at once. No hidden loops: the
//! number of attempts is bounded and every retry is logged.

use std::time::Duration;

use crate::problem::{NetError, NetProblem};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Attempts per address (at least 1).
    pub attempts: u32,
    /// The pause before the second attempt; it doubles each time.
    pub first_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        RetryPolicy {
            attempts: 3,
            first_delay: Duration::from_secs(1),
        }
    }
}

/// Runs `attempt` against each URL in order until one succeeds. `sleep` is injected so tests don't wait.
pub fn with_mirrors<T>(
    urls: &[String],
    policy: RetryPolicy,
    sleep: &mut dyn FnMut(Duration),
    cancelled: &dyn Fn() -> bool,
    attempt: &mut dyn FnMut(&str) -> Result<T, NetError>,
) -> Result<T, NetError> {
    let mut last = NetError::new(NetProblem::Other, "no download address");
    for url in urls {
        let mut delay = policy.first_delay;
        for round in 1..=policy.attempts.max(1) {
            if cancelled() {
                return Err(NetError::new(NetProblem::Cancelled, "cancelled"));
            }
            match attempt(url) {
                Ok(value) => return Ok(value),
                Err(error) => {
                    if error.problem.fatal() {
                        return Err(error);
                    }
                    let again = error.problem.retryable() && round < policy.attempts;
                    tracing::warn!(url = %crate::redact::log_url(url), round, problem = ?error.problem, again, "download attempt failed");
                    last = error;
                    if !again {
                        break;
                    }
                    sleep(delay);
                    delay = delay.saturating_mul(2);
                }
            }
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn urls(list: &[&str]) -> Vec<String> {
        list.iter().map(|u| (*u).to_string()).collect()
    }

    #[test]
    fn a_timeout_is_retried_with_growing_pauses_then_succeeds() {
        let mut calls = 0;
        let mut slept = Vec::new();
        let result = with_mirrors(
            &urls(&["https://a"]),
            RetryPolicy::default(),
            &mut |d| slept.push(d),
            &|| false,
            &mut |_| {
                calls += 1;
                if calls < 3 {
                    Err(NetError::new(NetProblem::Timeout, "t"))
                } else {
                    Ok(calls)
                }
            },
        );
        assert_eq!(result, Ok(3));
        assert_eq!(slept, vec![Duration::from_secs(1), Duration::from_secs(2)]);
    }

    #[test]
    fn a_checksum_or_404_moves_to_the_next_mirror_without_waiting() {
        let mut tried = Vec::new();
        let mut slept = 0;
        let result = with_mirrors(
            &urls(&["https://a", "https://b", "https://c"]),
            RetryPolicy::default(),
            &mut |_| slept += 1,
            &|| false,
            &mut |url| {
                tried.push(url.to_string());
                match url {
                    "https://a" => Err(NetError::new(NetProblem::Checksum, "bad")),
                    "https://b" => Err(NetError::status(404, url)),
                    _ => Ok("c"),
                }
            },
        );
        assert_eq!(result, Ok("c"));
        assert_eq!(tried, vec!["https://a", "https://b", "https://c"]);
        assert_eq!(slept, 0);
    }

    #[test]
    fn proxy_authentication_stops_everything_and_the_last_error_is_returned() {
        let mut tried = 0;
        let result: Result<(), _> = with_mirrors(
            &urls(&["https://a", "https://b"]),
            RetryPolicy::default(),
            &mut |_| {},
            &|| false,
            &mut |url| {
                tried += 1;
                Err(NetError::status(407, url))
            },
        );
        assert_eq!(
            result.map_err(|e| e.problem),
            Err(NetProblem::ProxyAuthRequired)
        );
        assert_eq!(tried, 1);
        let exhausted: Result<(), _> = with_mirrors(
            &urls(&["https://a"]),
            RetryPolicy {
                attempts: 2,
                first_delay: Duration::ZERO,
            },
            &mut |_| {},
            &|| false,
            &mut |_| Err(NetError::new(NetProblem::Timeout, "t")),
        );
        assert_eq!(exhausted.map_err(|e| e.problem), Err(NetProblem::Timeout));
        let cancelled: Result<(), _> = with_mirrors(
            &urls(&["https://a"]),
            RetryPolicy::default(),
            &mut |_| {},
            &|| true,
            &mut |_| Ok(()),
        );
        assert_eq!(cancelled.map_err(|e| e.problem), Err(NetProblem::Cancelled));
    }
}
