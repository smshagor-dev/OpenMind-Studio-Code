//! Process plans for the portable PHP development stack beyond the built-in
//! server: MariaDB (initialize, start, ping, shutdown), phpMyAdmin's config
//! and Composer's project commands. Like `server.rs` this is planning only —
//! nothing here starts a process — and every executable comes from
//! OpenMind's own portable runtimes: a machine's XAMPP/MySQL is never used,
//! no Windows service is installed, and only the child's own environment is
//! built (the system PATH and the Registry are never touched).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::display::command_line;
use crate::error::RunError;
use crate::kind::RunnableKind;
use crate::plan::{child_path, RunPlan};
use crate::runtime::{
    resolve_executable, runtime_label, ResolvedExecutable, RunEnvironment, RuntimeSource,
};

/// MySQL's usual port, used when it is free and the user chose none.
pub const MARIADB_DEFAULT_PORT: u16 = 3306;
/// Tried in this order when the user chose no port: MySQL's usual one, then OpenMind's earlier default (another MySQL,
/// e.g. XAMPP's, often holds 3306).
pub const MARIADB_DEFAULT_PORTS: [u16; 2] = [3306, 3307];
pub const PHPMYADMIN_DEFAULT_PORT: u16 = 8081;
/// phpMyAdmin's ports to try when the user chose none.
pub const PHPMYADMIN_DEFAULT_PORTS: [u16; 5] = [8081, 8082, 8083, 8084, 8085];
/// MariaDB is only ever reached on this address.
pub const LOOPBACK: &str = "127.0.0.1";

/// The user MariaDB is initialized with (the only account OpenMind creates).
pub const MARIADB_USER: &str = "root";

/// The root password of a database OpenMind initializes: `root`, like a local XAMPP stack. Acceptable only because the
/// server listens on 127.0.0.1 alone (see `render_mariadb_config`): nothing on the network can reach it. A database
/// initialized earlier keeps the password it was given.
pub const MARIADB_DEFAULT_PASSWORD: &str = "root";

/// Where MariaDB keeps its files, all inside the portable app folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MariaDbPaths {
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    pub log_file: PathBuf,
    pub config_dir: PathBuf,
    pub config_file: PathBuf,
}

impl MariaDbPaths {
    /// `data/mariadb`, `logs/mariadb` and `settings/mariadb` under `app_root`.
    pub fn new(app_root: &Path) -> Self {
        let log_dir = app_root.join("logs").join("mariadb");
        let config_dir = app_root.join("settings").join("mariadb");
        Self {
            data_dir: app_root.join("data").join("mariadb"),
            log_file: log_dir.join("mariadb.log"),
            log_dir,
            config_file: config_dir.join("my.ini"),
            config_dir,
        }
    }

    /// The folders [`openmind_core::AppPaths`] gives MariaDB (`mariadb_data_dir`, `mariadb_logs_dir`,
    /// `mariadb_config_dir`): the layout above for one profile, `data/machines/<id>/...` per computer.
    pub fn from_dirs(data_dir: PathBuf, log_dir: PathBuf, config_dir: PathBuf) -> Self {
        Self {
            data_dir,
            log_file: log_dir.join("mariadb.log"),
            log_dir,
            config_file: config_dir.join("my.ini"),
            config_dir,
        }
    }

    /// Whether the data directory already holds an initialized database.
    pub fn is_initialized(&self) -> bool {
        self.data_dir.join("mysql").is_dir() && self.data_dir.join("ibdata1").is_file()
    }
}

/// Ports OpenMind will bind: 1024-65535 (privileged ports need elevation).
pub fn validate_service_port(port: u16) -> Result<u16, RunError> {
    crate::server::validate_port(port)
}

/// A value that ends up in a config file or argument list can't contain
/// quotes, control characters or line breaks.
fn plain_path_text(path: &Path) -> Result<String, RunError> {
    let text = path.to_string_lossy();
    if text.is_empty()
        || text
            .chars()
            .any(|c| c.is_control() || matches!(c, '"' | '\''))
    {
        return Err(RunError::BadCommand(format!(
            "\"{text}\" can't be used in a database configuration"
        )));
    }
    Ok(text.replace('\\', "/"))
}

/// The `my.ini` OpenMind starts MariaDB with. Paths are quoted (they may
/// contain spaces) and use forward slashes; server output goes to the console,
/// which OpenMind captures into `logs/mariadb`. It binds 127.0.0.1 only and
/// disables the Windows named pipe so it can't collide with
/// (or be reached through) another MySQL on the machine.
pub fn render_mariadb_config(
    paths: &MariaDbPaths,
    install_dir: &Path,
    port: u16,
) -> Result<String, RunError> {
    let port = validate_service_port(port)?;
    let basedir = plain_path_text(install_dir)?;
    let datadir = plain_path_text(&paths.data_dir)?;
    Ok(format!(
        "; Written by OpenMind Studio each time MariaDB starts. Edit the port in the PHP Server window.\r\n\
[mysqld]\r\n\
basedir=\"{basedir}\"\r\n\
datadir=\"{datadir}\"\r\n\
port={port}\r\n\
bind-address={LOOPBACK}\r\n\
skip-name-resolve\r\n\
enable-named-pipe=OFF\r\n\
character-set-server=utf8mb4\r\n\
collation-server=utf8mb4_general_ci\r\n\
max_connections=50\r\n\
innodb_buffer_pool_size=128M\r\n\
console\r\n"
    ))
}

/// The install folder (`.../versions/<v>`) a resolved `bin/<tool>.exe` sits in.
pub fn install_dir_of(tool: &Path) -> Result<PathBuf, RunError> {
    tool.parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| RunError::BadCommand("the MariaDB install folder can't be found".into()))
}

/// The portable executable `name`, from the Runtime Manager's injected
/// folders only. `runtime` names what is missing ("MariaDB").
pub fn resolve_portable(
    name: &str,
    environment: &RunEnvironment,
    runtime: &str,
) -> Result<ResolvedExecutable, RunError> {
    resolve_executable(name, environment, &[], None)
        .filter(|found| found.source == RuntimeSource::Portable)
        .ok_or_else(|| RunError::RuntimeMissing {
            runtime: runtime.to_string(),
        })
}

fn service_plan(
    tool: ResolvedExecutable,
    args: Vec<String>,
    cwd: PathBuf,
    environment: &RunEnvironment,
    extra_env: Vec<(String, String)>,
    display: String,
    system_path: Option<OsString>,
) -> Result<RunPlan, RunError> {
    let mut argv = vec![tool.path.to_string_lossy().into_owned()];
    argv.extend(args);
    let path_var = child_path(environment, &[], &tool, system_path)?;
    let mut env = environment.vars.clone();
    env.extend(extra_env);
    Ok(RunPlan {
        kind: RunnableKind::MariaDb,
        file: cwd.clone(),
        argv,
        cwd,
        env,
        path_var,
        build: None,
        runtime_label: runtime_label(RunnableKind::MariaDb, &tool),
        source: tool.source,
        display,
        resolved: tool.path,
    })
}

/// OpenMind sets the password itself (`root` by default, a generated one for older installs), so it can be restricted
/// to letters and digits — which also makes it safe in an argument list and in phpMyAdmin's PHP config.
pub fn validate_password(password: &str) -> Result<&str, RunError> {
    if password.len() < 4
        || password.len() > 64
        || !password.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return Err(RunError::BadCommand(
            "the database password must be 4-64 letters or digits".into(),
        ));
    }
    Ok(password)
}

/// `mariadb-install-db --datadir=<data> --password=<password>`: creates the
/// system tables and gives `root` the password. The password is shown as
/// `***` everywhere it is displayed.
pub fn mariadb_init_plan(
    environment: &RunEnvironment,
    paths: &MariaDbPaths,
    password: &str,
    system_path: Option<OsString>,
) -> Result<RunPlan, RunError> {
    let password = validate_password(password)?;
    let tool = resolve_portable("mariadb-install-db", environment, "MariaDB")?;
    let install_dir = install_dir_of(&tool.path)?;
    let data = paths.data_dir.to_string_lossy().into_owned();
    let display = command_line(&[
        "mariadb-install-db".to_string(),
        format!("--datadir={data}"),
        "--password=***".to_string(),
    ]);
    service_plan(
        tool,
        vec![
            format!("--datadir={data}"),
            format!("--password={password}"),
        ],
        install_dir,
        environment,
        vec![],
        display,
        system_path,
    )
}

/// `mysqld --defaults-file=<my.ini> --console`, bound to 127.0.0.1 by that
/// file. Refuses an uninitialized data directory.
pub fn mariadb_start_plan(
    environment: &RunEnvironment,
    paths: &MariaDbPaths,
    system_path: Option<OsString>,
) -> Result<RunPlan, RunError> {
    if !paths.is_initialized() {
        return Err(RunError::MariaDbNotInitialized);
    }
    let tool = resolve_portable("mysqld", environment, "MariaDB")?;
    let install_dir = install_dir_of(&tool.path)?;
    let config = paths.config_file.to_string_lossy().into_owned();
    let display = command_line(&[
        "mysqld".to_string(),
        format!("--defaults-file={config}"),
        "--console".to_string(),
    ]);
    service_plan(
        tool,
        vec![format!("--defaults-file={config}"), "--console".to_string()],
        install_dir,
        environment,
        vec![],
        display,
        system_path,
    )
}

/// What to ask the running server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdminAction {
    /// Is it accepting connections yet?
    Ping,
    /// Ask it to shut down cleanly (flushes and closes the data files).
    Shutdown,
}

impl AdminAction {
    fn verb(self) -> &'static str {
        match self {
            Self::Ping => "ping",
            Self::Shutdown => "shutdown",
        }
    }
}

/// `mariadb-admin --host=127.0.0.1 --port=<n> --user=root ping|shutdown`. The
/// password travels in `MYSQL_PWD` for this one child, never on a command line.
pub fn mariadb_admin_plan(
    environment: &RunEnvironment,
    port: u16,
    action: AdminAction,
    password: &str,
    system_path: Option<OsString>,
) -> Result<RunPlan, RunError> {
    let port = validate_service_port(port)?;
    let password = validate_password(password)?;
    let tool = resolve_portable("mariadb-admin", environment, "MariaDB")?;
    let install_dir = install_dir_of(&tool.path)?;
    let args = vec![
        format!("--host={LOOPBACK}"),
        format!("--port={port}"),
        "--protocol=tcp".to_string(),
        format!("--user={MARIADB_USER}"),
        action.verb().to_string(),
    ];
    let display = command_line(&[
        "mariadb-admin".to_string(),
        format!("--host={LOOPBACK}"),
        format!("--port={port}"),
        format!("--user={MARIADB_USER}"),
        action.verb().to_string(),
    ]);
    service_plan(
        tool,
        args,
        install_dir,
        environment,
        vec![("MYSQL_PWD".to_string(), password.to_string())],
        display,
        system_path,
    )
}

/// How phpMyAdmin signs in to the managed MariaDB.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PmaLogin<'a> {
    /// Opens straight into the database as `root` with this password — only the default local `root` password, which
    /// is no secret (the server listens on 127.0.0.1 only).
    Automatic { password: &'a str },
    /// Shows phpMyAdmin's login page: a database with its own password never has it written into a file.
    Cookie,
}

/// The `config.inc.php` OpenMind writes into the phpMyAdmin install before
/// serving it: host 127.0.0.1 and the MariaDB port, a temp folder inside the
/// portable cache, and either automatic login with the default local
/// credentials or cookie login (the password typed, not stored in the file).
pub fn render_phpmyadmin_config(
    secret: &str,
    mariadb_port: u16,
    temp_dir: &Path,
    login: PmaLogin<'_>,
) -> Result<String, RunError> {
    let port = validate_service_port(mariadb_port)?;
    let auth = match login {
        PmaLogin::Automatic { password } => {
            let password = validate_password(password)?;
            format!(
                "$cfg['Servers'][$i]['auth_type'] = 'config';\n\
$cfg['Servers'][$i]['user'] = '{MARIADB_USER}';\n\
$cfg['Servers'][$i]['password'] = '{password}';\n"
            )
        }
        PmaLogin::Cookie => "$cfg['Servers'][$i]['auth_type'] = 'cookie';\n".to_string(),
    };
    if secret.len() < 32 || !secret.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(RunError::BadCommand(
            "the phpMyAdmin secret must be at least 32 letters or digits".into(),
        ));
    }
    let temp = plain_path_text(temp_dir)?;
    Ok(format!(
        "<?php\n\
// Written by OpenMind Studio each time phpMyAdmin starts.\n\
declare(strict_types=1);\n\
$cfg['blowfish_secret'] = '{secret}';\n\
$i = 0;\n\
$i++;\n\
{auth}\
$cfg['Servers'][$i]['host'] = '{LOOPBACK}';\n\
$cfg['Servers'][$i]['port'] = '{port}';\n\
$cfg['Servers'][$i]['compress'] = false;\n\
$cfg['Servers'][$i]['AllowNoPassword'] = false;\n\
$cfg['TempDir'] = '{temp}';\n\
$cfg['UploadDir'] = '';\n\
$cfg['SaveDir'] = '';\n\
$cfg['VersionCheck'] = false;\n"
    ))
}

/// The project commands the PHP Server window offers for Composer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ComposerAction {
    Install,
    Update,
    DumpAutoload,
}

impl ComposerAction {
    pub fn verb(self) -> &'static str {
        match self {
            Self::Install => "install",
            Self::Update => "update",
            Self::DumpAutoload => "dump-autoload",
        }
    }
}

/// `php composer.phar <action> --no-interaction --no-ansi` in the project
/// folder, on the portable PHP. Composer's home (`home`) and cache (`cache`) are folders the app chooses — inside the
/// portable folder, or this computer's own on a shared installation — never the user profile.
pub fn composer_plan(
    action: ComposerAction,
    root: &Path,
    phar: &Path,
    (home, cache): (&Path, &Path),
    environment: &RunEnvironment,
    system_path: Option<OsString>,
) -> Result<RunPlan, RunError> {
    let root = crate::server::validate_root(root)?;
    if !root.join("composer.json").is_file() {
        return Err(RunError::NoComposerJson);
    }
    if !phar.is_file() {
        return Err(RunError::RuntimeMissing {
            runtime: "Composer".to_string(),
        });
    }
    let php = resolve_portable("php", environment, "PHP")?;
    let argv = vec![
        php.path.to_string_lossy().into_owned(),
        phar.to_string_lossy().into_owned(),
        action.verb().to_string(),
        "--no-interaction".to_string(),
        "--no-ansi".to_string(),
    ];
    let display = command_line(&[
        "composer".to_string(),
        action.verb().to_string(),
        "--no-interaction".to_string(),
        "--no-ansi".to_string(),
    ]);
    let path_var = child_path(environment, &[], &php, system_path)?;
    let mut env = environment.vars.clone();
    env.push((
        "COMPOSER_HOME".to_string(),
        home.to_string_lossy().into_owned(),
    ));
    env.push((
        "COMPOSER_CACHE_DIR".to_string(),
        cache.to_string_lossy().into_owned(),
    ));
    Ok(RunPlan {
        kind: RunnableKind::Php,
        file: root.clone(),
        argv,
        cwd: root,
        env,
        path_var,
        build: None,
        runtime_label: runtime_label(RunnableKind::Php, &php),
        source: php.source,
        display,
        resolved: php.path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn exe(dir: &Path, name: &str) {
        fs::create_dir_all(dir).expect("dir");
        let file = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        };
        fs::write(dir.join(file), b"x").expect("exe");
    }

    struct Fixture {
        dir: tempfile::TempDir,
        env: RunEnvironment,
        app: PathBuf,
    }

    /// A portable MariaDB and PHP under an app folder whose path has spaces.
    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = dir.path().join("Open Mind Studio");
        let maria = app
            .join("runtimes")
            .join("mariadb")
            .join("versions")
            .join("11.8.9");
        for tool in ["mysqld", "mariadb-install-db", "mariadb-admin"] {
            exe(&maria.join("bin"), tool);
        }
        let php = app
            .join("runtimes")
            .join("php")
            .join("versions")
            .join("8.4.26");
        exe(&php, "php");
        let env = RunEnvironment {
            path_prepend: vec![maria.join("bin"), php],
            vars: vec![("OPENMIND_PHP".into(), "x".into())],
        };
        Fixture { dir, env, app }
    }

    #[test]
    fn paths_follow_the_documented_layout_under_the_app_folder() {
        let paths = MariaDbPaths::new(Path::new("C:/OpenMind Studio"));

        assert_eq!(paths.data_dir, Path::new("C:/OpenMind Studio/data/mariadb"));
        assert_eq!(paths.log_dir, Path::new("C:/OpenMind Studio/logs/mariadb"));
        assert_eq!(
            paths.log_file,
            Path::new("C:/OpenMind Studio/logs/mariadb/mariadb.log")
        );
        assert_eq!(
            paths.config_dir,
            Path::new("C:/OpenMind Studio/settings/mariadb")
        );
        assert_eq!(
            paths.config_file,
            Path::new("C:/OpenMind Studio/settings/mariadb/my.ini")
        );
    }

    #[test]
    fn an_empty_or_partial_data_directory_is_not_initialized() {
        let fx = fixture();
        let paths = MariaDbPaths::new(&fx.app);
        assert!(!paths.is_initialized());

        fs::create_dir_all(paths.data_dir.join("mysql")).expect("mysql dir");
        assert!(!paths.is_initialized(), "system tables alone aren't enough");

        fs::write(paths.data_dir.join("ibdata1"), b"x").expect("ibdata1");
        assert!(paths.is_initialized());
    }

    #[test]
    fn the_config_binds_loopback_quotes_spaced_paths_and_disables_the_named_pipe() {
        let paths = MariaDbPaths::new(Path::new("C:\\Open Mind\\Studio"));

        let text = render_mariadb_config(
            &paths,
            Path::new("C:\\Open Mind\\Studio\\runtimes\\mariadb\\versions\\11.8.9"),
            3307,
        )
        .expect("config");

        assert!(text.contains("port=3307"), "{text}");
        assert!(text.contains("bind-address=127.0.0.1"), "{text}");
        assert!(
            text.contains("datadir=\"C:/Open Mind/Studio/data/mariadb\""),
            "{text}"
        );
        assert!(text.contains("basedir=\"C:/Open Mind/Studio/runtimes/mariadb/versions/11.8.9\""));
        assert!(
            !text.contains("log-error"),
            "output is captured and logged by OpenMind"
        );
        assert!(text.contains("enable-named-pipe=OFF"));
        assert!(!text.contains("0.0.0.0"));
        assert!(!text.contains('\\'), "forward slashes only: {text}");
    }

    #[test]
    fn a_path_that_could_break_out_of_the_config_is_refused() {
        let paths = MariaDbPaths::new(Path::new("C:/ok"));
        for bad in ["C:/a\"b", "C:/a'b", "C:/a\nb"] {
            let result = render_mariadb_config(&paths, Path::new(bad), 3307);
            assert!(result.is_err(), "{bad}");
        }
    }

    #[test]
    fn ports_below_1024_or_zero_are_refused_for_every_service() {
        assert!(validate_service_port(0).is_err());
        assert!(validate_service_port(80).is_err());
        assert!(validate_service_port(3306).is_ok());
        assert!(validate_service_port(MARIADB_DEFAULT_PORT).is_ok());
        assert!(validate_service_port(PHPMYADMIN_DEFAULT_PORT).is_ok());
        let paths = MariaDbPaths::new(Path::new("C:/ok"));
        assert!(render_mariadb_config(&paths, Path::new("C:/m"), 80).is_err());
    }

    #[test]
    fn the_start_command_uses_the_portable_mysqld_and_our_config_file() {
        let fx = fixture();
        let paths = MariaDbPaths::new(&fx.app);
        fs::create_dir_all(paths.data_dir.join("mysql")).expect("mysql");
        fs::write(paths.data_dir.join("ibdata1"), b"x").expect("ibdata1");

        let plan = mariadb_start_plan(&fx.env, &paths, None).expect("plan");

        assert!(plan.argv[0].contains("versions"), "{:?}", plan.argv);
        assert!(plan.argv[0].contains("mysqld"), "{:?}", plan.argv);
        assert_eq!(
            plan.argv[1],
            format!("--defaults-file={}", paths.config_file.display())
        );
        assert_eq!(plan.argv[2], "--console");
        assert_eq!(plan.argv.len(), 3, "a spaced path stays one argument");
        assert_eq!(plan.runtime_label, "OpenMind portable MariaDB 11.8.9");
        assert!(plan.cwd.ends_with("11.8.9"));
        assert!(!plan.argv.iter().any(|a| a.contains("--skip-grant-tables")));
    }

    #[test]
    fn starting_an_uninitialized_database_is_refused_with_the_reason() {
        let fx = fixture();
        let paths = MariaDbPaths::new(&fx.app);

        let error = mariadb_start_plan(&fx.env, &paths, None).expect_err("not initialized");

        assert_eq!(error.to_string(), "Initialize the database first.");
    }

    #[test]
    fn without_a_portable_mariadb_it_says_so_even_with_a_machine_mysql_on_path() {
        let fx = fixture();
        let machine = fx.dir.path().join("xampp-mysql");
        exe(&machine, "mysqld");
        let path = std::env::join_paths([&machine]).expect("path");
        let paths = MariaDbPaths::new(&fx.app);
        fs::create_dir_all(paths.data_dir.join("mysql")).expect("mysql");
        fs::write(paths.data_dir.join("ibdata1"), b"x").expect("ibdata1");
        let no_maria = RunEnvironment {
            path_prepend: vec![],
            vars: vec![],
        };

        let error = mariadb_start_plan(&no_maria, &paths, Some(path)).expect_err("no mariadb");

        assert_eq!(error.to_string(), "MariaDB runtime is not installed yet.");
    }

    #[test]
    fn the_init_command_hides_the_password_in_its_display_but_passes_it_to_the_tool() {
        let fx = fixture();
        let paths = MariaDbPaths::new(&fx.app);

        let plan = mariadb_init_plan(&fx.env, &paths, "AbCdEf123456XyZ", None).expect("plan");

        assert!(plan.argv.iter().any(|a| a == "--password=AbCdEf123456XyZ"));
        assert!(plan.display.contains("--password=***"), "{}", plan.display);
        assert!(!plan.display.contains("AbCdEf"), "{}", plan.display);
        assert!(plan
            .argv
            .iter()
            .any(|a| a.starts_with("--datadir=") && a.contains("Open Mind Studio")));
    }

    #[test]
    fn weak_or_unsafe_passwords_are_refused() {
        let too_long = "a".repeat(65);
        for bad in [
            "abc",
            "has space 123456789",
            "quote\"123456789012",
            "semi;colon123456",
            "it's'root",
            too_long.as_str(),
        ] {
            assert!(validate_password(bad).is_err(), "{bad}");
        }
        assert!(validate_password("AbCdEf123456XyZ").is_ok());
        // The default local password, and the generated ones of older installs.
        assert!(validate_password(MARIADB_DEFAULT_PASSWORD).is_ok());
    }

    #[test]
    fn the_admin_command_targets_loopback_and_keeps_the_password_off_the_command_line() {
        let fx = fixture();

        let plan = mariadb_admin_plan(
            &fx.env,
            3307,
            AdminAction::Shutdown,
            "AbCdEf123456XyZ",
            None,
        )
        .expect("plan");

        assert!(plan.argv.iter().any(|a| a == "--host=127.0.0.1"));
        assert!(plan.argv.iter().any(|a| a == "--port=3307"));
        assert_eq!(plan.argv.last().map(String::as_str), Some("shutdown"));
        assert!(
            !plan.argv.iter().any(|a| a.contains("AbCdEf")),
            "{:?}",
            plan.argv
        );
        assert!(plan
            .env
            .contains(&("MYSQL_PWD".to_string(), "AbCdEf123456XyZ".to_string())));
        assert!(!plan.display.contains("AbCdEf"));
        let ping = mariadb_admin_plan(&fx.env, 3307, AdminAction::Ping, "AbCdEf123456XyZ", None)
            .expect("ping");
        assert_eq!(ping.argv.last().map(String::as_str), Some("ping"));
    }

    #[test]
    fn the_phpmyadmin_config_uses_cookie_login_on_the_mariadb_port_and_a_portable_temp_dir() {
        let secret = "a".repeat(32);

        let text = render_phpmyadmin_config(
            &secret,
            3307,
            Path::new("C:\\Open Mind\\cache\\phpmyadmin"),
            PmaLogin::Cookie,
        )
        .expect("config");

        assert!(text.contains("'auth_type'] = 'cookie'"), "{text}");
        assert!(text.contains("'host'] = '127.0.0.1'"), "{text}");
        assert!(text.contains("'port'] = '3307'"), "{text}");
        assert!(text.contains("'AllowNoPassword'] = false"), "{text}");
        assert!(
            text.contains("'TempDir'] = 'C:/Open Mind/cache/phpmyadmin'"),
            "{text}"
        );
        assert!(
            !text.contains("'password'"),
            "no password is stored in the file"
        );
        assert!(
            render_phpmyadmin_config("short", 3307, Path::new("C:/t"), PmaLogin::Cookie).is_err()
        );
        assert!(
            render_phpmyadmin_config(&secret, 3307, Path::new("C:/a'b"), PmaLogin::Cookie).is_err()
        );
    }

    #[test]
    fn the_default_local_credentials_sign_phpmyadmin_in_automatically() {
        let secret = "b".repeat(32);
        let login = PmaLogin::Automatic {
            password: MARIADB_DEFAULT_PASSWORD,
        };
        let text =
            render_phpmyadmin_config(&secret, 3306, Path::new("C:/t"), login).expect("config");
        assert!(text.contains("'auth_type'] = 'config'"), "{text}");
        assert!(text.contains("'user'] = 'root'"), "{text}");
        assert!(text.contains("'password'] = 'root'"), "{text}");
        assert!(text.contains("'host'] = '127.0.0.1'"), "{text}");
        assert!(text.contains("'port'] = '3306'"), "{text}");
        assert!(!text.contains("'cookie'"), "{text}");
        // A password that could break out of the PHP string is refused.
        let bad = PmaLogin::Automatic { password: "x'.y" };
        assert!(render_phpmyadmin_config(&secret, 3306, Path::new("C:/t"), bad).is_err());
    }

    #[test]
    fn mysql_s_usual_port_comes_first_then_the_earlier_default() {
        assert_eq!(MARIADB_DEFAULT_PORTS, [3306, 3307]);
        assert_eq!(MARIADB_DEFAULT_PORTS[0], MARIADB_DEFAULT_PORT);
        assert_eq!(PHPMYADMIN_DEFAULT_PORTS[0], PHPMYADMIN_DEFAULT_PORT);
        assert!(PHPMYADMIN_DEFAULT_PORTS
            .iter()
            .all(|port| validate_service_port(*port).is_ok()));
    }

    #[test]
    fn composer_runs_its_phar_on_the_portable_php_in_the_project_with_a_portable_home() {
        let fx = fixture();
        let project = fx.dir.path().join("My Project");
        fs::create_dir_all(&project).expect("project");
        fs::write(project.join("composer.json"), "{}").expect("composer.json");
        let phar = fx
            .app
            .join("runtimes")
            .join("composer")
            .join("versions")
            .join("2.10.3")
            .join("composer.phar");
        fs::create_dir_all(phar.parent().expect("parent")).expect("dir");
        fs::write(&phar, b"x").expect("phar");

        let plan = composer_plan(
            ComposerAction::Install,
            &project,
            &phar,
            (
                &fx.app.join("data").join("composer"),
                &fx.app.join("cache").join("composer"),
            ),
            &fx.env,
            None,
        )
        .expect("plan");

        assert!(plan.argv[0].contains("8.4.26"), "{:?}", plan.argv);
        assert_eq!(plan.argv[1], phar.to_string_lossy());
        assert_eq!(
            &plan.argv[2..],
            ["install", "--no-interaction", "--no-ansi"]
        );
        assert_eq!(plan.cwd, project);
        assert_eq!(plan.display, "composer install --no-interaction --no-ansi");
        let home = plan
            .env
            .iter()
            .find(|(k, _)| k == "COMPOSER_HOME")
            .expect("home");
        assert!(home.1.contains("Open Mind Studio"), "{}", home.1);
        assert!(plan.env.iter().any(|(k, _)| k == "COMPOSER_CACHE_DIR"));
    }

    #[test]
    fn composer_needs_a_composer_json_the_phar_and_the_portable_php() {
        let fx = fixture();
        let project = fx.dir.path().join("proj");
        fs::create_dir_all(&project).expect("project");
        let phar = fx.dir.path().join("composer.phar");
        fs::write(&phar, b"x").expect("phar");
        let run = |root: &Path, phar: &Path, env: &RunEnvironment| {
            let (home, cache) = (fx.app.join("home"), fx.app.join("cache"));
            composer_plan(
                ComposerAction::Update,
                root,
                phar,
                (&home, &cache),
                env,
                None,
            )
            .expect_err("refused")
            .to_string()
        };

        assert_eq!(
            run(&project, &phar, &fx.env),
            "This folder has no composer.json."
        );
        fs::write(project.join("composer.json"), "{}").expect("composer.json");
        assert_eq!(
            run(&project, &fx.dir.path().join("missing.phar"), &fx.env),
            "Composer runtime is not installed yet."
        );
        let no_php = RunEnvironment {
            path_prepend: vec![],
            vars: vec![],
        };
        assert_eq!(
            run(&project, &phar, &no_php),
            "PHP runtime is not installed yet."
        );
        assert_eq!(
            run(&fx.dir.path().join("gone"), &phar, &fx.env),
            "Select a valid folder first."
        );
    }

    #[test]
    fn composer_actions_are_a_closed_set() {
        assert_eq!(ComposerAction::Install.verb(), "install");
        assert_eq!(ComposerAction::Update.verb(), "update");
        assert_eq!(ComposerAction::DumpAutoload.verb(), "dump-autoload");
        let parsed: ComposerAction = serde_json::from_str("\"dump-autoload\"").expect("parse");
        assert_eq!(parsed, ComposerAction::DumpAutoload);
        assert!(serde_json::from_str::<ComposerAction>("\"require\"").is_err());
        assert!(serde_json::from_str::<ComposerAction>("\"install && calc\"").is_err());
    }

    #[test]
    fn plans_only_extend_the_childs_own_path_never_the_systems() {
        let fx = fixture();
        let paths = MariaDbPaths::new(&fx.app);
        fs::create_dir_all(paths.data_dir.join("mysql")).expect("mysql");
        fs::write(paths.data_dir.join("ibdata1"), b"x").expect("ibdata1");
        let system = std::env::join_paths([fx.dir.path().join("sys")]).expect("path");

        let plan = mariadb_start_plan(&fx.env, &paths, Some(system)).expect("plan");

        let dirs: Vec<PathBuf> = std::env::split_paths(&plan.path_var).collect();
        assert_eq!(dirs[0], fx.env.path_prepend[0], "portable folders first");
        assert!(dirs.contains(&fx.dir.path().join("sys")));
        // Nothing in the plan is a registry or PATH-writing command.
        for arg in &plan.argv {
            assert!(!arg.eq_ignore_ascii_case("setx") && !arg.eq_ignore_ascii_case("reg"));
        }
    }
}
