use regex::Regex;
use serde::Serialize;

/// Characters of context kept before / after a match in the result preview.
const CONTEXT_BEFORE: usize = 60;
const CONTEXT_AFTER: usize = 200;

/// One match, positioned the way Monaco addresses text (1-based line and
/// column, columns counted in UTF-16 units) plus a short preview of its line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    pub line: u32,
    pub column: u32,
    /// Length of the matched text, in UTF-16 units.
    pub length: u32,
    pub preview: String,
    /// Where the match sits inside `preview` (UTF-16 offsets), for highlighting.
    pub preview_start: u32,
    pub preview_end: u32,
}

/// Every non-empty match of `regex` in `text`, one entry per match, in order.
/// Stops once `budget` matches were produced (returning `true` = budget hit)
/// or `cancelled` says so.
pub fn find_matches(
    text: &str,
    regex: &Regex,
    budget: usize,
    cancelled: &dyn Fn() -> bool,
    out: &mut Vec<LineMatch>,
) -> bool {
    for (index, line) in text.lines().enumerate() {
        if index % 1024 == 0 && cancelled() {
            return false;
        }
        for found in regex.find_iter(line) {
            if found.is_empty() {
                continue;
            }
            if out.len() >= budget {
                return true;
            }
            out.push(line_match(index, line, found.start(), found.end()));
        }
    }
    false
}

fn line_match(index: usize, line: &str, start: usize, end: usize) -> LineMatch {
    let matched = &line[start..end];
    let (preview, preview_start, preview_end) = preview(line, start, end);
    LineMatch {
        line: u32::try_from(index + 1).unwrap_or(u32::MAX),
        column: utf16_len(&line[..start]) + 1,
        length: utf16_len(matched),
        preview,
        preview_start,
        preview_end,
    }
}

fn utf16_len(text: &str) -> u32 {
    if text.is_ascii() {
        u32::try_from(text.len()).unwrap_or(u32::MAX)
    } else {
        u32::try_from(text.encode_utf16().count()).unwrap_or(u32::MAX)
    }
}

/// A window of the line around the match: leading indentation dropped, long
/// lines cut with an ellipsis on the side that was cut.
fn preview(line: &str, start: usize, end: usize) -> (String, u32, u32) {
    let head = &line[..start];
    let matched: String = line[start..end].chars().take(CONTEXT_AFTER).collect();
    let tail = &line[end..];

    let head_chars = head.chars().count();
    let kept_head = if head_chars > CONTEXT_BEFORE {
        let skip = head_chars - CONTEXT_BEFORE;
        format!("…{}", head.chars().skip(skip).collect::<String>())
    } else {
        head.trim_start().to_string()
    };
    let mut kept_tail: String = tail.chars().take(CONTEXT_AFTER).collect();
    if tail.chars().count() > CONTEXT_AFTER {
        kept_tail.push('…');
    }

    let preview_start = utf16_len(&kept_head);
    let preview_end = preview_start + utf16_len(&matched);
    (
        format!("{kept_head}{matched}{kept_tail}"),
        preview_start,
        preview_end,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn regex(pattern: &str) -> Regex {
        Regex::new(pattern).expect("regex")
    }

    fn all(text: &str, pattern: &str) -> Vec<LineMatch> {
        let mut out = Vec::new();
        find_matches(text, &regex(pattern), 100, &|| false, &mut out);
        out
    }

    #[test]
    fn matches_are_positioned_by_one_based_line_and_column() {
        let found = all("first\n  second needle here\nneedle", "needle");

        assert_eq!(found.len(), 2);
        assert_eq!(
            (found[0].line, found[0].column, found[0].length),
            (2, 10, 6)
        );
        assert_eq!((found[1].line, found[1].column), (3, 1));
    }

    #[test]
    fn columns_count_utf16_units_like_monaco_does() {
        // "é" is one UTF-16 unit; "😀" is two.
        let found = all("é😀x", "x");

        assert_eq!(found[0].column, 4);
        assert_eq!(all("😀", "😀")[0].length, 2);
    }

    #[test]
    fn several_matches_on_one_line_are_all_reported() {
        let found = all("ab ab ab", "ab");

        assert_eq!(
            found.iter().map(|m| m.column).collect::<Vec<_>>(),
            [1, 4, 7]
        );
    }

    #[test]
    fn empty_matches_are_skipped() {
        assert!(all("abc", "x*").is_empty());
    }

    #[test]
    fn the_preview_drops_indentation_and_marks_the_match() {
        let found = &all("      let value = 1;", "value")[0];

        assert_eq!(found.preview, "let value = 1;");
        let chars: Vec<u16> = found.preview.encode_utf16().collect();
        let marked = String::from_utf16_lossy(
            &chars[found.preview_start as usize..found.preview_end as usize],
        );
        assert_eq!(marked, "value");
    }

    #[test]
    fn a_very_long_line_is_cut_with_ellipses_around_the_match() {
        let line = format!("{}NEEDLE{}", "a".repeat(500), "b".repeat(500));

        let found = &all(&line, "NEEDLE")[0];

        assert!(found.preview.starts_with('…'));
        assert!(found.preview.ends_with('…'));
        assert!(found.preview.chars().count() < 300);
        assert_eq!(found.column, 501);
    }

    #[test]
    fn the_match_budget_stops_the_scan_and_says_so() {
        let mut out = Vec::new();

        let hit = find_matches("a a a a a", &regex("a"), 3, &|| false, &mut out);

        assert!(hit);
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn cancellation_stops_the_scan() {
        let mut out = Vec::new();

        let hit = find_matches("a\na\na", &regex("a"), 100, &|| true, &mut out);

        assert!(!hit);
        assert!(out.is_empty());
    }
}
