use openmind_settings::ThemeSettingService;
use openmind_workspace::{RecentFilesService, SessionService};

/// Shared application state, managed by Tauri and injected into commands via
/// `tauri::State<AppState>`. This is the composition root's DI seam: as
/// later milestones add services, they get wired in here, not through
/// ad-hoc globals. `WindowStateService` isn't here — it's only ever used
/// inside `main.rs`'s `setup` closure (load-on-launch, save-on-close), never
/// from a command, so it stays local rather than adding an unread field.
pub struct AppState {
    pub recent_files: RecentFilesService,
    pub session: SessionService,
    pub theme: ThemeSettingService,
}
