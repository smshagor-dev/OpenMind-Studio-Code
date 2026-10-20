//! Run Code: decide whether the active file can be run, resolve which
//! interpreter runs it (portable runtime first, system only as a fallback),
//! and run it as a managed child process whose output is streamed and whose
//! whole process tree dies on Stop or on app shutdown. Nothing goes through a
//! shell: a run is an argument list, so a file name can't become a command.

pub mod assembly;
pub mod compiled;
pub mod display;
pub mod error;
pub mod fortran;
pub mod kind;
pub mod netstat;
pub mod oneshot;
pub mod pascal;
pub mod plan;
pub mod runtime;
pub mod server;
pub mod session;
pub mod stack;
pub mod template;
pub mod webroot;

pub use assembly::{Arch, AssemblyOptions};
pub use compiled::{java_main_class, missing_compiler, BuildStep, LinkStep};
pub use display::{command_line, shell_chain, shell_command_line, ShellStyle};
pub use error::RunError;
pub use kind::{detect, Detection, RunnableKind};
pub use netstat::{name_processes, parse_netstat, parse_tasklist, ListeningPort};
pub use oneshot::{run_to_completion, Completed};
pub use pascal::{PascalCompiler, PascalOptions, PASCALABC_RUNTIME};
pub use plan::{plan, RunPlan, RunRequest};
pub use runtime::{portable_version, RunEnvironment, RuntimeSource};
pub use server::{
    php_server_plan, port_is_free, server_url, validate_port, validate_root, PhpServerRequest,
    DEFAULT_PORT, LOOPBACK,
};
pub use session::{
    is_build_dir, EventSink, Phase, RunEvent, RunEventKind, RunInfo, RunRegistry, Stream,
    BUILD_ROOT,
};
pub use stack::{
    composer_plan, ipv6_loopback_usable, mariadb_admin_plan, mariadb_init_plan,
    mariadb_port_is_free, mariadb_start_plan, render_mariadb_config, render_phpmyadmin_config,
    resolve_portable, validate_service_port, AdminAction, ComposerAction, MariaDbPaths, PmaLogin,
    MARIADB_DEFAULT_PASSWORD, MARIADB_DEFAULT_PORT, MARIADB_DEFAULT_PORTS, MARIADB_USER,
    PHPMYADMIN_DEFAULT_PORT, PHPMYADMIN_DEFAULT_PORTS,
};
pub use webroot::{ensure_web_root, WEB_ROOT_DIR};

#[cfg(test)]
mod tests;
