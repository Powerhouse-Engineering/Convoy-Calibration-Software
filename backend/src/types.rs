use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BoardTarget {
    AppSensor,
    AppController,
}

impl BoardTarget {
    pub fn app_dir_name(self) -> &'static str {
        match self {
            Self::AppSensor => "app_sensor",
            Self::AppController => "app_controller",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::AppSensor => "app_sensor",
            Self::AppController => "app_controller",
        }
    }
}

impl fmt::Display for BoardTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for BoardTarget {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.eq_ignore_ascii_case("app_sensor")
            || value.eq_ignore_ascii_case("sensor")
            || value.eq_ignore_ascii_case("ass")
        {
            return Ok(Self::AppSensor);
        }
        if value.eq_ignore_ascii_case("app_controller")
            || value.eq_ignore_ascii_case("controller")
            || value.eq_ignore_ascii_case("asc")
        {
            return Ok(Self::AppController);
        }

        Err(format!(
            "unsupported board '{value}' (expected ass/app_sensor or asc/app_controller)"
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImuModel {
    Icm45686,
    Bno086,
}

impl ImuModel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Icm45686 => "icm45686",
            Self::Bno086 => "bno086",
        }
    }
}

impl fmt::Display for ImuModel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ImuModel {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.eq_ignore_ascii_case("icm45686") || value.eq_ignore_ascii_case("icm") {
            return Ok(Self::Icm45686);
        }
        if value.eq_ignore_ascii_case("bno086") || value.eq_ignore_ascii_case("bno") {
            return Ok(Self::Bno086);
        }

        Err(format!(
            "unsupported imu '{value}' (expected icm45686 or bno086)"
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EraseStrategy {
    Sector,
    Chip,
}

impl EraseStrategy {
    pub fn as_nrfjprog_arg(self) -> &'static str {
        match self {
            Self::Sector => "--sectorerase",
            Self::Chip => "--chiperase",
        }
    }
}

impl FromStr for EraseStrategy {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.eq_ignore_ascii_case("sector") {
            return Ok(Self::Sector);
        }
        if value.eq_ignore_ascii_case("chip") || value.eq_ignore_ascii_case("eraseall") {
            return Ok(Self::Chip);
        }

        Err(format!(
            "unsupported erase strategy '{value}' (expected sector or chip)"
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildRequest {
    pub board_target: BoardTarget,
    pub board_name: String,
    pub build_type: String,
    pub repo_root: PathBuf,
    pub build_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildResult {
    pub board_target: BoardTarget,
    pub board_name: String,
    pub build_type: String,
    pub build_dir: PathBuf,
    pub hex_path: PathBuf,
    pub stdout_tail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlashRequest {
    pub board_target: BoardTarget,
    pub imu_model: ImuModel,
    pub serial_number: Option<String>,
    pub hex_path: Option<PathBuf>,
    pub erase_strategy: EraseStrategy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlashResult {
    pub board_target: BoardTarget,
    pub imu_model: ImuModel,
    pub serial_number: Option<String>,
    pub hex_path: PathBuf,
    pub erase_strategy: EraseStrategy,
    pub stdout_tail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolStatus {
    pub executable: String,
    pub available: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolchainStatus {
    pub nrfjprog: ToolStatus,
    pub jlink_gdb_server: ToolStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IcmCsvSample {
    pub host_elapsed_s: f32,
    pub seq: u32,
    pub timestamp_ms: u32,
    pub sample_count: u32,
    pub accel_mps2: [f32; 3],
    pub gyro_dps: [f32; 3],
    pub temp_c: f32,
    pub temp_valid: bool,
    pub accel_accuracy: u8,
    pub gyro_accuracy: u8,
    pub cal_state: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IcmCaptureCalibrationRequest {
    pub serial_number: Option<String>,
    pub device_name: String,
    pub speed_khz: u32,
    pub gdb_port: u16,
    pub rtt_telnet_port: u16,
    pub connect_timeout_ms: u64,
    pub ack_timeout_ms: u64,
    pub capture_seconds: f32,
    pub gyro_bias_seconds: f32,
    pub compute_gyro: bool,
    pub compute_accel: bool,
    pub min_total_samples: usize,
    pub min_gyro_samples: usize,
    pub min_accel_points: usize,
    pub odr_hz: u32,
    pub stream_hz: u32,
    pub accel_range_g: u32,
    pub gyro_range_dps: u32,
    pub low_noise: bool,
    pub fifo: bool,
    pub fifo_hires: bool,
    #[serde(default)]
    pub keep_stream_running: bool,
}

impl Default for IcmCaptureCalibrationRequest {
    fn default() -> Self {
        Self {
            serial_number: None,
            device_name: "nRF52840_xxAA".to_string(),
            speed_khz: 4000,
            gdb_port: 2335,
            rtt_telnet_port: 19025,
            connect_timeout_ms: 10_000,
            ack_timeout_ms: 2_000,
            capture_seconds: 30.0,
            gyro_bias_seconds: 5.0,
            compute_gyro: true,
            compute_accel: true,
            min_total_samples: 80,
            min_gyro_samples: 20,
            min_accel_points: 80,
            odr_hz: 200,
            stream_hz: 200,
            accel_range_g: 16,
            gyro_range_dps: 2000,
            low_noise: true,
            fifo: true,
            fifo_hires: false,
            keep_stream_running: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IcmCalibrationEstimate {
    pub sample_count: usize,
    pub gyro_sample_count: usize,
    pub gyro_bias_dps: [f32; 3],
    pub accel_offset_mps2: [f32; 3],
    pub accel_xform: [[f32; 3]; 3],
    pub residual_rms_mps2: f32,
    pub residual_max_mps2: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IcmCaptureCalibrationResult {
    pub estimate: IcmCalibrationEstimate,
    pub computed_gyro: bool,
    pub computed_accel: bool,
    pub responses: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IcmWriteCalibrationRequest {
    pub serial_number: Option<String>,
    pub device_name: String,
    pub speed_khz: u32,
    pub gdb_port: u16,
    pub rtt_telnet_port: u16,
    pub connect_timeout_ms: u64,
    pub ack_timeout_ms: u64,
    pub odr_hz: u32,
    pub accel_range_g: u32,
    pub gyro_range_dps: u32,
    pub low_noise: bool,
    pub fifo: bool,
    pub fifo_hires: bool,
    pub write_gyro_bias: bool,
    pub write_accel: bool,
    pub estimate: IcmCalibrationEstimate,
}

impl Default for IcmWriteCalibrationRequest {
    fn default() -> Self {
        Self {
            serial_number: None,
            device_name: "nRF52840_xxAA".to_string(),
            speed_khz: 4000,
            gdb_port: 2335,
            rtt_telnet_port: 19025,
            connect_timeout_ms: 10_000,
            ack_timeout_ms: 2_000,
            odr_hz: 200,
            accel_range_g: 16,
            gyro_range_dps: 2000,
            low_noise: true,
            fifo: true,
            fifo_hires: false,
            write_gyro_bias: true,
            write_accel: true,
            estimate: IcmCalibrationEstimate {
                sample_count: 0,
                gyro_sample_count: 0,
                gyro_bias_dps: [0.0; 3],
                accel_offset_mps2: [0.0; 3],
                accel_xform: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
                residual_rms_mps2: 0.0,
                residual_max_mps2: 0.0,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RttCommandResult {
    pub command: String,
    pub ack: String,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RttCommandRequest {
    pub serial_number: Option<String>,
    pub device_name: String,
    pub speed_khz: u32,
    pub gdb_port: u16,
    pub rtt_telnet_port: u16,
    pub connect_timeout_ms: u64,
    pub ack_timeout_ms: u64,
    pub commands: Vec<String>,
}

impl Default for RttCommandRequest {
    fn default() -> Self {
        Self {
            serial_number: None,
            device_name: "nRF52840_xxAA".to_string(),
            speed_khz: 4000,
            gdb_port: 2335,
            rtt_telnet_port: 19025,
            connect_timeout_ms: 10_000,
            ack_timeout_ms: 2_000,
            commands: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IcmWriteCalibrationResult {
    pub commands: Vec<RttCommandResult>,
}

#[cfg(test)]
mod tests {
    use super::BoardTarget;
    use std::str::FromStr;

    #[test]
    fn board_target_parses_ass_alias() {
        assert_eq!(
            BoardTarget::from_str("ass").expect("ass should parse"),
            BoardTarget::AppSensor
        );
    }

    #[test]
    fn board_target_parses_asc_alias() {
        assert_eq!(
            BoardTarget::from_str("asc").expect("asc should parse"),
            BoardTarget::AppController
        );
    }
}
