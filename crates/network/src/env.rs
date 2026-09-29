//! Values for the environment of a process OpenMind starts. Since the Unified Download Broker, OpenMind no longer puts
//! proxy variables (`HTTP_PROXY`, `PIP_PROXY`, `NPM_CONFIG_PROXY` ...) into terminals: package tools are pointed at the
//! package gateway (`openmind-broker`), which downloads through the route below, and a program's own requests are never
//! routed by OpenMind. What remains here is the offline wheelhouse's address.

use std::path::Path;

/// `C:\a b\c` -> `file:///C:/a%20b/c` (only letters, digits, `-._~/:` stay as they are). pip splits `PIP_FIND_LINKS` on
/// whitespace, so a folder with a space ("OpenMind Studio") must be a file URL.
pub fn file_url(path: &Path) -> String {
    let text = path.display().to_string().replace('\\', "/");
    let mut url = String::from(if text.starts_with('/') {
        "file://"
    } else {
        "file:///"
    });
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/:".contains(&byte) {
            url.push(byte as char);
        } else {
            url.push_str(&format!("%{byte:02X}"));
        }
    }
    url
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wheel_folder_is_a_file_url_pip_can_read_even_with_spaces() {
        assert_eq!(
            file_url(Path::new(r"C:\omm21\OpenMind Studio\cache\offline\wheels")),
            "file:///C:/omm21/OpenMind%20Studio/cache/offline/wheels"
        );
        assert_eq!(
            file_url(Path::new("/opt/My App/w")),
            "file:///opt/My%20App/w"
        );
        assert_eq!(
            file_url(Path::new(r"D:\Проекты")),
            "file:///D:/%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82%D1%8B"
        );
    }
}
