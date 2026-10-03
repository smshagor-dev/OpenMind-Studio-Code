//! What the servers run on and install with: the offline bundle, Node.js (the bundle's, portable, system), npm and
//! Python, chosen the same way for starting, installing and the status list.

use std::path::PathBuf;

use openmind_lsp::bundle::{self, Bundle};
use openmind_lsp::{
    package_by_id, resolve_lsp_node, resolve_node, LspError, NodeExecutable, PythonExecutable,
    ServerDef,
};

use crate::app_state::AppState;
use crate::commands::run::environment;

pub(super) struct Resolved {
    /// The Node the servers run on: the bundle's, else portable, else system.
    pub(super) node: Result<NodeExecutable, LspError>,
    /// A Node with npm next to it, for installing from npm (the bundled Node has none).
    pub(super) npm_node: Result<NodeExecutable, LspError>,
    /// Python for Python-package language servers.
    pub(super) python: Result<PythonExecutable, LspError>,
    pub(super) bundle: Option<Bundle>,
    pub(super) bundle_problem: Option<String>,
    pub(super) path_prepend: Vec<PathBuf>,
    pub(super) vars: Vec<(String, String)>,
}

/// Node with npm, and Python, chosen as for language servers: for the Language Tools tool installer.
pub(crate) async fn installers(
    state: &AppState,
) -> (Result<NodeExecutable, String>, Result<PathBuf, String>) {
    let resolved = resolve(state).await;
    (
        resolved.npm_node.map_err(|err| err.to_string()),
        resolved
            .python
            .map(|python| python.path)
            .map_err(|err| err.to_string()),
    )
}

pub(super) async fn resolve(state: &AppState) -> Resolved {
    let environment = environment(state).await;
    let (bundle, bundle_problem) = match bundle::load(&state.app_root) {
        Ok(bundle) => (bundle, None),
        Err(problem) => {
            tracing::warn!(%problem, "LSP bundle not used");
            (None, Some(problem))
        }
    };
    let system = std::env::var_os("PATH");
    let python = openmind_runner::runtime::resolve_executable(
        "python",
        &environment,
        &[],
        system.as_deref(),
    )
    .map(|found| PythonExecutable {
        label: match found.source {
            openmind_runner::RuntimeSource::Portable => {
                match openmind_runner::portable_version(&found.path) {
                    Some(version) => format!("OpenMind portable Python {version}"),
                    None => "OpenMind portable Python".to_string(),
                }
            }
            openmind_runner::RuntimeSource::Project => "Project Python".to_string(),
            // Explicit: a server installed and run with this Python never changes it (see `install::pip_args`).
            openmind_runner::RuntimeSource::System => {
                format!("System Python at {}", found.path.display())
            }
        },
        path: found.path,
    })
    .ok_or_else(|| {
        LspError::InstallFailed(
            "Python was not found. Install Python from the Runtime Manager.".into(),
        )
    });
    Resolved {
        node: resolve_lsp_node(
            bundle.as_ref().and_then(Bundle::node_path),
            &environment.path_prepend,
            system.clone(),
        ),
        npm_node: resolve_node(&environment.path_prepend, system),
        python,
        bundle,
        bundle_problem,
        path_prepend: environment.path_prepend,
        vars: environment.vars,
    }
}

/// Whether the bundle carries `def`'s package (for this app's revision).
pub(super) fn bundled(resolved: &Resolved, def: &ServerDef) -> bool {
    let package = package_by_id(def.package);
    matches!((&resolved.bundle, package), (Some(bundle), Some(package)) if bundle.pack_for(package).is_some())
}
