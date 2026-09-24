//! The Control Panel's Netstat view: which TCP ports are listening and which
//! process owns each. Parsing is pure (tested on sample text); the command
//! layer runs `netstat -ano -p TCP` and `tasklist` and feeds the text in.

use std::collections::HashMap;

use serde::Serialize;

/// One listening TCP socket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningPort {
    pub address: String,
    pub port: u16,
    pub pid: u32,
    /// The owning process's image name, when `tasklist` knew it.
    pub process: Option<String>,
}

/// Parses `netstat -ano -p TCP` output, keeping only `LISTENING` rows
/// (IPv4 and IPv6), sorted by port then address, without duplicates.
pub fn parse_netstat(text: &str) -> Vec<ListeningPort> {
    let mut rows: Vec<ListeningPort> = text.lines().filter_map(parse_row).collect();
    rows.sort_by(|a, b| (a.port, &a.address, a.pid).cmp(&(b.port, &b.address, b.pid)));
    rows.dedup();
    rows
}

fn parse_row(line: &str) -> Option<ListeningPort> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 5 || !parts[0].eq_ignore_ascii_case("TCP") || parts[3] != "LISTENING" {
        return None;
    }
    let (address, port) = parts[1].rsplit_once(':')?;
    Some(ListeningPort {
        address: address.trim_matches(|c| c == '[' || c == ']').to_string(),
        port: port.parse().ok()?,
        pid: parts[4].parse().ok()?,
        process: None,
    })
}

/// Parses `tasklist /FO CSV /NH` output into pid → image name.
pub fn parse_tasklist(text: &str) -> HashMap<u32, String> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.trim().trim_matches('"').split("\",\"").collect();
            let name = fields.first()?;
            let pid = fields.get(1)?.parse().ok()?;
            Some((pid, (*name).to_string()))
        })
        .collect()
}

/// Fills in each row's process name from the tasklist map.
pub fn name_processes(rows: &mut [ListeningPort], names: &HashMap<u32, String>) {
    for row in rows {
        row.process = names.get(&row.pid).cloned();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NETSTAT: &str = "
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1132
  TCP    127.0.0.1:3307         0.0.0.0:0              LISTENING       4400
  TCP    127.0.0.1:8000         127.0.0.1:50000        ESTABLISHED     900
  TCP    [::]:445               [::]:0                 LISTENING       4
  TCP    127.0.0.1:3307         0.0.0.0:0              LISTENING       4400
";

    #[test]
    fn keeps_only_listening_rows_sorted_and_deduplicated() {
        let rows = parse_netstat(NETSTAT);
        let ports: Vec<u16> = rows.iter().map(|row| row.port).collect();
        assert_eq!(ports, vec![135, 445, 3307]);
        assert_eq!(rows[1].address, "::");
        assert_eq!(rows[2].pid, 4400);
    }

    #[test]
    fn garbage_lines_are_ignored() {
        assert!(parse_netstat("nothing useful\nTCP a b").is_empty());
    }

    #[test]
    fn tasklist_names_are_matched_by_pid() {
        let names = parse_tasklist("\"mysqld.exe\",\"4400\",\"Console\",\"1\",\"50,000 K\"\r\n");
        let mut rows = parse_netstat(NETSTAT);
        name_processes(&mut rows, &names);
        assert_eq!(rows[2].process.as_deref(), Some("mysqld.exe"));
        assert_eq!(rows[0].process, None);
    }
}
