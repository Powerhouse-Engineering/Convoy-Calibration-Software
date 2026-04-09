use std::env;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct BackendConfig {
    pub firmware_bundle_dir: PathBuf,
    pub repo_root: Option<PathBuf>,
    pub nrfjprog_executable: String,
    pub west_executable: String,
    pub jlink_gdb_server_executable: String,
}

impl BackendConfig {
    pub fn from_env() -> Self {
        let firmware_bundle_dir = env::var("CAL_SW_FIRMWARE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| default_firmware_dir());

        let repo_root = env::var("CAL_SW_REPO_ROOT").ok().map(PathBuf::from);
        let nrfjprog_executable =
            env::var("CAL_SW_NRFJPROG").unwrap_or_else(|_| "nrfjprog".to_string());
        let west_executable = env::var("CAL_SW_WEST").unwrap_or_else(|_| "west".to_string());
        let jlink_gdb_server_executable = env::var("CAL_SW_JLINK_GDB_SERVER")
            .unwrap_or_else(|_| default_jlink_gdb_server_executable());

        Self {
            firmware_bundle_dir,
            repo_root,
            nrfjprog_executable,
            west_executable,
            jlink_gdb_server_executable,
        }
    }
}

impl Default for BackendConfig {
    fn default() -> Self {
        Self::from_env()
    }
}

fn default_firmware_dir() -> PathBuf {
    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let sibling = exe_dir.join("firmware");
            if sibling.exists() {
                return sibling;
            }

            if let Some(parent) = exe_dir.parent() {
                let nested = parent.join("firmware");
                if nested.exists() {
                    return nested;
                }
            }
        }
    }

    PathBuf::from("firmware")
}

fn default_jlink_gdb_server_executable() -> String {
    if cfg!(target_os = "windows") {
        "JLinkGDBServerCLExe".to_string()
    } else {
        "JLinkGDBServerCL".to_string()
    }
}
