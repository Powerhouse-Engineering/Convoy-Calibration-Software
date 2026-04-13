use calibration_backend::{
    BackendConfig, BackendError, BoardTarget, CalibrationBackend, EraseStrategy, FlashRequest,
    IcmCalibrationEstimate, IcmCaptureCalibrationRequest, IcmWriteCalibrationRequest, ImuModel,
    RttCommandRequest,
};
use clap::{Parser, Subcommand};
use serde::Serialize;
use std::path::PathBuf;
use std::process::ExitCode;
use std::str::FromStr;

#[derive(Debug, Parser)]
#[command(name = "calibration-backend")]
#[command(about = "Factory calibration backend for IMU flash/calibration")]
struct Cli {
    #[arg(long)]
    firmware_dir: Option<PathBuf>,

    #[arg(long)]
    nrfjprog: Option<String>,

    #[arg(long)]
    jlink_gdb_server: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Tools,
    Probes,
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

        #[arg(long, default_value_t = 2335)]
        gdb_port: u16,

        #[arg(long, default_value_t = 19025)]
        rtt_telnet_port: u16,

        #[arg(long, default_value_t = 10_000)]
        connect_timeout_ms: u64,

        #[arg(long, default_value_t = 2_000)]
        ack_timeout_ms: u64,

        #[arg(long = "cmd", required = true)]
        commands: Vec<String>,
    },
    RttHold {
        #[arg(long)]
        serial_number: Option<String>,

        #[arg(long, default_value = "nRF52840_xxAA")]
        device_name: String,

        #[arg(long, default_value_t = 4000)]
        speed_khz: u32,

        #[arg(long, default_value_t = 2335)]
        gdb_port: u16,

        #[arg(long, default_value_t = 19025)]
        rtt_telnet_port: u16,

        #[arg(long, default_value_t = 10_000)]
        connect_timeout_ms: u64,

        #[arg(long, default_value_t = 2_000)]
        ack_timeout_ms: u64,

        #[arg(long, default_value_t = 30)]
        hold_seconds: u64,

        #[arg(long, default_value_t = false)]
        ping: bool,
    },
    IcmCaptureCal {
        #[arg(long)]
        serial_number: Option<String>,

        #[arg(long, default_value = "nRF52840_xxAA")]
        device_name: String,

        #[arg(long, default_value_t = 4000)]
        speed_khz: u32,

        #[arg(long, default_value_t = 2335)]
        gdb_port: u16,

        #[arg(long, default_value_t = 19025)]
        rtt_telnet_port: u16,

        #[arg(long, default_value_t = 10_000)]
        connect_timeout_ms: u64,

        #[arg(long, default_value_t = 2_000)]
        ack_timeout_ms: u64,

        #[arg(long, default_value_t = 30.0)]
        capture_seconds: f32,

        #[arg(long, default_value_t = 5.0)]
        gyro_bias_seconds: f32,

        #[arg(long, default_value = "true")]
        compute_gyro: String,

        #[arg(long, default_value = "true")]
        compute_accel: String,

        #[arg(long, default_value_t = 80)]
        min_total_samples: usize,

        #[arg(long, default_value_t = 20)]
        min_gyro_samples: usize,

        #[arg(long, default_value_t = 80)]
        min_accel_points: usize,

        #[arg(long, default_value = "icm45686")]
        imu: String,

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

        #[arg(long, default_value_t = true)]
        bno_raw: bool,

        #[arg(long, default_value_t = true)]
        bno_6dof: bool,

        #[arg(long, default_value_t = false)]
        keep_stream_running: bool,

        #[arg(long, default_value_t = 1)]
        plot_decimation: u32,
    },
    IcmWriteCal {
        #[arg(long)]
        serial_number: Option<String>,

        #[arg(long, default_value = "nRF52840_xxAA")]
        device_name: String,

        #[arg(long, default_value_t = 4000)]
        speed_khz: u32,

        #[arg(long, default_value_t = 2335)]
        gdb_port: u16,

        #[arg(long, default_value_t = 19025)]
        rtt_telnet_port: u16,

        #[arg(long, default_value_t = 10_000)]
        connect_timeout_ms: u64,

        #[arg(long, default_value_t = 2_000)]
        ack_timeout_ms: u64,

        #[arg(long, default_value = "icm45686")]
        imu: String,

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

        #[arg(long, default_value_t = true)]
        bno_raw: bool,

        #[arg(long, default_value_t = true)]
        bno_6dof: bool,

        #[arg(long, default_value = "true")]
        write_gyro_bias: String,

        #[arg(long, default_value = "true")]
        write_accel: String,

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
    if let Some(value) = cli.nrfjprog {
        config.nrfjprog_executable = value;
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
        Command::RttHold {
            serial_number,
            device_name,
            speed_khz,
            gdb_port,
            rtt_telnet_port,
            connect_timeout_ms,
            ack_timeout_ms,
            hold_seconds,
            ping,
        } => {
            use std::time::{Duration, Instant};

            let mut session = backend.open_rtt_text_session(
                serial_number,
                device_name,
                speed_khz,
                gdb_port,
                rtt_telnet_port,
                connect_timeout_ms,
            )?;

            let ack_timeout = Duration::from_millis(ack_timeout_ms.max(500));
            if ping {
                let _ = session.send_command_and_wait_ack("PING", ack_timeout)?;
            }

            let hold_for = Duration::from_secs(hold_seconds.max(1));
            let end = Instant::now() + hold_for;
            let mut lines_seen = 0usize;
            let mut process_dropped = false;

            while Instant::now() < end {
                if !session.is_process_alive()? {
                    process_dropped = true;
                    break;
                }

                let read_deadline = Instant::now() + Duration::from_millis(220);
                if session.read_line_until(read_deadline)?.is_some() {
                    lines_seen += 1;
                }
            }

            #[derive(Serialize)]
            struct HoldResult {
                held_seconds: u64,
                lines_seen: usize,
                process_alive: bool,
            }

            print_json(&HoldResult {
                held_seconds: hold_seconds.max(1),
                lines_seen,
                process_alive: !process_dropped,
            })?;
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
            compute_gyro,
            compute_accel,
            min_total_samples,
            min_gyro_samples,
            min_accel_points,
            imu,
            odr_hz,
            stream_hz,
            accel_range_g,
            gyro_range_dps,
            low_noise,
            fifo,
            fifo_hires,
            bno_raw,
            bno_6dof,
            keep_stream_running,
            plot_decimation,
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
                compute_gyro: parse_bool_arg(&compute_gyro, "--compute-gyro")?,
                compute_accel: parse_bool_arg(&compute_accel, "--compute-accel")?,
                min_total_samples,
                min_gyro_samples,
                min_accel_points,
                imu_model: parse_imu_model(&imu)?,
                odr_hz,
                stream_hz,
                accel_range_g,
                gyro_range_dps,
                low_noise,
                fifo,
                fifo_hires,
                bno_raw,
                bno_6dof,
                keep_stream_running,
                plot_decimation,
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
            imu,
            odr_hz,
            accel_range_g,
            gyro_range_dps,
            low_noise,
            fifo,
            fifo_hires,
            bno_raw,
            bno_6dof,
            write_gyro_bias,
            write_accel,
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
                imu_model: parse_imu_model(&imu)?,
                odr_hz,
                accel_range_g,
                gyro_range_dps,
                low_noise,
                fifo,
                fifo_hires,
                bno_raw,
                bno_6dof,
                write_gyro_bias: parse_bool_arg(&write_gyro_bias, "--write-gyro-bias")?,
                write_accel: parse_bool_arg(&write_accel, "--write-accel")?,
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

fn parse_bool_arg(value: &str, option: &str) -> Result<bool, BackendError> {
    if value.eq_ignore_ascii_case("1")
        || value.eq_ignore_ascii_case("true")
        || value.eq_ignore_ascii_case("yes")
        || value.eq_ignore_ascii_case("on")
    {
        return Ok(true);
    }
    if value.eq_ignore_ascii_case("0")
        || value.eq_ignore_ascii_case("false")
        || value.eq_ignore_ascii_case("no")
        || value.eq_ignore_ascii_case("off")
    {
        return Ok(false);
    }

    Err(BackendError::InvalidInput(format!(
        "invalid {option} value: {value}"
    )))
}

fn print_json<T: Serialize>(value: &T) -> Result<(), BackendError> {
    let text = serde_json::to_string_pretty(value)?;
    println!("{text}");
    Ok(())
}
