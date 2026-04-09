#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use calibration_backend::{
    BackendConfig, BoardTarget, BuildRequest, CalibrationBackend, EraseStrategy, FlashRequest,
    IcmCalibrationEstimate, IcmCaptureCalibrationRequest, IcmWriteCalibrationRequest, ImuModel,
    RttCommandRequest,
};
use serde_json::Value;
use std::path::PathBuf;
use std::str::FromStr;

#[tauri::command]
async fn run_backend_cli(args: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || execute_backend_args(args))
        .await
        .map_err(|err| format!("backend task join error: {err}"))?
}

fn execute_backend_args(args: Vec<String>) -> Result<Value, String> {
    let mut cursor = ArgCursor::new(args);
    let mut config = BackendConfig::default();

    parse_global_options(&mut cursor, &mut config)?;

    let command = cursor
        .next()
        .ok_or_else(|| {
            "missing command (expected tools|probes|build|flash|rtt-command|icm-capture-cal|icm-write-cal)"
                .to_string()
        })?;

    let backend = CalibrationBackend::new(config.clone());

    match command.as_str() {
        "tools" => to_json(backend.check_tools()),
        "probes" => {
            let probes = backend.list_probes().map_err(|err| err.to_string())?;
            to_json(probes)
        }
        "build" => {
            let mut board: Option<String> = None;
            let mut board_name = "nrf52840dk/nrf52840".to_string();
            let mut build_type = "imu_calibration_rtt".to_string();
            let mut build_dir: Option<PathBuf> = None;

            while let Some(flag) = cursor.next() {
                match flag.as_str() {
                    "--board" => board = Some(cursor.require_value("--board")?),
                    "--board-name" => board_name = cursor.require_value("--board-name")?,
                    "--build-type" => build_type = cursor.require_value("--build-type")?,
                    "--build-dir" => {
                        build_dir = Some(PathBuf::from(cursor.require_value("--build-dir")?))
                    }
                    _ => return Err(format!("unknown build option: {flag}")),
                }
            }

            let board_target = BoardTarget::from_str(
                &board.ok_or_else(|| "build requires --board <ass|asc>".to_string())?,
            )
            .map_err(|err| err.to_string())?;

            let repo_root = config.repo_root.ok_or_else(|| {
                "build requires --repo-root <path> (or CAL_SW_REPO_ROOT env var)".to_string()
            })?;

            let request = BuildRequest {
                board_target,
                board_name,
                build_type,
                build_dir: build_dir.unwrap_or_else(|| {
                    repo_root
                        .join("build_calibration")
                        .join(board_target.as_str())
                }),
                repo_root,
            };

            let result = backend
                .build_calibration_image(request)
                .map_err(|err| err.to_string())?;
            to_json(result)
        }
        "flash" => {
            let mut board: Option<String> = None;
            let mut imu: Option<String> = None;
            let mut serial_number: Option<String> = None;
            let mut hex_path: Option<PathBuf> = None;
            let mut erase_strategy = EraseStrategy::Sector;

            while let Some(flag) = cursor.next() {
                match flag.as_str() {
                    "--board" => board = Some(cursor.require_value("--board")?),
                    "--imu" => imu = Some(cursor.require_value("--imu")?),
                    "--serial-number" => {
                        serial_number = Some(cursor.require_value("--serial-number")?)
                    }
                    "--hex" => hex_path = Some(PathBuf::from(cursor.require_value("--hex")?)),
                    "--erase" => {
                        erase_strategy = EraseStrategy::from_str(&cursor.require_value("--erase")?)
                            .map_err(|err| err.to_string())?
                    }
                    _ => return Err(format!("unknown flash option: {flag}")),
                }
            }

            let board_target = BoardTarget::from_str(
                &board.ok_or_else(|| "flash requires --board <ass|asc>".to_string())?,
            )
            .map_err(|err| err.to_string())?;

            let imu_model = ImuModel::from_str(
                &imu.ok_or_else(|| "flash requires --imu <icm45686|bno086>".to_string())?,
            )
            .map_err(|err| err.to_string())?;

            let request = FlashRequest {
                board_target,
                imu_model,
                serial_number,
                hex_path,
                erase_strategy,
            };

            let result = backend
                .flash_image(request)
                .map_err(|err| err.to_string())?;
            to_json(result)
        }
        "rtt-command" => {
            let mut request = RttCommandRequest::default();

            while let Some(flag) = cursor.next() {
                match flag.as_str() {
                    "--serial-number" => {
                        request.serial_number = Some(cursor.require_value("--serial-number")?)
                    }
                    "--device-name" => {
                        request.device_name = cursor.require_value("--device-name")?
                    }
                    "--speed-khz" => {
                        request.speed_khz =
                            parse_u32(&cursor.require_value("--speed-khz")?, flag.as_str())?
                    }
                    "--gdb-port" => {
                        request.gdb_port =
                            parse_u16(&cursor.require_value("--gdb-port")?, flag.as_str())?
                    }
                    "--rtt-telnet-port" => {
                        request.rtt_telnet_port =
                            parse_u16(&cursor.require_value("--rtt-telnet-port")?, flag.as_str())?
                    }
                    "--connect-timeout-ms" => {
                        request.connect_timeout_ms = parse_u64(
                            &cursor.require_value("--connect-timeout-ms")?,
                            flag.as_str(),
                        )?
                    }
                    "--ack-timeout-ms" => {
                        request.ack_timeout_ms =
                            parse_u64(&cursor.require_value("--ack-timeout-ms")?, flag.as_str())?
                    }
                    "--cmd" => request.commands.push(cursor.require_value("--cmd")?),
                    _ => return Err(format!("unknown rtt-command option: {flag}")),
                }
            }

            let result = backend
                .send_rtt_commands(request)
                .map_err(|err| err.to_string())?;
            to_json(result)
        }
        "icm-capture-cal" => {
            let mut request = IcmCaptureCalibrationRequest::default();

            while let Some(flag) = cursor.next() {
                match flag.as_str() {
                    "--serial-number" => {
                        request.serial_number = Some(cursor.require_value("--serial-number")?)
                    }
                    "--device-name" => {
                        request.device_name = cursor.require_value("--device-name")?
                    }
                    "--speed-khz" => {
                        request.speed_khz =
                            parse_u32(&cursor.require_value("--speed-khz")?, flag.as_str())?
                    }
                    "--gdb-port" => {
                        request.gdb_port =
                            parse_u16(&cursor.require_value("--gdb-port")?, flag.as_str())?
                    }
                    "--rtt-telnet-port" => {
                        request.rtt_telnet_port =
                            parse_u16(&cursor.require_value("--rtt-telnet-port")?, flag.as_str())?
                    }
                    "--connect-timeout-ms" => {
                        request.connect_timeout_ms = parse_u64(
                            &cursor.require_value("--connect-timeout-ms")?,
                            flag.as_str(),
                        )?
                    }
                    "--ack-timeout-ms" => {
                        request.ack_timeout_ms =
                            parse_u64(&cursor.require_value("--ack-timeout-ms")?, flag.as_str())?
                    }
                    "--capture-seconds" => {
                        request.capture_seconds =
                            parse_f32(&cursor.require_value("--capture-seconds")?, flag.as_str())?
                    }
                    "--gyro-bias-seconds" => {
                        request.gyro_bias_seconds =
                            parse_f32(&cursor.require_value("--gyro-bias-seconds")?, flag.as_str())?
                    }
                    "--odr-hz" => {
                        request.odr_hz =
                            parse_u32(&cursor.require_value("--odr-hz")?, flag.as_str())?
                    }
                    "--stream-hz" => {
                        request.stream_hz =
                            parse_u32(&cursor.require_value("--stream-hz")?, flag.as_str())?
                    }
                    "--accel-range-g" => {
                        request.accel_range_g =
                            parse_u32(&cursor.require_value("--accel-range-g")?, flag.as_str())?
                    }
                    "--gyro-range-dps" => {
                        request.gyro_range_dps =
                            parse_u32(&cursor.require_value("--gyro-range-dps")?, flag.as_str())?
                    }
                    "--low-noise" => {
                        request.low_noise =
                            parse_bool(&cursor.require_value("--low-noise")?, flag.as_str())?
                    }
                    "--fifo" => {
                        request.fifo = parse_bool(&cursor.require_value("--fifo")?, flag.as_str())?
                    }
                    "--fifo-hires" => {
                        request.fifo_hires =
                            parse_bool(&cursor.require_value("--fifo-hires")?, flag.as_str())?
                    }
                    _ => return Err(format!("unknown icm-capture-cal option: {flag}")),
                }
            }

            let result = backend
                .capture_icm_calibration(request)
                .map_err(|err| err.to_string())?;
            to_json(result)
        }
        "icm-write-cal" => {
            let mut request = IcmWriteCalibrationRequest::default();
            let mut estimate: Option<IcmCalibrationEstimate> = None;

            while let Some(flag) = cursor.next() {
                match flag.as_str() {
                    "--serial-number" => {
                        request.serial_number = Some(cursor.require_value("--serial-number")?)
                    }
                    "--device-name" => {
                        request.device_name = cursor.require_value("--device-name")?
                    }
                    "--speed-khz" => {
                        request.speed_khz =
                            parse_u32(&cursor.require_value("--speed-khz")?, flag.as_str())?
                    }
                    "--gdb-port" => {
                        request.gdb_port =
                            parse_u16(&cursor.require_value("--gdb-port")?, flag.as_str())?
                    }
                    "--rtt-telnet-port" => {
                        request.rtt_telnet_port =
                            parse_u16(&cursor.require_value("--rtt-telnet-port")?, flag.as_str())?
                    }
                    "--connect-timeout-ms" => {
                        request.connect_timeout_ms = parse_u64(
                            &cursor.require_value("--connect-timeout-ms")?,
                            flag.as_str(),
                        )?
                    }
                    "--ack-timeout-ms" => {
                        request.ack_timeout_ms =
                            parse_u64(&cursor.require_value("--ack-timeout-ms")?, flag.as_str())?
                    }
                    "--odr-hz" => {
                        request.odr_hz =
                            parse_u32(&cursor.require_value("--odr-hz")?, flag.as_str())?
                    }
                    "--accel-range-g" => {
                        request.accel_range_g =
                            parse_u32(&cursor.require_value("--accel-range-g")?, flag.as_str())?
                    }
                    "--gyro-range-dps" => {
                        request.gyro_range_dps =
                            parse_u32(&cursor.require_value("--gyro-range-dps")?, flag.as_str())?
                    }
                    "--low-noise" => {
                        request.low_noise =
                            parse_bool(&cursor.require_value("--low-noise")?, flag.as_str())?
                    }
                    "--fifo" => {
                        request.fifo = parse_bool(&cursor.require_value("--fifo")?, flag.as_str())?
                    }
                    "--fifo-hires" => {
                        request.fifo_hires =
                            parse_bool(&cursor.require_value("--fifo-hires")?, flag.as_str())?
                    }
                    "--estimate-json" => {
                        let raw = cursor.require_value("--estimate-json")?;
                        estimate = Some(
                            serde_json::from_str::<IcmCalibrationEstimate>(&raw)
                                .map_err(|err| format!("invalid --estimate-json: {err}"))?,
                        );
                    }
                    _ => return Err(format!("unknown icm-write-cal option: {flag}")),
                }
            }

            request.estimate =
                estimate.ok_or_else(|| "icm-write-cal requires --estimate-json".to_string())?;
            let result = backend
                .write_icm_calibration(request)
                .map_err(|err| err.to_string())?;
            to_json(result)
        }
        _ => Err(format!("unsupported command: {command}")),
    }
}

fn parse_global_options(cursor: &mut ArgCursor, config: &mut BackendConfig) -> Result<(), String> {
    while let Some(flag) = cursor.peek() {
        match flag {
            "--firmware-dir" => {
                cursor.next();
                config.firmware_bundle_dir = PathBuf::from(cursor.require_value("--firmware-dir")?);
            }
            "--repo-root" => {
                cursor.next();
                config.repo_root = Some(PathBuf::from(cursor.require_value("--repo-root")?));
            }
            "--nrfjprog" => {
                cursor.next();
                config.nrfjprog_executable = cursor.require_value("--nrfjprog")?;
            }
            "--west" => {
                cursor.next();
                config.west_executable = cursor.require_value("--west")?;
            }
            "--jlink-gdb-server" => {
                cursor.next();
                config.jlink_gdb_server_executable = cursor.require_value("--jlink-gdb-server")?;
            }
            _ => break,
        }
    }

    Ok(())
}

fn parse_u16(value: &str, option: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .map_err(|_| format!("invalid {option} value: {value}"))
}

fn parse_u32(value: &str, option: &str) -> Result<u32, String> {
    value
        .parse::<u32>()
        .map_err(|_| format!("invalid {option} value: {value}"))
}

fn parse_u64(value: &str, option: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|_| format!("invalid {option} value: {value}"))
}

fn parse_f32(value: &str, option: &str) -> Result<f32, String> {
    value
        .parse::<f32>()
        .map_err(|_| format!("invalid {option} value: {value}"))
}

fn parse_bool(value: &str, option: &str) -> Result<bool, String> {
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
    Err(format!("invalid {option} value: {value}"))
}

fn to_json<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|err| err.to_string())
}

struct ArgCursor {
    args: Vec<String>,
    idx: usize,
}

impl ArgCursor {
    fn new(args: Vec<String>) -> Self {
        Self { args, idx: 0 }
    }

    fn peek(&self) -> Option<&str> {
        self.args.get(self.idx).map(String::as_str)
    }

    fn next(&mut self) -> Option<String> {
        if self.idx >= self.args.len() {
            return None;
        }

        let value = self.args[self.idx].clone();
        self.idx += 1;
        Some(value)
    }

    fn require_value(&mut self, option_name: &str) -> Result<String, String> {
        self.next()
            .ok_or_else(|| format!("missing value for {option_name}"))
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![run_backend_cli])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
