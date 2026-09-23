/// The dominant line-ending style found in a document, or `Mixed` when more
/// than one style is present. Detection counts occurrences of each style;
/// `Lf` is the default for content with no line breaks at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LineEnding {
    Lf,
    Crlf,
    Cr,
    Mixed,
}

impl LineEnding {
    pub fn as_str(self) -> &'static str {
        match self {
            LineEnding::Lf | LineEnding::Mixed => "\n",
            LineEnding::Crlf => "\r\n",
            LineEnding::Cr => "\r",
        }
    }
}

pub fn detect(text: &str) -> LineEnding {
    let bytes = text.as_bytes();
    let mut crlf = 0usize;
    let mut lf_only = 0usize;
    let mut cr_only = 0usize;

    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                crlf += 1;
                i += 2;
            }
            b'\r' => {
                cr_only += 1;
                i += 1;
            }
            b'\n' => {
                lf_only += 1;
                i += 1;
            }
            _ => i += 1,
        }
    }

    let styles_present = [crlf > 0, lf_only > 0, cr_only > 0]
        .into_iter()
        .filter(|present| *present)
        .count();

    if styles_present > 1 {
        LineEnding::Mixed
    } else if crlf > 0 {
        LineEnding::Crlf
    } else if cr_only > 0 {
        LineEnding::Cr
    } else {
        LineEnding::Lf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_lf() {
        assert_eq!(detect("a\nb\nc"), LineEnding::Lf);
    }

    #[test]
    fn detects_crlf() {
        assert_eq!(detect("a\r\nb\r\nc"), LineEnding::Crlf);
    }

    #[test]
    fn detects_cr() {
        assert_eq!(detect("a\rb\rc"), LineEnding::Cr);
    }

    #[test]
    fn detects_mixed() {
        assert_eq!(detect("a\r\nb\nc"), LineEnding::Mixed);
    }

    #[test]
    fn defaults_to_lf_when_no_line_breaks() {
        assert_eq!(detect("no line breaks here"), LineEnding::Lf);
        assert_eq!(detect(""), LineEnding::Lf);
    }
}
