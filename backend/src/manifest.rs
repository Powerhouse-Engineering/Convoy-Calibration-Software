use crate::types::{BoardTarget, ImuModel};
use crate::{BackendError, Result};
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
pub struct FirmwareManifest {
    pub images: Vec<FirmwareImage>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FirmwareImage {
    pub board_target: BoardTarget,
    pub imu_model: ImuModel,
    pub profile: String,
    pub hex: PathBuf,
}

impl FirmwareManifest {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path).map_err(|err| {
            BackendError::Manifest(format!(
                "unable to read manifest '{}': {err}",
                path.display()
            ))
        })?;

        let manifest: Self = serde_json::from_str(&raw).map_err(|err| {
            BackendError::Manifest(format!("invalid manifest '{}': {err}", path.display()))
        })?;

        Ok(manifest)
    }

    pub fn resolve_image(
        &self,
        board_target: BoardTarget,
        imu_model: ImuModel,
        profile: &str,
    ) -> Option<&FirmwareImage> {
        self.images.iter().find(|entry| {
            entry.board_target == board_target
                && entry.imu_model == imu_model
                && entry.profile.eq_ignore_ascii_case(profile)
        })
    }
}
