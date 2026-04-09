pub mod backend;
pub mod calibration;
pub mod config;
pub mod manifest;
pub mod process;
pub mod rtt_protocol;
pub mod rtt_text;
pub mod types;

pub use backend::CalibrationBackend;
pub use config::BackendConfig;
pub use rtt_protocol::{
    parse_binary_imu_frame, BnoBinaryPayload, IcmBinaryPayload, ImuBinaryFrame, ImuBinaryPayload,
    RttBinaryHeader, RTT_BIN_BNO_PAYLOAD_LEN, RTT_BIN_FRAME_IMU, RTT_BIN_HEADER_LEN,
    RTT_BIN_ICM_PAYLOAD_LEN, RTT_BIN_MAGIC, RTT_BIN_VERSION,
};
pub use types::{
    BoardTarget, BuildRequest, BuildResult, EraseStrategy, FlashRequest, FlashResult,
    IcmCalibrationEstimate, IcmCaptureCalibrationRequest, IcmCaptureCalibrationResult,
    IcmCsvSample, IcmWriteCalibrationRequest, IcmWriteCalibrationResult, ImuModel,
    RttCommandRequest, RttCommandResult, ToolStatus, ToolchainStatus,
};

use std::io;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum BackendError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("tool not available: {0}")]
    ToolUnavailable(String),

    #[error("manifest error: {0}")]
    Manifest(String),

    #[error(
        "command failed: {program} (exit={exit_code:?})\\nstdout:\\n{stdout}\\nstderr:\\n{stderr}"
    )]
    CommandFailed {
        program: String,
        exit_code: Option<i32>,
        stdout: String,
        stderr: String,
    },
}

pub type Result<T> = std::result::Result<T, BackendError>;
