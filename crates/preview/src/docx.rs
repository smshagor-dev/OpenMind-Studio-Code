//! A read-only, partial DOCX preview: the body's paragraphs, headings, list items and tables as plain text, plus
//! a few metadata fields. No layout, no comments or tracked-change editing, no embedded images (they are counted),
//! and macros are never run (a macro project is only reported).

use roxmltree::Node;
use serde::Serialize;

use crate::error::PreviewError;
use crate::zipsafe::{attr, has_part, open, parse_xml, read_part};

const MAX_BLOCKS: usize = 20_000;
const MAX_CHARS: usize = 2_000_000;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DocxBlock {
    Paragraph {
        text: String,
        /// 1-6 for a heading.
        heading: Option<u8>,
        list: bool,
    },
    Table {
        rows: Vec<Vec<String>>,
    },
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocMetadata {
    pub title: Option<String>,
    pub author: Option<String>,
    pub created: Option<String>,
    pub modified: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocxModel {
    pub blocks: Vec<DocxBlock>,
    pub metadata: DocMetadata,
    /// Embedded pictures found (not shown).
    pub image_count: usize,
    /// The package carries a macro project; nothing was run.
    pub has_macros: bool,
    /// The document is longer than the preview shows.
    pub truncated: bool,
}

fn paragraph_text(paragraph: Node<'_, '_>) -> String {
    let mut text = String::new();
    for node in paragraph.descendants().filter(Node::is_element) {
        match node.tag_name().name() {
            "t" => text.push_str(node.text().unwrap_or("")),
            "tab" => text.push('\t'),
            "br" | "cr" => text.push('\n'),
            _ => {}
        }
    }
    text
}

fn heading_level(paragraph: Node<'_, '_>) -> Option<u8> {
    let style = paragraph
        .children()
        .find(|node| node.has_tag_name("pPr"))?
        .children()
        .find(|node| node.has_tag_name("pStyle"))
        .and_then(|node| attr(node, "val"))?
        .to_ascii_lowercase()
        .replace(' ', "");
    if style == "title" {
        return Some(1);
    }
    if style == "subtitle" {
        return Some(2);
    }
    let digits = style.strip_prefix("heading")?;
    let level: u8 = digits.parse().ok()?;
    (1..=6).contains(&level).then_some(level)
}

fn is_list_item(paragraph: Node<'_, '_>) -> bool {
    paragraph
        .children()
        .find(|node| node.has_tag_name("pPr"))
        .is_some_and(|props| props.children().any(|node| node.has_tag_name("numPr")))
}

fn table_rows(table: Node<'_, '_>) -> Vec<Vec<String>> {
    table
        .children()
        .filter(|node| node.has_tag_name("tr"))
        .map(|row| {
            row.children()
                .filter(|node| node.has_tag_name("tc"))
                .map(|cell| {
                    cell.descendants()
                        .filter(|node| node.has_tag_name("p"))
                        .map(paragraph_text)
                        .filter(|text| !text.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .collect()
        })
        .collect()
}

struct Collector {
    blocks: Vec<DocxBlock>,
    chars: usize,
    truncated: bool,
}

impl Collector {
    fn push(&mut self, block: DocxBlock, size: usize) {
        if self.blocks.len() >= MAX_BLOCKS || self.chars + size > MAX_CHARS {
            self.truncated = true;
            return;
        }
        self.chars += size;
        self.blocks.push(block);
    }

    fn walk(&mut self, parent: Node<'_, '_>) {
        for node in parent.children().filter(Node::is_element) {
            match node.tag_name().name() {
                "p" => {
                    let text = paragraph_text(node);
                    if text.trim().is_empty() {
                        continue;
                    }
                    let size = text.len();
                    self.push(
                        DocxBlock::Paragraph {
                            heading: heading_level(node),
                            list: is_list_item(node),
                            text,
                        },
                        size,
                    );
                }
                "tbl" => {
                    let rows = table_rows(node);
                    let size = rows.iter().flatten().map(String::len).sum();
                    self.push(DocxBlock::Table { rows }, size);
                }
                // Content controls and similar wrappers hold ordinary blocks.
                "sdt" | "sdtContent" | "customXml" | "ins" => self.walk(node),
                _ => {}
            }
        }
    }
}

fn metadata(core: Option<String>) -> DocMetadata {
    let Some(text) = core else {
        return DocMetadata::default();
    };
    let Ok(doc) = parse_xml(&text) else {
        return DocMetadata::default();
    };
    let field = |name: &str| {
        doc.descendants()
            .find(|node| node.has_tag_name(name))
            .and_then(|node| node.text())
            .map(str::to_string)
            .filter(|value| !value.trim().is_empty())
    };
    DocMetadata {
        title: field("title"),
        author: field("creator"),
        created: field("created"),
        modified: field("modified"),
    }
}

/// Builds the preview of a `.docx` file.
pub fn read_docx(raw: &str) -> Result<DocxModel, PreviewError> {
    let mut archive = open(raw)?;
    let body = read_part(&mut archive, "word/document.xml")?.ok_or_else(|| {
        PreviewError::Malformed("This isn't a Word document (word/document.xml is missing).".into())
    })?;
    let core = read_part(&mut archive, "docProps/core.xml").unwrap_or(None);
    let has_macros = has_part(&mut archive, "word/vbaProject.bin");
    let doc = parse_xml(&body)?;
    let mut collector = Collector {
        blocks: Vec::new(),
        chars: 0,
        truncated: false,
    };
    if let Some(body) = doc.descendants().find(|node| node.has_tag_name("body")) {
        collector.walk(body);
    }
    let image_count = doc
        .descendants()
        .filter(|node| node.has_tag_name("blip") || node.has_tag_name("imagedata"))
        .count();
    Ok(DocxModel {
        blocks: collector.blocks,
        metadata: metadata(core),
        image_count,
        has_macros,
        truncated: collector.truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::zip_with;

    const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

    fn document(body: &str) -> String {
        format!(r#"<w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>"#)
    }

    #[test]
    fn paragraphs_headings_lists_tables_and_metadata_are_read() {
        let dir = tempfile::tempdir().expect("tempdir");
        let body = document(
            r#"<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title &amp; more</w:t></w:r></w:p>
               <w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/><w:t>world</w:t></w:r></w:p>
               <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>item</w:t></w:r></w:p>
               <w:p><w:r><w:delText>gone</w:delText></w:r></w:p>
               <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#,
        );
        let core = r#"<cp:coreProperties xmlns:cp="c" xmlns:dc="d" xmlns:dcterms="t"><dc:title>My doc</dc:title><dc:creator>Ann</dc:creator><dcterms:created>2024-01-02</dcterms:created></cp:coreProperties>"#;
        let path = zip_with(
            &dir,
            "a b.docx",
            &[("word/document.xml", &body), ("docProps/core.xml", core)],
        );
        let model = read_docx(&path).expect("docx");
        assert_eq!(
            model.blocks,
            vec![
                DocxBlock::Paragraph {
                    text: "Title & more".into(),
                    heading: Some(1),
                    list: false
                },
                DocxBlock::Paragraph {
                    text: "Hello\tworld".into(),
                    heading: None,
                    list: false
                },
                DocxBlock::Paragraph {
                    text: "item".into(),
                    heading: None,
                    list: true
                },
                DocxBlock::Table {
                    rows: vec![vec!["A1".into(), "B1".into()]]
                },
            ]
        );
        assert_eq!(model.metadata.title.as_deref(), Some("My doc"));
        assert_eq!(model.metadata.author.as_deref(), Some("Ann"));
        assert!(!model.has_macros && !model.truncated);
    }

    #[test]
    fn macros_are_reported_never_run_and_pictures_are_counted() {
        let dir = tempfile::tempdir().expect("tempdir");
        let body = document(
            r#"<w:p><w:r><w:t>x</w:t><w:drawing><a:blip xmlns:a="a"/></w:drawing></w:r></w:p>"#,
        );
        let path = zip_with(
            &dir,
            "m.docx",
            &[
                ("word/document.xml", &body),
                ("word/vbaProject.bin", "not code"),
            ],
        );
        let model = read_docx(&path).expect("docx");
        assert!(model.has_macros);
        assert_eq!(model.image_count, 1);
    }

    #[test]
    fn malformed_files_give_errors_not_panics() {
        let dir = tempfile::tempdir().expect("tempdir");
        let not_zip = dir.path().join("bad.docx");
        std::fs::write(&not_zip, b"this is not a zip").expect("write");
        assert!(matches!(
            read_docx(&not_zip.to_string_lossy()),
            Err(PreviewError::Malformed(_))
        ));
        let no_body = zip_with(&dir, "empty.docx", &[("other.xml", "<a/>")]);
        assert!(matches!(
            read_docx(&no_body),
            Err(PreviewError::Malformed(_))
        ));
        let broken = zip_with(&dir, "broken.docx", &[("word/document.xml", "<w:document")]);
        assert!(matches!(
            read_docx(&broken),
            Err(PreviewError::Malformed(_))
        ));
        // A DTD (entity expansion attempt) is refused, not expanded.
        let dtd = zip_with(
            &dir,
            "dtd.docx",
            &[(
                "word/document.xml",
                r#"<!DOCTYPE d [<!ENTITY x "boom">]><w:document xmlns:w="w"><w:body/></w:document>"#,
            )],
        );
        assert!(matches!(read_docx(&dtd), Err(PreviewError::Malformed(_))));
    }
}
