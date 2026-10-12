//! The server over a real loopback socket.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use openmind_live_preview::{Server, BRIDGE_PATH, RUN_SCRIPT_PATH};

fn site() -> (tempfile::TempDir, Server) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("my site");
    std::fs::create_dir_all(root.join("sub dir")).unwrap();
    std::fs::write(
        root.join("index.html"),
        "<html><head><title>T</title></head><body>hi</body></html>",
    )
    .unwrap();
    std::fs::write(root.join("app.js"), "console.log('x')").unwrap();
    std::fs::write(root.join("sub dir/page.htm"), "<p>sub</p>").unwrap();
    std::fs::write(dir.path().join("secret.txt"), "secret").unwrap();
    let server = Server::start(&root).unwrap();
    (dir, server)
}

fn get(server: &Server, method: &str, target: &str, host: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", server.port())).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    write!(
        stream,
        "{method} {target} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).unwrap();
    answer
}

fn own(server: &Server) -> String {
    format!("127.0.0.1:{}", server.port())
}

#[test]
fn pages_get_the_bridge_and_other_files_are_sent_as_they_are() {
    let (_dir, server) = site();
    let page = get(&server, "GET", "/", &own(&server));
    assert!(page.starts_with("HTTP/1.1 200 OK"), "{page}");
    assert!(page.contains("text/html; charset=utf-8"));
    assert!(page.contains(&format!(
        "<head><script src=\"{BRIDGE_PATH}\"></script><title>T</title>"
    )));
    assert!(!page.contains("Access-Control-Allow-Origin"));

    let script = get(
        &server,
        "GET",
        "/app.js",
        &format!("localhost:{}", server.port()),
    );
    assert!(script.contains("text/javascript"));
    assert!(script.ends_with("console.log('x')"));

    let bridge = get(&server, "GET", BRIDGE_PATH, &own(&server));
    assert!(bridge.contains("__openmindConsole"));

    let sub = get(&server, "GET", "/sub%20dir/page.htm", &own(&server));
    assert!(sub.contains("<p>sub</p>") && sub.contains(BRIDGE_PATH));

    let runner = get(
        &server,
        "GET",
        &format!("{RUN_SCRIPT_PATH}?src=%2Fapp.js"),
        &own(&server),
    );
    assert!(
        runner.contains("<script src=\"/app.js\"></script>"),
        "{runner}"
    );

    let head = get(&server, "HEAD", "/app.js", &own(&server));
    assert!(head.starts_with("HTTP/1.1 200 OK") && head.ends_with("\r\n\r\n"));
}

#[test]
fn foreign_hosts_methods_and_paths_out_of_the_folder_are_refused() {
    let (_dir, server) = site();
    assert!(get(&server, "GET", "/", "evil.example").starts_with("HTTP/1.1 403"));
    assert!(get(&server, "GET", "/", "127.0.0.1:1").starts_with("HTTP/1.1 403"));
    assert!(get(&server, "POST", "/", &own(&server)).starts_with("HTTP/1.1 405"));
    let escape = get(&server, "GET", "/../secret.txt", &own(&server));
    assert!(
        escape.starts_with("HTTP/1.1 403")
            && !escape.contains("secret\r")
            && !escape.ends_with("secret")
    );
    assert!(get(&server, "GET", "/%2e%2e/secret.txt", &own(&server)).starts_with("HTTP/1.1 403"));
    assert!(get(&server, "GET", "/missing.css", &own(&server)).starts_with("HTTP/1.1 404"));
}

#[test]
fn folders_redirect_to_a_slash_and_list_without_an_index() {
    let (_dir, server) = site();
    let redirect = get(&server, "GET", "/sub%20dir?x=1", &own(&server));
    assert!(redirect.starts_with("HTTP/1.1 301"));
    assert!(redirect.contains("Location: /sub%20dir/?x=1"));
    let listing = get(&server, "GET", "/sub%20dir/", &own(&server));
    assert!(listing.contains("Index of /sub dir/") && listing.contains("page.htm"));
}

#[test]
fn addresses_of_files_and_stopping_on_drop() {
    let (dir, server) = site();
    let root = dir.path().join("my site");
    assert_eq!(
        server
            .address_of(&root.join("sub dir").join("page.htm"))
            .unwrap(),
        "/sub%20dir/page.htm"
    );
    assert!(server.address_of(&dir.path().join("secret.txt")).is_err());
    let port = server.port();
    drop(server);
    assert!(
        TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(300))
            .is_err()
    );
}
