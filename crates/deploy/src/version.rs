//! Version numbers as OpenMind Studio's releases spell them (`1.0.3`, `1.1.0-beta.2`): checked, and compared the way
//! semantic versioning does (numbers left to right; a pre-release is older than its release).

use std::cmp::Ordering;

/// At most this long (an announcement is small and untrusted).
const MAX_LEN: usize = 32;

/// Whether `text` is a version this protocol accepts: `MAJOR.MINOR.PATCH` with an optional `-pre.release` part of
/// letters, digits and dots. Nothing else (no build metadata, no spaces, no path characters).
pub fn is_valid(text: &str) -> bool {
    if text.is_empty() || text.len() > MAX_LEN {
        return false;
    }
    let (core, pre) = match text.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (text, None),
    };
    let numbers: Vec<&str> = core.split('.').collect();
    let numbers_ok = numbers.len() == 3
        && numbers.iter().all(|n| {
            !n.is_empty()
                && n.len() <= 6
                && n.bytes().all(|b| b.is_ascii_digit())
                && (n.len() == 1 || !n.starts_with('0'))
        });
    let pre_ok = pre.is_none_or(|pre| {
        !pre.is_empty()
            && pre
                .split('.')
                .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric()))
    });
    numbers_ok && pre_ok
}

fn split(text: &str) -> (Vec<u64>, Option<Vec<&str>>) {
    let (core, pre) = match text.split_once('-') {
        Some((core, pre)) => (core, Some(pre.split('.').collect())),
        None => (text, None),
    };
    (
        core.split('.')
            .map(|n| n.parse::<u64>().unwrap_or(0))
            .collect(),
        pre,
    )
}

/// Compares two valid versions (an invalid one sorts as `0.0.0`).
pub fn compare(a: &str, b: &str) -> Ordering {
    let (a_core, a_pre) = split(a);
    let (b_core, b_pre) = split(b);
    a_core.cmp(&b_core).then_with(|| match (a_pre, b_pre) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(a), Some(b)) => compare_pre(&a, &b),
    })
}

fn compare_pre(a: &[&str], b: &[&str]) -> Ordering {
    for (x, y) in a.iter().zip(b.iter()) {
        let order = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(x), Ok(y)) => x.cmp(&y),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => x.cmp(y),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    a.len().cmp(&b.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_release_style_versions_are_accepted() {
        for good in ["1.0.3", "0.0.0", "10.20.30", "1.1.0-beta.2", "2.0.0-rc1"] {
            assert!(is_valid(good), "{good}");
        }
        for bad in [
            "",
            "1.0",
            "1.0.3.4",
            "v1.0.3",
            "1.0.3 ",
            "01.0.0",
            "1.0.x",
            "1.0.3+build",
            "1.0.3-",
            "1.0.3-a..b",
            "../1.0.0",
            "1.0.3-a/b",
            "9999999.0.0",
        ] {
            assert!(!is_valid(bad), "{bad}");
        }
    }

    #[test]
    fn versions_compare_like_semantic_versioning() {
        assert_eq!(compare("1.0.3", "1.0.2"), Ordering::Greater);
        assert_eq!(compare("1.0.10", "1.0.9"), Ordering::Greater);
        assert_eq!(compare("1.1.0", "1.0.99"), Ordering::Greater);
        assert_eq!(compare("1.0.3", "1.0.3"), Ordering::Equal);
        assert_eq!(compare("1.0.3-beta.1", "1.0.3"), Ordering::Less);
        assert_eq!(compare("1.0.3-beta.2", "1.0.3-beta.10"), Ordering::Less);
        assert_eq!(compare("1.0.3-beta", "1.0.3-alpha"), Ordering::Greater);
        assert_eq!(compare("1.0.3-1", "1.0.3-alpha"), Ordering::Less);
    }
}
