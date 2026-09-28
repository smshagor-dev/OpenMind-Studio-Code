//! `openmind-network`: proxy settings and system proxy detection, the proxy environment for processes OpenMind starts,
//! the proxy route for OpenMind's own HTTP requests, retries and mirrors, network problem categories, the connection
//! test and the offline package cache. Nothing here changes the system proxy, PATH, the Registry or a package
//! manager's global configuration, and nothing makes a request unless a caller asks for one.

pub mod env;
pub mod http;
pub mod offline;
pub mod probe;
pub mod problem;
pub mod proxy;
pub mod redact;
pub mod retry;
pub mod system;
