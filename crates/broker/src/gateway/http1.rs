//! Just enough HTTP/1.1 for the gateway: requests with bounded headers and bodies (Content-Length or chunked), and
//! responses with a known length or chunked. Only tools on this computer talk to it (loopback).

use std::io::{self, BufRead, Read, Write};

/// Limits for what a client may send.
pub const MAX_HEAD: usize = 64 * 1024;
pub const MAX_HEADERS: usize = 100;
pub const MAX_BODY: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    /// Path and query, as sent.
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// HTTP/1.0, or `Connection: close`.
    pub close: bool,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or_default()
    }

    pub fn query(&self) -> Option<&str> {
        self.target.split_once('?').map(|(_, query)| query)
    }

    /// A query parameter, percent-decoded.
    pub fn param(&self, name: &str) -> Option<String> {
        self.query()?.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (key == name).then(|| percent_decode(value))
        })
    }
}

pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(byte) => {
                        out.push(byte);
                        i += 2;
                    }
                    None => out.push(b'%'),
                }
            }
            byte => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn bad(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

/// One line without its CRLF, bounded by `budget`.
fn read_line(reader: &mut dyn BufRead, budget: &mut usize) -> io::Result<Option<String>> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err(bad("connection closed mid-line"))
            };
        }
        let (take, done) = match available.iter().position(|b| *b == b'\n') {
            Some(pos) => (pos + 1, true),
            None => (available.len(), false),
        };
        if take > *budget {
            return Err(bad("request head too large"));
        }
        *budget -= take;
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if done {
            while matches!(line.last(), Some(b'\n' | b'\r')) {
                line.pop();
            }
            return String::from_utf8(line)
                .map(Some)
                .map_err(|_| bad("request head is not text"));
        }
    }
}

/// How a request's body is framed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyKind {
    None,
    Length(u64),
    Chunked,
}

/// Reads the head of the next request (request line and headers); `None` when the client closed the connection between
/// requests. The body is left in `reader`: read it with [`read_body`] or stream it with [`BodyReader`].
pub fn read_head(reader: &mut dyn BufRead) -> io::Result<Option<(Request, BodyKind)>> {
    let mut budget = MAX_HEAD;
    let Some(first) = read_line(reader, &mut budget)? else {
        return Ok(None);
    };
    let mut parts = first.split(' ');
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next())
    else {
        return Err(bad("malformed request line"));
    };
    if !version.starts_with("HTTP/1.") || !method.chars().all(|c| c.is_ascii_uppercase()) {
        return Err(bad("unsupported request"));
    }
    let mut headers = Vec::new();
    loop {
        let line =
            read_line(reader, &mut budget)?.ok_or_else(|| bad("connection closed in headers"))?;
        if line.is_empty() {
            break;
        }
        if headers.len() >= MAX_HEADERS {
            return Err(bad("too many headers"));
        }
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| bad("malformed header"))?;
        headers.push((name.trim().to_string(), value.trim().to_string()));
    }
    let mut request = Request {
        method: method.to_string(),
        target: target.to_string(),
        headers,
        body: Vec::new(),
        close: version == "HTTP/1.0",
    };
    if request
        .header("connection")
        .is_some_and(|v| v.eq_ignore_ascii_case("close"))
    {
        request.close = true;
    }
    let kind = match (
        request
            .header("transfer-encoding")
            .map(|v| v.to_ascii_lowercase()),
        request.header("content-length"),
    ) {
        (Some(te), _) if te == "chunked" => BodyKind::Chunked,
        (Some(_), _) => return Err(bad("unsupported transfer encoding")),
        (None, Some(length)) => match length.trim().parse::<u64>() {
            Ok(0) => BodyKind::None,
            Ok(length) => BodyKind::Length(length),
            Err(_) => return Err(bad("bad content length")),
        },
        (None, None) => BodyKind::None,
    };
    Ok(Some((request, kind)))
}

/// The client asked to be told before it sends the body.
pub fn expects_continue(request: &Request, kind: BodyKind) -> bool {
    kind != BodyKind::None
        && request
            .header("expect")
            .is_some_and(|v| v.eq_ignore_ascii_case("100-continue"))
}

/// Reads a whole body into memory (at most [`MAX_BODY`]).
pub fn read_body(reader: &mut dyn BufRead, kind: BodyKind) -> io::Result<Vec<u8>> {
    match kind {
        BodyKind::None => Ok(Vec::new()),
        BodyKind::Chunked => read_chunked(reader),
        BodyKind::Length(length) => {
            if length > MAX_BODY as u64 {
                return Err(bad("request body too large"));
            }
            let mut body = vec![0; length as usize];
            reader.read_exact(&mut body)?;
            Ok(body)
        }
    }
}

/// Reads the next request with its whole body; `None` when the client closed the connection between requests.
/// `on_continue` is called before the body is read when the client asked for `100 Continue`.
pub fn read_request(
    reader: &mut dyn BufRead,
    on_continue: &mut dyn FnMut() -> io::Result<()>,
) -> io::Result<Option<Request>> {
    let Some((mut request, kind)) = read_head(reader)? else {
        return Ok(None);
    };
    if expects_continue(&request, kind) {
        on_continue()?;
    }
    request.body = read_body(reader, kind)?;
    Ok(Some(request))
}

/// A body streamed as it arrives (a Git push can be larger than anything worth holding in memory).
pub struct BodyReader<'a> {
    reader: &'a mut dyn BufRead,
    kind: BodyKind,
    /// Bytes left in the current chunk (chunked) or in the body (length).
    left: u64,
    done: bool,
}

impl<'a> BodyReader<'a> {
    pub fn new(reader: &'a mut dyn BufRead, kind: BodyKind) -> Self {
        let (left, done) = match kind {
            BodyKind::None => (0, true),
            BodyKind::Length(length) => (length, false),
            BodyKind::Chunked => (0, false),
        };
        BodyReader {
            reader,
            kind,
            left,
            done,
        }
    }

    /// Whether the whole body was read (so the connection could serve another request).
    pub fn finished(&self) -> bool {
        self.done
    }
}

impl Read for BodyReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.done || buf.is_empty() {
            return Ok(0);
        }
        if self.kind == BodyKind::Chunked && self.left == 0 {
            let mut budget = 1024;
            let line = read_line(self.reader, &mut budget)?
                .ok_or_else(|| bad("closed in chunked body"))?;
            let size_text = line.split(';').next().unwrap_or_default().trim();
            let size = u64::from_str_radix(size_text, 16).map_err(|_| bad("bad chunk size"))?;
            if size == 0 {
                loop {
                    let mut budget = MAX_HEAD;
                    match read_line(self.reader, &mut budget)? {
                        Some(line) if !line.is_empty() => continue,
                        _ => break,
                    }
                }
                self.done = true;
                return Ok(0);
            }
            self.left = size;
        }
        let want = buf
            .len()
            .min(usize::try_from(self.left).unwrap_or(usize::MAX));
        let read = self.reader.read(&mut buf[..want])?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "the body ended early",
            ));
        }
        self.left -= read as u64;
        if self.left == 0 {
            match self.kind {
                BodyKind::Length(_) => self.done = true,
                _ => {
                    let mut crlf = [0u8; 2];
                    self.reader.read_exact(&mut crlf)?;
                }
            }
        }
        Ok(read)
    }
}

fn read_chunked(reader: &mut dyn BufRead) -> io::Result<Vec<u8>> {
    let mut body = Vec::new();
    loop {
        let mut budget = 1024;
        let line = read_line(reader, &mut budget)?.ok_or_else(|| bad("closed in chunked body"))?;
        let size_text = line.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| bad("bad chunk size"))?;
        if size == 0 {
            // Trailers, then an empty line.
            loop {
                let mut budget = MAX_HEAD;
                match read_line(reader, &mut budget)? {
                    Some(line) if !line.is_empty() => continue,
                    _ => break,
                }
            }
            return Ok(body);
        }
        if body.len() + size > MAX_BODY {
            return Err(bad("request body too large"));
        }
        let start = body.len();
        body.resize(start + size, 0);
        reader.read_exact(&mut body[start..])?;
        let mut crlf = [0u8; 2];
        reader.read_exact(&mut crlf)?;
    }
}

pub fn reason(status: u16) -> &'static str {
    match status {
        100 => "Continue",
        200 => "OK",
        206 => "Partial Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        407 => "Proxy Authentication Required",
        410 => "Gone",
        413 => "Payload Too Large",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Status",
    }
}

/// Header names never copied into a response the gateway writes itself.
fn framing(name: &str) -> bool {
    [
        "content-length",
        "transfer-encoding",
        "connection",
        "keep-alive",
    ]
    .iter()
    .any(|framing| name.eq_ignore_ascii_case(framing))
}

fn write_head(
    out: &mut dyn Write,
    status: u16,
    headers: &[(String, String)],
    framing_header: &str,
) -> io::Result<()> {
    let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    for (name, value) in headers.iter().filter(|(name, _)| !framing(name)) {
        if name.contains(['\r', '\n']) || value.contains(['\r', '\n']) {
            continue;
        }
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(framing_header);
    head.push_str("\r\n");
    out.write_all(head.as_bytes())
}

/// A response with a body of known length.
pub fn write_full(
    out: &mut dyn Write,
    status: u16,
    headers: &[(String, String)],
    body: &[u8],
) -> io::Result<()> {
    write_head(
        out,
        status,
        headers,
        &format!("Content-Length: {}\r\n", body.len()),
    )?;
    out.write_all(body)?;
    out.flush()
}

/// A response whose body is streamed from `body`, `length` bytes if known, else chunked. Returns the bytes sent.
pub fn write_stream(
    out: &mut dyn Write,
    status: u16,
    headers: &[(String, String)],
    body: &mut dyn Read,
    length: Option<u64>,
) -> io::Result<u64> {
    match length {
        Some(length) => {
            write_head(
                out,
                status,
                headers,
                &format!("Content-Length: {length}\r\n"),
            )?;
            let sent = io::copy(&mut body.take(length), out)?;
            out.flush()?;
            if sent != length {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "body ended early",
                ));
            }
            Ok(sent)
        }
        None => {
            write_head(out, status, headers, "Transfer-Encoding: chunked\r\n")?;
            let mut buffer = vec![0u8; 64 * 1024];
            let mut sent = 0u64;
            loop {
                let read = body.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                out.write_all(format!("{read:x}\r\n").as_bytes())?;
                out.write_all(&buffer[..read])?;
                out.write_all(b"\r\n")?;
                sent += read as u64;
            }
            out.write_all(b"0\r\n\r\n")?;
            out.flush()?;
            Ok(sent)
        }
    }
}

/// A short plain-text error answer.
pub fn write_error(out: &mut dyn Write, status: u16, message: &str) -> io::Result<()> {
    write_full(
        out,
        status,
        &[("Content-Type".into(), "text/plain; charset=utf-8".into())],
        format!("OpenMind Studio gateway: {message}\n").as_bytes(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    fn parse(raw: &[u8]) -> io::Result<Option<Request>> {
        let mut reader = BufReader::new(Cursor::new(raw.to_vec()));
        read_request(&mut reader, &mut || Ok(()))
    }

    #[test]
    fn a_get_with_headers_and_a_query_is_read() {
        let request = parse(b"GET /t/pypi/simple/six/?a=1&url=https%3A%2F%2Fx.org%2Fa%20b HTTP/1.1\r\nHost: 127.0.0.1:5\r\nAccept: text/html\r\n\r\n")
            .expect("ok")
            .expect("request");
        assert_eq!(request.method, "GET");
        assert_eq!(request.path(), "/t/pypi/simple/six/");
        assert_eq!(request.header("host"), Some("127.0.0.1:5"));
        assert_eq!(request.param("url").as_deref(), Some("https://x.org/a b"));
        assert!(!request.close);
    }

    #[test]
    fn content_length_and_chunked_bodies_are_read() {
        let request = parse(b"POST /x HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello")
            .expect("ok")
            .expect("request");
        assert_eq!(request.body, b"hello");
        let request = parse(b"POST /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nwiki\r\n5;x=y\r\npedia\r\n0\r\n\r\n")
            .expect("ok")
            .expect("request");
        assert_eq!(request.body, b"wikipedia");
    }

    #[test]
    fn a_closed_connection_between_requests_is_not_an_error() {
        assert!(parse(b"").expect("ok").is_none());
    }

    #[test]
    fn oversized_or_malformed_requests_are_refused() {
        let huge = format!("GET /{} HTTP/1.1\r\n\r\n", "a".repeat(MAX_HEAD + 10));
        assert!(parse(huge.as_bytes()).is_err());
        assert!(parse(b"GET / FTP/1.0\r\n\r\n").is_err());
        assert!(parse(b"get / HTTP/1.1\r\n\r\n").is_err());
        let big = format!(
            "POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY + 1
        );
        assert!(parse(big.as_bytes()).is_err());
        assert!(parse(b"POST / HTTP/1.1\r\nTransfer-Encoding: gzip\r\n\r\n").is_err());
    }

    #[test]
    fn a_body_can_be_streamed_as_it_arrives() {
        for raw in [
            &b"POST /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nwiki\r\n5\r\npedia\r\n0\r\n\r\nNEXT"[..],
            &b"POST /x HTTP/1.1\r\nContent-Length: 9\r\n\r\nwikipediaNEXT"[..],
        ] {
            let mut reader = BufReader::new(Cursor::new(raw.to_vec()));
            let (_, kind) = read_head(&mut reader).expect("ok").expect("head");
            let mut body = BodyReader::new(&mut reader, kind);
            let mut out = Vec::new();
            body.read_to_end(&mut out).expect("read");
            assert!(body.finished());
            assert_eq!(out, b"wikipedia");
            let mut rest = String::new();
            reader.read_to_string(&mut rest).expect("rest");
            assert_eq!(rest, "NEXT", "the next request is left untouched");
        }
    }

    #[test]
    fn a_body_that_ends_early_is_an_error() {
        let mut reader = BufReader::new(Cursor::new(
            b"POST /x HTTP/1.1\r\nContent-Length: 9\r\n\r\nwiki".to_vec(),
        ));
        let (_, kind) = read_head(&mut reader).expect("ok").expect("head");
        let mut out = Vec::new();
        assert!(BodyReader::new(&mut reader, kind)
            .read_to_end(&mut out)
            .is_err());
    }

    #[test]
    fn expect_continue_is_answered_before_the_body() {
        let mut reader = BufReader::new(Cursor::new(
            b"POST /x HTTP/1.1\r\nExpect: 100-continue\r\nContent-Length: 2\r\n\r\nok".to_vec(),
        ));
        let mut asked = false;
        let request = read_request(&mut reader, &mut || {
            asked = true;
            Ok(())
        })
        .expect("ok")
        .expect("request");
        assert!(asked);
        assert_eq!(request.body, b"ok");
    }

    #[test]
    fn responses_are_framed_and_never_carry_injected_header_lines() {
        let mut out = Vec::new();
        write_full(
            &mut out,
            200,
            &[
                ("Content-Type".into(), "text/plain".into()),
                ("X-Evil".into(), "a\r\nSet-Cookie: x".into()),
                ("Content-Length".into(), "999".into()),
            ],
            b"hi",
        )
        .expect("write");
        let text = String::from_utf8(out).expect("utf8");
        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(text.contains("Content-Length: 2\r\n"));
        assert!(!text.contains("999") && !text.contains("Set-Cookie"));
        let mut out = Vec::new();
        let sent = write_stream(&mut out, 200, &[], &mut Cursor::new(b"abc".to_vec()), None)
            .expect("write");
        assert_eq!(sent, 3);
        assert!(String::from_utf8(out)
            .expect("utf8")
            .ends_with("3\r\nabc\r\n0\r\n\r\n"));
    }

    #[test]
    fn percent_decoding_keeps_bad_escapes_and_decodes_utf8() {
        assert_eq!(percent_decode("a%20b%2"), "a b%2");
        assert_eq!(percent_decode("%E0%A6%AC"), "ব");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
