use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use directories::ProjectDirs;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub server: ServerConfig,
}

#[derive(Debug, Deserialize)]
pub struct ServerConfig {
    #[serde(default = "default_url")]
    pub url: String,
}

fn default_url() -> String {
    "https://meza.localhost".to_string()
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            url: default_url(),
        }
    }
}

impl Config {
    /// Timestamp format string.
    pub fn timestamp_format(&self) -> &str {
        "%H:%M"
    }

    /// Max scrollback lines.
    pub fn scrollback_limit(&self) -> usize {
        5000
    }

    /// Reconnect delay in seconds.
    pub fn reconnect_secs(&self) -> u64 {
        10
    }

    /// Network timeout in seconds.
    pub fn timeout_secs(&self) -> u64 {
        30
    }
}

/// Return the `ProjectDirs` for meza, or error.
fn project_dirs() -> Result<ProjectDirs> {
    ProjectDirs::from("com", "ouijit", "meza")
        .context("unable to determine home directory for config paths")
}

/// Return the config file path (~/.config/meza/config.toml).
pub fn config_path() -> Result<PathBuf> {
    Ok(project_dirs()?.config_dir().join("config.toml"))
}

/// Return the data directory (~/.local/share/meza/).
pub fn data_dir() -> Result<PathBuf> {
    Ok(project_dirs()?.data_dir().to_path_buf())
}

/// Load (or create default) config.
pub fn load() -> Result<Config> {
    let path = config_path()?;

    if !path.exists() {
        // Ensure parent directory exists.
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create config dir: {}", parent.display()))?;
        }

        let default_toml = r#"[server]
url = "https://meza.localhost"
"#;
        fs::write(&path, default_toml)
            .with_context(|| format!("failed to write default config: {}", path.display()))?;

        // Set 0600 permissions on Unix.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = fs::Permissions::from_mode(0o600);
            fs::set_permissions(&path, perms)?;
        }
    }

    let contents = fs::read_to_string(&path)
        .with_context(|| format!("failed to read config: {}", path.display()))?;

    let config: Config =
        toml::from_str(&contents).with_context(|| "failed to parse config.toml")?;

    // Ensure data dir exists.
    let data = data_dir()?;
    fs::create_dir_all(&data)
        .with_context(|| format!("failed to create data dir: {}", data.display()))?;

    Ok(config)
}
