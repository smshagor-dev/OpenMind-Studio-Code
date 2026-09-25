//! A read-only, partial XLSX preview: the sheet list and the cell values of one sheet (its first rows and columns).
//! Formulas are never evaluated (the cached value is shown; a formula without one is shown as its text), charts,
//! pivots and macros are ignored, and a macro project is only reported, never run.

use std::collections::HashMap;

use roxmltree::Node;
use serde::Serialize;

use crate::error::PreviewError;
use crate::zipsafe::{attr, has_part, open, parse_xml, read_part, Archive};

/// Rows and columns kept per sheet (the counts of the whole sheet are still reported).
pub const MAX_ROWS: usize = 1_000;
pub const MAX_COLS: usize = 100;
const MAX_SHARED_STRINGS: usize = 500_000;
const MAX_SHEETS: usize = 200;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SheetModel {
    pub name: String,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    pub total_cols: usize,
    pub truncated_rows: bool,
    pub truncated_cols: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct XlsxModel {
    pub sheets: Vec<String>,
    pub selected: usize,
    pub sheet: SheetModel,
    pub has_macros: bool,
}

/// `B3` -> (row 2, column 1), zero-based.
fn cell_position(reference: &str) -> Option<(usize, usize)> {
    let letters: String = reference
        .chars()
        .take_while(char::is_ascii_alphabetic)
        .collect();
    let digits = &reference[letters.len()..];
    if letters.is_empty() || letters.len() > 3 || digits.is_empty() {
        return None;
    }
    let col = letters
        .to_ascii_uppercase()
        .bytes()
        .fold(0usize, |acc, b| acc * 26 + usize::from(b - b'A') + 1)
        - 1;
    let row: usize = digits.parse().ok()?;
    Some((row.checked_sub(1)?, col))
}

fn shared_strings(archive: &mut Archive) -> Result<Vec<String>, PreviewError> {
    let Some(text) = read_part(archive, "xl/sharedStrings.xml")? else {
        return Ok(Vec::new());
    };
    let doc = parse_xml(&text)?;
    let mut strings = Vec::new();
    for item in doc.descendants().filter(|node| node.has_tag_name("si")) {
        if strings.len() >= MAX_SHARED_STRINGS {
            break;
        }
        let value: String = item
            .descendants()
            .filter(|node| node.has_tag_name("t"))
            // Phonetic guides (`rPh`) are not part of the visible text.
            .filter(|node| !node.ancestors().any(|up| up.has_tag_name("rPh")))
            .filter_map(|node| node.text())
            .collect();
        strings.push(value);
    }
    Ok(strings)
}

/// (sheet name, part path) in workbook order.
fn sheet_parts(archive: &mut Archive) -> Result<Vec<(String, String)>, PreviewError> {
    let workbook = read_part(archive, "xl/workbook.xml")?.ok_or_else(|| {
        PreviewError::Malformed("This isn't an Excel workbook (xl/workbook.xml is missing).".into())
    })?;
    let rels_text = read_part(archive, "xl/_rels/workbook.xml.rels")?.unwrap_or_default();
    let mut targets: HashMap<String, String> = HashMap::new();
    if !rels_text.is_empty() {
        let rels = parse_xml(&rels_text)?;
        for rel in rels
            .descendants()
            .filter(|node| node.has_tag_name("Relationship"))
        {
            if let (Some(id), Some(target)) = (attr(rel, "Id"), attr(rel, "Target")) {
                let path = match target.strip_prefix('/') {
                    Some(absolute) => absolute.to_string(),
                    None => format!("xl/{target}"),
                };
                targets.insert(id.to_string(), path);
            }
        }
    }
    let doc = parse_xml(&workbook)?;
    let mut sheets = Vec::new();
    for (index, sheet) in doc
        .descendants()
        .filter(|node| node.has_tag_name("sheet"))
        .take(MAX_SHEETS)
        .enumerate()
    {
        let name = attr(sheet, "name").unwrap_or("Sheet").to_string();
        let path = attr(sheet, "id")
            .and_then(|id| targets.get(id))
            .cloned()
            .unwrap_or_else(|| format!("xl/worksheets/sheet{}.xml", index + 1));
        sheets.push((name, path));
    }
    if sheets.is_empty() {
        return Err(PreviewError::Malformed(
            "This workbook has no sheets.".into(),
        ));
    }
    Ok(sheets)
}

fn cell_value(cell: Node<'_, '_>, shared: &[String]) -> String {
    let kind = attr(cell, "t").unwrap_or("n");
    let value = cell
        .children()
        .find(|node| node.has_tag_name("v"))
        .and_then(|node| node.text())
        .unwrap_or("");
    let shown = match kind {
        "s" => value
            .parse::<usize>()
            .ok()
            .and_then(|index| shared.get(index))
            .cloned()
            .unwrap_or_default(),
        "inlineStr" => cell
            .descendants()
            .filter(|node| node.has_tag_name("t"))
            .filter_map(|node| node.text())
            .collect(),
        "b" => if value == "1" { "TRUE" } else { "FALSE" }.to_string(),
        _ => value.to_string(),
    };
    if shown.is_empty() {
        if let Some(formula) = cell
            .children()
            .find(|node| node.has_tag_name("f"))
            .and_then(|node| node.text())
        {
            return format!("={formula}");
        }
    }
    shown
}

fn read_sheet(
    archive: &mut Archive,
    name: &str,
    part: &str,
    shared: &[String],
) -> Result<SheetModel, PreviewError> {
    let text = read_part(archive, part)?
        .ok_or_else(|| PreviewError::Malformed(format!("The sheet {name} is missing.")))?;
    let doc = parse_xml(&text)?;
    let mut rows: Vec<Vec<String>> = Vec::new();
    let (mut total_rows, mut total_cols) = (0usize, 0usize);
    for cell in doc.descendants().filter(|node| node.has_tag_name("c")) {
        let Some((row, col)) = attr(cell, "r").and_then(cell_position) else {
            continue;
        };
        let value = cell_value(cell, shared);
        if value.is_empty() {
            continue;
        }
        total_rows = total_rows.max(row + 1);
        total_cols = total_cols.max(col + 1);
        if row < MAX_ROWS && col < MAX_COLS {
            if rows.len() <= row {
                rows.resize_with(row + 1, Vec::new);
            }
            let cells = &mut rows[row];
            if cells.len() <= col {
                cells.resize(col + 1, String::new());
            }
            cells[col] = value;
        }
    }
    // Rectangular for the table: every kept row as wide as the widest kept one.
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    for cells in &mut rows {
        cells.resize(width, String::new());
    }
    Ok(SheetModel {
        name: name.to_string(),
        rows,
        total_rows,
        total_cols,
        truncated_rows: total_rows > MAX_ROWS,
        truncated_cols: total_cols > MAX_COLS,
    })
}

/// Builds the preview of one sheet (zero-based `selected`, clamped) of an `.xlsx` file.
pub fn read_xlsx(raw: &str, selected: usize) -> Result<XlsxModel, PreviewError> {
    let mut archive = open(raw)?;
    let parts = sheet_parts(&mut archive)?;
    let selected = selected.min(parts.len() - 1);
    let shared = shared_strings(&mut archive)?;
    let has_macros = has_part(&mut archive, "xl/vbaProject.bin");
    let (name, part) = &parts[selected];
    let sheet = read_sheet(&mut archive, name, part, &shared)?;
    Ok(XlsxModel {
        sheets: parts.into_iter().map(|(name, _)| name).collect(),
        selected,
        sheet,
        has_macros,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::zip_with;

    const WORKBOOK: &str = r#"<workbook xmlns="m" xmlns:r="r"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Second" sheetId="2" r:id="rId2"/></sheets></workbook>"#;
    const RELS: &str = r#"<Relationships xmlns="p"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>"#;
    const SHARED: &str = r#"<sst xmlns="m"><si><t>Name</t></si><si><r><t>Rich </t></r><r><t>text</t></r><rPh><t>ignored</t></rPh></si></sst>"#;
    const SHEET1: &str = r#"<worksheet xmlns="m"><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>inline</t></is></c></row>
        <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42</v></c><c r="C2" t="b"><v>1</v></c></row>
        <row r="3"><c r="B3"><f>SUM(B2:B2)</f><v>42</v></c><c r="C3"><f>A1&amp;"x"</f></c></row>
        </sheetData></worksheet>"#;
    const SHEET2: &str = r#"<worksheet xmlns="m"><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>"#;

    fn workbook(dir: &tempfile::TempDir, extra: &[(&str, &str)]) -> String {
        let mut parts = vec![
            ("xl/workbook.xml", WORKBOOK),
            ("xl/_rels/workbook.xml.rels", RELS),
            ("xl/sharedStrings.xml", SHARED),
            ("xl/worksheets/sheet1.xml", SHEET1),
            ("xl/worksheets/sheet2.xml", SHEET2),
        ];
        parts.extend_from_slice(extra);
        zip_with(dir, "book one.xlsx", &parts)
    }

    #[test]
    fn positions_parse_and_reject_garbage() {
        assert_eq!(cell_position("A1"), Some((0, 0)));
        assert_eq!(cell_position("AA10"), Some((9, 26)));
        assert_eq!(cell_position("B0"), None);
        assert_eq!(cell_position("12"), None);
        assert_eq!(cell_position("ABCD1"), None);
    }

    #[test]
    fn sheets_values_formulas_and_shared_strings_are_read() {
        let dir = tempfile::tempdir().expect("tempdir");
        let model = read_xlsx(&workbook(&dir, &[]), 0).expect("xlsx");
        assert_eq!(model.sheets, vec!["Data", "Second"]);
        assert_eq!(model.sheet.name, "Data");
        assert_eq!(model.sheet.total_rows, 3);
        assert_eq!(model.sheet.total_cols, 3);
        assert_eq!(model.sheet.rows[0], vec!["Name", "", "inline"]);
        assert_eq!(model.sheet.rows[1], vec!["Rich text", "42", "TRUE"]);
        // A cached value wins; a formula with no cached value shows its text and is not evaluated.
        assert_eq!(model.sheet.rows[2], vec!["", "42", "=A1&\"x\""]);
        let second = read_xlsx(&workbook(&dir, &[]), 1).expect("second");
        assert_eq!(second.sheet.rows, vec![vec!["7"]]);
        let clamped = read_xlsx(&workbook(&dir, &[]), 99).expect("clamped");
        assert_eq!(clamped.selected, 1);
    }

    #[test]
    fn macros_are_reported_not_run_and_big_sheets_are_cut() {
        let dir = tempfile::tempdir().expect("tempdir");
        let model = read_xlsx(&workbook(&dir, &[("xl/vbaProject.bin", "x")]), 0).expect("xlsx");
        assert!(model.has_macros);
        let mut rows = String::new();
        for row in 1..=1500 {
            rows.push_str(&format!(
                r#"<row r="{row}"><c r="A{row}"><v>{row}</v></c><c r="EA{row}"><v>1</v></c></row>"#
            ));
        }
        let big = format!(r#"<worksheet xmlns="m"><sheetData>{rows}</sheetData></worksheet>"#);
        let path = zip_with(
            &dir,
            "big.xlsx",
            &[
                ("xl/workbook.xml", WORKBOOK),
                ("xl/_rels/workbook.xml.rels", RELS),
                ("xl/worksheets/sheet1.xml", &big),
                ("xl/worksheets/sheet2.xml", SHEET2),
            ],
        );
        let model = read_xlsx(&path, 0).expect("big");
        assert_eq!(model.sheet.rows.len(), MAX_ROWS);
        assert_eq!(model.sheet.total_rows, 1500);
        assert!(model.sheet.truncated_rows && model.sheet.truncated_cols);
        assert_eq!(model.sheet.rows[0].len(), 1);
    }

    #[test]
    fn malformed_workbooks_give_errors() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bad = dir.path().join("bad.xlsx");
        std::fs::write(&bad, b"nope").expect("write");
        assert!(matches!(
            read_xlsx(&bad.to_string_lossy(), 0),
            Err(PreviewError::Malformed(_))
        ));
        let no_book = zip_with(&dir, "nobook.xlsx", &[("a.xml", "<a/>")]);
        assert!(read_xlsx(&no_book, 0).is_err());
        let empty = zip_with(
            &dir,
            "nosheets.xlsx",
            &[("xl/workbook.xml", "<workbook><sheets/></workbook>")],
        );
        assert!(read_xlsx(&empty, 0).is_err());
        let broken = zip_with(
            &dir,
            "broken.xlsx",
            &[
                ("xl/workbook.xml", WORKBOOK),
                ("xl/worksheets/sheet1.xml", "<worksheet"),
            ],
        );
        assert!(read_xlsx(&broken, 0).is_err());
    }
}
