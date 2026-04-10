use crate::calibration::{
    ensure_min_total_samples, estimate_accel_ellipsoid_with_min_points,
    estimate_gyro_bias_with_min_samples, parse_icm_csv_sample,
};
use crate::config::BackendConfig;
use crate::manifest::FirmwareManifest;
use crate::process::{run_command, tail_lines};
use crate::rtt_text::{RttServerConfig, RttSession};
use crate::types::{
    BuildRequest, BuildResult, FlashRequest, FlashResult, IcmCaptureCalibrationRequest,
    IcmCaptureCalibrationResult, IcmWriteCalibrationRequest, IcmWriteCalibrationResult,
    RttCommandRequest, RttCommandResult, ToolStatus, ToolchainStatus,
};
use crate::{BackendError, Result};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const DEFAULT_PROFILE: &str = "imu_calibration_rtt";

#[derive(Debug, Clone)]
pub struct CalibrationBackend {
    config: BackendConfig,
}

impl CalibrationBackend {
    pub fn new(config: BackendConfig) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &BackendConfig {
        &self.config
    }

    pub fn check_tools(&self) -> ToolchainStatus {
        ToolchainStatus {
            nrfjprog: self.detect_tool(&self.config.nrfjprog_executable, &["--version"]),
            jlink_gdb_server: self.detect_tool(&self.config.jlink_gdb_server_executable, &["-version"]),
        }
    }

    pub fn list_probes(&self) -> Result<Vec<String>> {
        self.ensure_nrfjprog_available()?;

        let output = run_command(
            &self.config.nrfjprog_executable,
            &["--ids".to_string()],
            None,
        )?;

        let probes = output
            .stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<String>>();

        Ok(probes)
    }

    pub fn build_calibration_image(&self, request: BuildRequest) -> Result<BuildResult> {
        self.ensure_west_available()?;

        let app_path = request.repo_root.join(request.board_target.app_dir_name());
        if !app_path.exists() {
            return Err(BackendError::InvalidInput(format!(
                "application directory not found: {}",
                app_path.display()
            )));
        }

        std::fs::create_dir_all(&request.build_dir)?;

        let configure_args = vec![
            "build".to_string(),
            "-b".to_string(),
            request.board_name.clone(),
            app_path.display().to_string(),
            "--build-dir".to_string(),
            request.build_dir.display().to_string(),
            "--pristine".to_string(),
            "--no-sysbuild".to_string(),
            "--cmake-only".to_string(),
            "--".to_string(),
            format!("-DBUILD_TYPE={}", request.build_type),
        ];

        let configure_output = run_command(
            &self.config.west_executable,
            &configure_args,
            Some(request.repo_root.as_path()),
        )?;

        let build_args = vec![
            "--build".to_string(),
            request.build_dir.display().to_string(),
            "--target".to_string(),
            "zephyr.elf".to_string(),
            "-j".to_string(),
            "8".to_string(),
        ];

        let build_output = run_command("cmake", &build_args, Some(request.repo_root.as_path()))?;

        let hex_path = request.build_dir.join("zephyr").join("zephyr.hex");
        if !hex_path.exists() {
            return Err(BackendError::InvalidInput(format!(
                "build completed but hex file was not found at {}",
                hex_path.display()
            )));
        }

        let stdout_tail = tail_lines(
            &format!(
                "{}\n{}\n{}\n{}",
                configure_output.stdout,
                configure_output.stderr,
                build_output.stdout,
                build_output.stderr
            ),
            25,
        );

        Ok(BuildResult {
            board_target: request.board_target,
            board_name: request.board_name,
            build_type: request.build_type,
            build_dir: request.build_dir,
            hex_path,
            stdout_tail,
        })
    }

    pub fn flash_image(&self, request: FlashRequest) -> Result<FlashResult> {
        self.ensure_nrfjprog_available()?;

        let hex_path = match request.hex_path.clone() {
            Some(path) => path,
            None => self.resolve_bundle_image(request.board_target, request.imu_model)?,
        };

        if !hex_path.exists() {
            return Err(BackendError::InvalidInput(format!(
                "hex file does not exist: {}",
                hex_path.display()
            )));
        }

        let mut args = Vec::<String>::new();
        if let Some(snr) = request.serial_number.clone() {
            if !snr.trim().is_empty() {
                args.push("--snr".to_string());
                args.push(snr);
            }
        }

        args.push("--program".to_string());
        args.push(hex_path.display().to_string());
        args.push(request.erase_strategy.as_nrfjprog_arg().to_string());
        args.push("--verify".to_string());
        args.push("--reset".to_string());
        args.push("-f".to_string());
        args.push("NRF52".to_string());

        let output = run_command(&self.config.nrfjprog_executable, &args, None)?;
        let stdout_tail = tail_lines(&format!("{}\n{}", output.stdout, output.stderr), 25);

        Ok(FlashResult {
            board_target: request.board_target,
            imu_model: request.imu_model,
            serial_number: request.serial_number,
            hex_path,
            erase_strategy: request.erase_strategy,
            stdout_tail,
        })
    }

    pub fn capture_icm_calibration(
        &self,
        request: IcmCaptureCalibrationRequest,
    ) -> Result<IcmCaptureCalibrationResult> {
        if !request.compute_gyro && !request.compute_accel {
            return Err(BackendError::InvalidInput(
                "at least one capture mode must be enabled (compute_gyro or compute_accel)"
                    .to_string(),
            ));
        }

        let mut session = self.open_rtt_session(
            request.serial_number.clone(),
            request.device_name.clone(),
            request.speed_khz,
            request.gdb_port,
            request.rtt_telnet_port,
            request.connect_timeout_ms,
        )?;

        let ack_timeout = Duration::from_millis(request.ack_timeout_ms.max(500));
        let mut responses = Vec::<String>::new();

        self.send_icm_setup_commands(
            &mut session,
            request.odr_hz,
            request.stream_hz,
            request.accel_range_g,
            request.gyro_range_dps,
            request.low_noise,
            request.fifo,
            request.fifo_hires,
            ack_timeout,
            &mut responses,
        )?;

        let start_result = session.send_command_and_wait_ack("START", ack_timeout)?;
        responses.extend(start_result.lines);

        let capture_seconds = request.capture_seconds.max(1.0);
        let capture_deadline = Instant::now() + Duration::from_secs_f32(capture_seconds);
        let capture_start = Instant::now();
        let mut samples = Vec::new();

        while Instant::now() < capture_deadline {
            let read_deadline = Instant::now() + Duration::from_millis(200);
            if let Some(line) = session.read_line_until(read_deadline)? {
                if samples.len() < 100 || responses.len() < 300 {
                    responses.push(line.clone());
                }

                if let Some(sample) =
                    parse_icm_csv_sample(&line, capture_start.elapsed().as_secs_f32())
                {
                    samples.push(sample);
                }
            }
        }

        if let Ok(stop_result) = session.send_command_and_wait_ack("STOP", ack_timeout) {
            responses.extend(stop_result.lines);
        }

        ensure_min_total_samples(&samples, request.min_total_samples.max(1))?;

        let mut estimate = crate::types::IcmCalibrationEstimate {
            sample_count: samples.len(),
            gyro_sample_count: 0,
            gyro_bias_dps: [0.0, 0.0, 0.0],
            accel_offset_mps2: [0.0, 0.0, 0.0],
            accel_xform: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            residual_rms_mps2: 0.0,
            residual_max_mps2: 0.0,
        };

        if request.compute_gyro {
            let (gyro_bias, gyro_sample_count) = estimate_gyro_bias_with_min_samples(
                &samples,
                request.gyro_bias_seconds.max(0.5),
                request.min_gyro_samples.max(1),
            )?;
            estimate.gyro_bias_dps = gyro_bias;
            estimate.gyro_sample_count = gyro_sample_count;
        }

        if request.compute_accel {
            let (accel_offset, accel_xform, residual_rms, residual_max, _point_count) =
                estimate_accel_ellipsoid_with_min_points(
                    &samples,
                    request.min_accel_points.max(1),
                )?;
            estimate.accel_offset_mps2 = accel_offset;
            estimate.accel_xform = accel_xform;
            estimate.residual_rms_mps2 = residual_rms;
            estimate.residual_max_mps2 = residual_max;
        }

        Ok(IcmCaptureCalibrationResult {
            estimate,
            computed_gyro: request.compute_gyro,
            computed_accel: request.compute_accel,
            responses,
        })
    }

    pub fn send_rtt_commands(&self, request: RttCommandRequest) -> Result<Vec<RttCommandResult>> {
        if request.commands.is_empty() {
            return Err(BackendError::InvalidInput(
                "at least one RTT command is required".to_string(),
            ));
        }

        let mut last_retryable_error: Option<BackendError> = None;

        for attempt in 0..2 {
            let mut session = self.open_rtt_session(
                request.serial_number.clone(),
                request.device_name.clone(),
                request.speed_khz,
                request.gdb_port,
                request.rtt_telnet_port,
                request.connect_timeout_ms,
            )?;

            let ack_timeout = Duration::from_millis(request.ack_timeout_ms.max(500));
            let mut results = Vec::with_capacity(request.commands.len());
            let mut retry_needed = false;

            for command in &request.commands {
                match session.send_command_and_wait_ack(command, ack_timeout) {
                    Ok(result) => results.push(result),
                    Err(err) => {
                        if attempt == 0 && is_retryable_rtt_io_error(&err) {
                            last_retryable_error = Some(err);
                            retry_needed = true;
                            break;
                        }
                        return Err(err);
                    }
                }
            }

            if !retry_needed {
                return Ok(results);
            }

            std::thread::sleep(Duration::from_millis(200));
        }

        if let Some(err) = last_retryable_error {
            return Err(err);
        }

        Err(BackendError::InvalidInput(
            "failed to run RTT commands after retry".to_string(),
        ))
    }

    pub fn open_rtt_text_session(
        &self,
        serial_number: Option<String>,
        device_name: String,
        speed_khz: u32,
        gdb_port: u16,
        rtt_telnet_port: u16,
        connect_timeout_ms: u64,
    ) -> Result<RttSession> {
        self.open_rtt_session(
            serial_number,
            device_name,
            speed_khz,
            gdb_port,
            rtt_telnet_port,
            connect_timeout_ms,
        )
    }

    pub fn write_icm_calibration(
        &self,
        request: IcmWriteCalibrationRequest,
    ) -> Result<IcmWriteCalibrationResult> {
        if !request.write_gyro_bias && !request.write_accel {
            return Err(BackendError::InvalidInput(
                "at least one write mode must be enabled (write_gyro_bias or write_accel)"
                    .to_string(),
            ));
        }

        let mut session = self.open_rtt_session(
            request.serial_number.clone(),
            request.device_name.clone(),
            request.speed_khz,
            request.gdb_port,
            request.rtt_telnet_port,
            request.connect_timeout_ms,
        )?;

        let ack_timeout = Duration::from_millis(request.ack_timeout_ms.max(500));
        let mut commands = Vec::new();

        commands.push(session.send_command_and_wait_ack("IMU ICM45686", ack_timeout)?);
        commands.push(
            session.send_command_and_wait_ack(
                &format!("ODR {}", request.odr_hz.max(1)),
                ack_timeout,
            )?,
        );
        commands.push(session.send_command_and_wait_ack(
            &format!("ACCEL_RANGE {}", request.accel_range_g),
            ack_timeout,
        )?);
        commands.push(session.send_command_and_wait_ack(
            &format!("GYRO_RANGE {}", request.gyro_range_dps),
            ack_timeout,
        )?);
        commands.push(session.send_command_and_wait_ack(
            &format!("LOW_NOISE {}", if request.low_noise { 1 } else { 0 }),
            ack_timeout,
        )?);
        commands.push(session.send_command_and_wait_ack(
            &format!("FIFO {}", if request.fifo { 1 } else { 0 }),
            ack_timeout,
        )?);
        commands.push(session.send_command_and_wait_ack(
            &format!("FIFO_HIRES {}", if request.fifo_hires { 1 } else { 0 }),
            ack_timeout,
        )?);
        commands.push(session.send_command_and_wait_ack("APPLY", ack_timeout)?);

        if request.write_gyro_bias {
            let gyro = request.estimate.gyro_bias_dps;
            commands.push(session.send_command_and_wait_ack(
                &format!(
                    "CAL_SET_GYRO_BIAS {:.8} {:.8} {:.8}",
                    gyro[0], gyro[1], gyro[2]
                ),
                ack_timeout,
            )?);
        }

        if request.write_accel {
            let offset = request.estimate.accel_offset_mps2;
            let x = request.estimate.accel_xform;
            commands.push(session.send_command_and_wait_ack(
                &format!(
                    "CAL_SET_ACCEL {:.8} {:.8} {:.8} {:.8} {:.8} {:.8} {:.8} {:.8} {:.8} {:.8} {:.8} {:.8}",
                    offset[0],
                    offset[1],
                    offset[2],
                    x[0][0],
                    x[0][1],
                    x[0][2],
                    x[1][0],
                    x[1][1],
                    x[1][2],
                    x[2][0],
                    x[2][1],
                    x[2][2]
                ),
                ack_timeout,
            )?);
        }

        commands.push(session.send_command_and_wait_ack("CAL_SAVE", ack_timeout)?);
        commands.push(session.send_command_and_wait_ack("CAL_STATUS", ack_timeout)?);

        Ok(IcmWriteCalibrationResult { commands })
    }

    fn send_icm_setup_commands(
        &self,
        session: &mut RttSession,
        odr_hz: u32,
        stream_hz: u32,
        accel_range_g: u32,
        gyro_range_dps: u32,
        low_noise: bool,
        fifo: bool,
        fifo_hires: bool,
        ack_timeout: Duration,
        responses: &mut Vec<String>,
    ) -> Result<()> {
        let commands = [
            "IMU ICM45686".to_string(),
            "STREAM_FORMAT CSV".to_string(),
            format!("STREAM_HZ {}", stream_hz.max(1)),
            format!("ODR {}", odr_hz.max(1)),
            format!("ACCEL_RANGE {}", accel_range_g),
            format!("GYRO_RANGE {}", gyro_range_dps),
            format!("LOW_NOISE {}", if low_noise { 1 } else { 0 }),
            format!("FIFO {}", if fifo { 1 } else { 0 }),
            format!("FIFO_HIRES {}", if fifo_hires { 1 } else { 0 }),
            "APPLY".to_string(),
        ];

        for command in &commands {
            let result = session.send_command_and_wait_ack(command, ack_timeout)?;
            responses.extend(result.lines);
        }

        Ok(())
    }

    fn open_rtt_session(
        &self,
        serial_number: Option<String>,
        device_name: String,
        speed_khz: u32,
        gdb_port: u16,
        rtt_telnet_port: u16,
        connect_timeout_ms: u64,
    ) -> Result<RttSession> {
        let rtt_control_block_addr = self.detect_preferred_rtt_control_block(serial_number.as_deref());
        let config = RttServerConfig {
            serial_number,
            device_name,
            speed_khz: speed_khz.max(100),
            gdb_port,
            rtt_telnet_port,
            connect_timeout: Duration::from_millis(connect_timeout_ms.max(500)),
            rtt_control_block_addr,
        };

        RttSession::start(&self.config.jlink_gdb_server_executable, &config)
    }

    fn resolve_bundle_image(
        &self,
        board_target: crate::types::BoardTarget,
        imu_model: crate::types::ImuModel,
    ) -> Result<PathBuf> {
        let manifest_path = self.config.firmware_bundle_dir.join("manifest.json");
        if !manifest_path.exists() {
            return Err(BackendError::Manifest(format!(
                "manifest not found at {}",
                manifest_path.display()
            )));
        }

        let manifest = FirmwareManifest::load(&manifest_path)?;
        let image = manifest
            .resolve_image(board_target, imu_model, DEFAULT_PROFILE)
            .ok_or_else(|| {
                BackendError::Manifest(format!(
                    "no manifest entry for board={}, imu={}, profile={}",
                    board_target, imu_model, DEFAULT_PROFILE
                ))
            })?;

        let resolved = resolve_relative_to(&self.config.firmware_bundle_dir, &image.hex);
        Ok(resolved)
    }

    fn ensure_nrfjprog_available(&self) -> Result<()> {
        ensure_tool_available(&self.config.nrfjprog_executable, &["--version"])
    }

    fn detect_preferred_rtt_control_block(&self, serial_number: Option<&str>) -> Option<u32> {
        match self.find_rtt_control_blocks(serial_number) {
            Ok(addresses) => addresses.into_iter().max(),
            Err(_) => None,
        }
    }

    fn find_rtt_control_blocks(&self, serial_number: Option<&str>) -> Result<Vec<u32>> {
        let mut addresses = self.scan_rtt_control_blocks(serial_number, "0x10000")?;
        if addresses.is_empty() {
            addresses = self.scan_rtt_control_blocks(serial_number, "0x40000")?;
        }
        addresses.sort_unstable();
        addresses.dedup();
        Ok(addresses)
    }

    fn scan_rtt_control_blocks(
        &self,
        serial_number: Option<&str>,
        ram_len: &str,
    ) -> Result<Vec<u32>> {
        let mut args = Vec::<String>::new();
        if let Some(snr) = serial_number {
            let trimmed = snr.trim();
            if !trimmed.is_empty() {
                args.push("--snr".to_string());
                args.push(trimmed.to_string());
            }
        }
        args.push("--memrd".to_string());
        args.push("0x20000000".to_string());
        args.push("--n".to_string());
        args.push(ram_len.to_string());
        args.push("--w".to_string());
        args.push("8".to_string());

        let output = run_command(&self.config.nrfjprog_executable, &args, None)?;
        Ok(parse_rtt_control_block_addresses(&output.stdout))
    }

    fn ensure_west_available(&self) -> Result<()> {
        ensure_tool_available(&self.config.west_executable, &["--version"])
    }

    fn detect_tool(&self, executable: &str, version_args: &[&str]) -> ToolStatus {
        let args = version_args
            .iter()
            .map(|arg| (*arg).to_string())
            .collect::<Vec<String>>();
        match run_command(executable, &args, None) {
            Ok(output) => {
                let version_line = output
                    .stdout
                    .lines()
                    .chain(output.stderr.lines())
                    .find(|line| !line.trim().is_empty())
                    .map(|line| line.trim().to_string());

                ToolStatus {
                    executable: executable.to_string(),
                    available: true,
                    version: version_line,
                    error: None,
                }
            }
            Err(err) => ToolStatus {
                executable: executable.to_string(),
                available: false,
                version: None,
                error: Some(err.to_string()),
            },
        }
    }
}

fn ensure_tool_available(executable: &str, version_args: &[&str]) -> Result<()> {
    let args = version_args
        .iter()
        .map(|value| (*value).to_string())
        .collect::<Vec<String>>();

    run_command(executable, &args, None)
        .map(|_| ())
        .map_err(|_| BackendError::ToolUnavailable(executable.to_string()))
}

fn is_retryable_rtt_io_error(err: &BackendError) -> bool {
    match err {
        BackendError::Io(io_err) => matches!(
            io_err.kind(),
            std::io::ErrorKind::BrokenPipe
                | std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::NotConnected
                | std::io::ErrorKind::UnexpectedEof
        ),
        _ => false,
    }
}

fn resolve_relative_to(base: &Path, candidate: &Path) -> PathBuf {
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        base.join(candidate)
    }
}

fn parse_rtt_control_block_addresses(text: &str) -> Vec<u32> {
    let mut addresses = Vec::<u32>::new();

    for line in text.lines() {
        if !line.contains("SEGGER RTT") {
            continue;
        }

        let Some((addr_text, _)) = line.split_once(':') else {
            continue;
        };

        let trimmed = addr_text.trim();
        let Some(hex) = trimmed.strip_prefix("0x") else {
            continue;
        };

        if let Ok(addr) = u32::from_str_radix(hex, 16) {
            addresses.push(addr);
        }
    }

    addresses
}
