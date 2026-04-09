use calibration_backend::{
    BackendConfig, BackendError, BoardTarget, BuildRequest, CalibrationBackend, EraseStrategy,
    FlashRequest, IcmCalibrationEstimate, IcmCaptureCalibrationRequest, IcmWriteCalibrationRequest,
    ImuModel, RttCommandRequest,
};
use clap::{Parser, Subcommand};
use serde::Serialize;
use std::path::PathBuf;
use std::process::ExitCode;
use std::str::FromStr;

#[derive(Debug, Parser)]
#[command(name = "calibration-backend")]
#[command(about = "Factory calibration backend for IMU firmware build/flash")]
struct Cli {
    #[arg(long)]
    firmware_dir: Option<PathBuf>,

    #[arg(long)]
    repo_root: Option<PathBuf>,

    #[arg(long)]
    nrfjprog: Option<String>,

    #[arg(long)]
    west: Option<String>,

    #[arg(long)]
    jlink_gdb_server: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Tools,
    Probes,
    Build {
        #[arg(long, help = "Board to build: ass|app_sensor|asc|app_controller")]
        board: String,

        #[arg(long, default_value = "nrf52840dk/nrf52840")]
        board_name: String,

        #[arg(long, default_value = "imu_calibration_rtt")]
        build_type: String,

        #[arg(long)]
        build_dir: Option<PathBuf>,
    },
    Flash {
        #[arg(long, help = "Board to flash: ass|app_sensor|asc|app_controller")]
        board: String,

        #[arg(long)]
        imu: String,

        #[arg(long)]
        serial_number: Option<String>,

        #[arg(long)]
        hex: Option<PathBuf>,

        #[arg(long, default_value = "sector")]
        erase: String,
    },
    RttCommand {
        #[arg(long)]
        serial_number: Option<String>,

        #[arg(long, default_value = "nRF52840_xxAA")]
        device_name: String,

        #[arg(long, default_value_t = 4000)]
        speed_khz: u32,

        #[arg(long, default_value_t = 2331)]
        gdb_port: u16,

        #[arg(long, default_value_t = 19021)]
        rtt_telnet_port: u16,

        #[arg(long, default_value_t = 10_000)]
        connect_timeout_ms: u64,

        #[arg(long, default_value_t = 2_000)]
        ack_timeout_ms: u64,

        #[arg(long = "cmd", required = true)]
        commands: Vec<String>,
    },
    IcmCaptureCal {
        #[arg(long)]
        serial_number: Option<String>,

        #[arg(long, default_value = "nRF52840_xxAA")]
        device_name: String,

        #[arg(long, default_value_t = 4000)]
        speed_khz: u32,

        #[arg(long, default_value_t = 2331)]
        gdb_port: u16,

        #[arg(long, default_value_t = 19021)]
        rtt_telnet_port: u16,

        #[arg(long, default_value_t = 10_000)]
        connect_timeout_ms: u64,

        #[arg(long, default_value_t = 2_000)]
        ack_timeout_ms: u64,

        #[arg(long, default_value_t = 30.0)]
        capture_seconds: f32,

        #[arg(long, default_value_t = 5.0)]
        gyro_bias_seconds: f32,

        #[arg(long, default_value_t = 200)]
        odr_hz: u32,

        #[arg(long, default_value_t = 200)]
        stream_hz: u32,

        #[arg(long, default_value_t = 16)]
        accel_range_g: u32,

        #[arg(long, default_value_t = 2000)]
        gyro_range_dps: u32,

        #[arg(long, default_value_t = true)]
        low_noise: bool,

        #[arg(long, default_value_t = true)]
        fifo: bool,

        #[arg(long, default_value_t = false)]
        fifo_hires: bool,
    },
    IcmWriteCal {
        #[arg(long)]
        serial_number: Option<String>,

        #[arg(long, default_value = "nRF52840_xxAA")]
        device_name: String,

        #[arg(long, default_value_t = 4000)]
        speed_khz: u32,

        #[arg(long, default_value_t = 2331)]
        gdb_port: u16,

        #[arg(long, default_value_t = 19021)]
        rtt_telnet_port: u16,

        #[arg(long, default_value_t = 10_000)]
        connect_timeout_ms: u64,

        #[arg(long, default_value_t = 2_000)]
        ack_timeout_ms: u64,

        #[arg(long, default_value_t = 200)]
        odr_hz: u32,

        #[arg(long, default_value_t = 16)]
        accel_range_g: u32,

        #[arg(long, default_value_t = 2000)]
        gyro_range_dps: u32,

        #[arg(long, default_value_t = true)]
        low_noise: bool,

        #[arg(long, default_value_t = true)]
        fifo: bool,

        #[arg(long, default_value_t = false)]
        fifo_hires: bool,

        #[arg(long, help = "JSON-encoded IcmCalibrationEstimate")]
        estimate_json: String,
    },
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("ERROR: {err}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), BackendError> {
    let cli = Cli::parse();
    let mut config = BackendConfig::default();

    if let Some(value) = cli.firmware_dir {
        config.firmware_bundle_dir = value;
    }
    if let Some(value) = cli.repo_root {
        config.repo_root = Some(value);
    }
    if let Some(value) = cli.nrfjprog {
        config.nrfjprog_executable = value;
    }
    if let Some(value) = cli.west {
        config.west_executable = value;
    }
    if let Some(value) = cli.jlink_gdb_server {
        config.jlink_gdb_server_executable = value;
    }

    let backend = CalibrationBackend::new(config.clone());

    match cli.command {
        Command::Tools => {
            print_json(&backend.check_tools())?;
        }
        Command::Probes => {
            let probes = backend.list_probes()?;
            print_json(&probes)?;
        }
        Command::Build {
            board,
            board_name,
            build_type,
            build_dir,
        } => {
            let board_target = parse_board_target(&board)?;
            let repo_root = config.repo_root.clone().ok_or_else(|| {
                BackendError::InvalidInput(
                    "repo root is required for build (use --repo-root or CAL_SW_REPO_ROOT)"
                        .to_string(),
                )
            })?;

            let default_build_dir = repo_root
                .join("build_calibration")
                .join(board_target.as_str());

            let request = BuildRequest {
                board_target,
                board_name,
                build_type,
                repo_root,
                build_dir: build_dir.unwrap_or(default_build_dir),
            };

            let result = backend.build_calibration_image(request)?;
            print_json(&result)?;
        }
        Command::Flash {
            board,
            imu,
            serial_number,
            hex,
            erase,
        } => {
            let request = FlashRequest {
                board_target: parse_board_target(&board)?,
                imu_model: parse_imu_model(&imu)?,
                serial_number,
                hex_path: hex,
                erase_strategy: parse_erase_strategy(&erase)?,
            };

            let result = backend.flash_image(request)?;
            print_json(&result)?;
        }
        Command::RttCommand {
            serial_number,
            device_name,
            speed_khz,
            gdb_port,
            rtt_telnet_port,
            connect_timeout_ms,
            ack_timeout_ms,
            commands,
        } => {
            let request = RttCommandRequest {
                serial_number,
                device_name,
                speed_khz,
                gdb_port,
                rtt_telnet_port,
                connect_timeout_ms,
                ack_timeout_ms,
                commands,
            };

            let result = backend.send_rtt_commands(request)?;
            print_json(&result)?;
        }
        Command::IcmCaptureCal {
            serial_number,
            device_name,
            speed_khz,
            gdb_port,
            rtt_telnet_port,
            connect_timeout_ms,
            ack_timeout_ms,
            capture_seconds,
            gyro_bias_seconds,
            odr_hz,
            stream_hz,
            accel_range_g,
            gyro_range_dps,
            low_noise,
            fifo,
            fifo_hires,
        } => {
            let request = IcmCaptureCalibrationRequest {
                serial_number,
                device_name,
                speed_khz,
                gdb_port,
                rtt_telnet_port,
                connect_timeout_ms,
                ack_timeout_ms,
                capture_seconds,
                gyro_bias_seconds,
                odr_hz,
                stream_hz,
                accel_range_g,
                gyro_range_dps,
                low_noise,
                fifo,
                fifo_hires,
            };

            let result = backend.capture_icm_calibration(request)?;
            print_json(&result)?;
        }
        Command::IcmWriteCal {
            serial_number,
            device_name,
            speed_khz,
            gdb_port,
            rtt_telnet_port,
            connect_timeout_ms,
            ack_timeout_ms,
            odr_hz,
            accel_range_g,
            gyro_range_dps,
            low_noise,
            fifo,
            fifo_hires,
            estimate_json,
        } => {
            let estimate = parse_estimate_json(&estimate_json)?;
            let request = IcmWriteCalibrationRequest {
                serial_number,
                device_name,
                speed_khz,
                gdb_port,
                rtt_telnet_port,
                connect_timeout_ms,
                ack_timeout_ms,
                odr_hz,
                accel_range_g,
                gyro_range_dps,
                low_noise,
                fifo,
                fifo_hires,
                estimate,
            };

            let result = backend.write_icm_calibration(request)?;
            print_json(&result)?;
        }
    }

    Ok(())
}

fn parse_board_target(value: &str) -> Result<BoardTarget, BackendError> {
    BoardTarget::from_str(value).map_err(BackendError::InvalidInput)
}

fn parse_imu_model(value: &str) -> Result<ImuModel, BackendError> {
    ImuModel::from_str(value).map_err(BackendError::InvalidInput)
}

fn parse_erase_strategy(value: &str) -> Result<EraseStrategy, BackendError> {
    EraseStrategy::from_str(value).map_err(BackendError::InvalidInput)
}

fn parse_estimate_json(value: &str) -> Result<IcmCalibrationEstimate, BackendError> {
    serde_json::from_str(value).map_err(BackendError::Json)
}

fn print_json<T: Serialize>(value: &T) -> Result<(), BackendError> {
    let text = serde_json::to_string_pretty(value)?;
    println!("{text}");
    Ok(())
}
