//! `openmind-workloads`: the Visual Studio-style workload and language-pack catalog of the Runtime Manager, as data,
//! and the rules that turn it into honest statuses and an install plan. It does no I/O: the app supplies what is
//! installed and what was found on this computer ([`status::Facts`]). A component is only ever "Available" when
//! OpenMind can really install it app-locally; everything else says why not (external, admin, manual, planned).

pub mod catalog;
pub mod plan;
pub mod status;

pub use catalog::{
    component, framework, pack, workload, Category, Component, Framework, Pack, Provision,
    Workload, COMPONENTS, FRAMEWORKS, PACKS, WORKLOADS,
};
pub use plan::{plan, Plan, Selection, Warning, WarningKind};
pub use status::{
    framework_missing, resolve, ComponentStatus, Facts, LspFact, RuntimeFact, State,
    HEAVY_INSTALL_BYTES,
};
