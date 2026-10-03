//! Collapses bursts of file events into one announcement per topic. A package manager writing thousands of files
//! becomes one `packages` announcement once it has been quiet for a moment; a burst that never goes quiet (a long
//! install) is still announced every `max_wait`, so the UI isn't stale for minutes.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use crate::topics::SyncTopic;

/// One topic's burst: when its first and last events arrived and how many there were.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Burst {
    pub first: Instant,
    pub last: Instant,
    pub events: usize,
}

#[derive(Debug)]
pub struct TopicCoalescer {
    quiet: Duration,
    max_wait: Duration,
    pending: BTreeMap<SyncTopic, Burst>,
}

impl TopicCoalescer {
    pub fn new(quiet: Duration, max_wait: Duration) -> Self {
        Self {
            quiet,
            max_wait,
            pending: BTreeMap::new(),
        }
    }

    /// One event for `topic` at `now` (any number of events for a topic make one burst).
    pub fn push(&mut self, topic: SyncTopic, now: Instant) {
        self.pending
            .entry(topic)
            .and_modify(|burst| {
                burst.last = now;
                burst.events += 1;
            })
            .or_insert(Burst {
                first: now,
                last: now,
                events: 1,
            });
    }

    /// The topics whose burst is over (quiet for `quiet`) or has gone on for `max_wait`; each is reported once and
    /// forgotten. Topics come out in a fixed order.
    pub fn due(&mut self, now: Instant) -> Vec<(SyncTopic, Burst)> {
        let ready: Vec<SyncTopic> = self
            .pending
            .iter()
            .filter(|(_, burst)| {
                now.saturating_duration_since(burst.last) >= self.quiet
                    || now.saturating_duration_since(burst.first) >= self.max_wait
            })
            .map(|(topic, _)| *topic)
            .collect();
        ready
            .into_iter()
            .filter_map(|topic| self.pending.remove(&topic).map(|burst| (topic, burst)))
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUIET: Duration = Duration::from_millis(500);
    const MAX: Duration = Duration::from_secs(10);

    #[test]
    fn a_thousand_events_of_one_topic_are_one_announcement_after_the_burst() {
        let start = Instant::now();
        let mut coalescer = TopicCoalescer::new(QUIET, MAX);
        for step in 0..1000u64 {
            coalescer.push(SyncTopic::Packages, start + Duration::from_millis(step));
        }
        let last = start + Duration::from_millis(999);
        assert!(coalescer.due(last + Duration::from_millis(100)).is_empty());
        let due = coalescer.due(last + QUIET);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].0, SyncTopic::Packages);
        assert_eq!(due[0].1.events, 1000);
        assert_eq!(due[0].1.first, start);
        assert_eq!(due[0].1.last, last);
        assert!(coalescer.due(last + QUIET * 4).is_empty());
        assert!(coalescer.is_empty());
    }

    #[test]
    fn topics_are_deduplicated_and_kept_apart() {
        let now = Instant::now();
        let mut coalescer = TopicCoalescer::new(QUIET, MAX);
        for topic in [
            SyncTopic::Tools,
            SyncTopic::Runtimes,
            SyncTopic::Tools,
            SyncTopic::Runtimes,
            SyncTopic::Tools,
        ] {
            coalescer.push(topic, now);
        }
        let due: Vec<SyncTopic> = coalescer
            .due(now + QUIET)
            .into_iter()
            .map(|(topic, _)| topic)
            .collect();
        assert_eq!(due, vec![SyncTopic::Runtimes, SyncTopic::Tools]);
    }

    #[test]
    fn a_burst_that_never_goes_quiet_is_still_announced_every_max_wait() {
        let start = Instant::now();
        let mut coalescer = TopicCoalescer::new(QUIET, MAX);
        let mut announced = 0;
        let mut at = start;
        while at < start + Duration::from_secs(25) {
            coalescer.push(SyncTopic::Packages, at);
            announced += coalescer.due(at).len();
            at += Duration::from_millis(100);
        }
        assert_eq!(announced, 2);
    }
}
