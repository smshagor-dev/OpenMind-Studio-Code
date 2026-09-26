//! Version ordering for the "latest bundled stable" rule and the last-N cap. Versions look like `3.14.7`, `2.9.0`
//! or `1.0.0-rc1`; anything that doesn't parse sorts below every version that does.

use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Key {
    numbers: Vec<u64>,
    stable: bool,
}

fn key(version: &str) -> Option<Key> {
    let trimmed = version.trim().trim_start_matches('v');
    let (core, pre) = match trimmed.split_once(['-', '+']) {
        Some((core, rest)) => (core, Some(rest)),
        None => (trimmed, None),
    };
    let numbers: Option<Vec<u64>> = core.split('.').map(|part| part.parse().ok()).collect();
    let numbers = numbers.filter(|n| !n.is_empty())?;
    // `+build` metadata doesn't make a release unstable; `-rc1`, `-beta` do.
    let stable = pre.is_none() || trimmed.contains('+') && !trimmed.contains('-');
    Some(Key { numbers, stable })
}

/// Orders two version strings (`Less` = `a` is older).
pub fn compare(a: &str, b: &str) -> Ordering {
    match (key(a), key(b)) {
        (Some(x), Some(y)) => {
            let len = x.numbers.len().max(y.numbers.len());
            for i in 0..len {
                let l = x.numbers.get(i).copied().unwrap_or(0);
                let r = y.numbers.get(i).copied().unwrap_or(0);
                if l != r {
                    return l.cmp(&r);
                }
            }
            x.stable.cmp(&y.stable)
        }
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => a.cmp(b),
    }
}

/// Whether a version is a pre-release (`-rc1`, `-beta`...).
pub fn is_stable(version: &str) -> bool {
    key(version).is_some_and(|k| k.stable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_parts_compare_as_numbers() {
        assert_eq!(compare("2.10.0", "2.9.9"), Ordering::Greater);
        assert_eq!(compare("3.14", "3.14.0"), Ordering::Equal);
        assert_eq!(compare("1.0.0-rc1", "1.0.0"), Ordering::Less);
        assert_eq!(compare("junk", "0.0.1"), Ordering::Less);
    }

    #[test]
    fn prereleases_are_not_stable() {
        assert!(is_stable("2.7.9"));
        assert!(is_stable("v2.7.9"));
        assert!(!is_stable("2.8.0-beta.1"));
        assert!(!is_stable("nonsense"));
    }
}
