//! `openmind-broker`: the Unified Download Broker. Package and file downloads that tools in OpenMind's terminals ask for
//! (pip, npm, Go, Git, `openmind-fetch`) are made by the same code and over the same route as the Download Manager that
//! installs runtimes (`openmind_runtime_manager::download`, `openmind_network::http`), staged in `<app>/temp`, verified
//! and cleaned up. Nothing here changes Windows' proxy, the certificate store, PATH or a tool's global configuration,
//! and TLS verification is never turned off.

pub mod broker;
pub mod env;
pub mod error;
pub mod events;
pub mod gateway;
pub mod staging;

pub use broker::{Artifact, ArtifactRequest, Broker, Lease};
pub use error::{BrokerError, FailureKind};
pub use events::{BrokerEvent, EventSink, Phase};
pub use gateway::{Gateway, GatewayConfig};
pub use staging::{Provider, RecoveryReport, Staging};
