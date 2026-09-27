//! Notebook foundation (Milestone 19): Jupyter `.ipynb` files read and saved without losing what OpenMind doesn't
//! understand (`ipynb`), and a local Python cell runner started only when the user runs a cell (`kernel`). Not
//! Jupyter parity: no Jupyter protocol, no IPython magics, no widgets, no other languages, no remote kernels.

pub mod ipynb;
pub mod kernel;

pub use ipynb::{
    fingerprint, load, save, CellEdit, CellKind, CellModel, NotebookError, NotebookModel,
};
pub use kernel::{candidates, CellResult, Kernel, KernelCandidate, KernelError, KernelSpec};
