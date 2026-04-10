#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use calibration_backend::{
    calibration::{
        ensure_min_total_samples, estimate_accel_ellipsoid_with_min_points,
        estimate_gyro_bias_with_min_samples, parse_icm_csv_sample,
    },
    BackendConfig, BoardTarget, CalibrationBackend, EraseStrategy, FlashRequest,
    IcmCalibrationEstimate, IcmCaptureCalibrationRequest, IcmCaptureCalibrationResult,
    IcmWriteCalibrationRequest, ImuModel, RttCommandRequest, RttCommandResult,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::Emitter;

const GYRO_STREAM_SAMPLE_EVENT: &str = "gyro-stream-sample";
const GYRO_STREAM_STATUS_EVENT: &str = "gyro-stream-status";
const RTT_CONNECTION_STATUS_EVENT: &str = "rtt-connection-status";

#[derive(Debug, Clone, Deserialize)]
struct GyroRealtimeStreamRequest {
    serial_number: Option<String>,
    device_name: String,
    speed_khz: u32,
    gdb_port: u16,
    rtt_telnet_port: u16,
    connect_timeout_ms: u64,
    ack_timeout_ms: u64,
    odr_hz: u32,
    stream_hz: u32,
    accel_range_g: u32,
    gyro_range_dps: u32,
    low_noise: bool,
    fifo: bool,
    fifo_hires: bool,
    nrfjprog: Option<String>,
    jlink_gdb_server: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct GyroRealtimeSampleEvent {
    timestamp_ms: u32,
    ax: f32,
    ay: f32,
    az: f32,
    gx: f32,
    gy: f32,
    gz: f32,
}

#[derive(Debug, Clone, Serialize)]
struct GyroRealtimeStatusEvent {
    level: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct RttConnectionStatusEvent {
    connected: bool,
    message: String,
}

struct GyroStreamControl {
    stop_flag: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

struct GyroStreamState {
    current: Arc<Mutex<Option<GyroStreamControl>>>,
}

#[derive(Debug, Clone, Deserialize)]
struct PersistentRttConnectRequest {
    serial_number: Option<String>,
    device_name: String,
    speed_khz: u32,
    gdb_port: u16,
    rtt_telnet_port: u16,
    connect_timeout_ms: u64,
    ack_timeout_ms: u64,
    nrfjprog: Option<String>,
    jlink_gdb_server: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RttConnectedCommandRequest {
    commands: Vec<String>,
    ack_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
struct RttConnectionStatus {
    connected: bool,
}

struct PersistentRttConnection {
    session: calibration_backend::rtt_text::RttSession,
    ack_timeout: Duration,
}

struct PersistentRttState {
    current: Arc<Mutex<Option<PersistentRttConnection>>>,
    last_request: Arc<Mutex<Option<PersistentRttConnectRequest>>>,
    drainer: Arc<Mutex<Option<PersistentRttDrainer>>>,
}

struct PersistentRttDrainer {
    stop_flag: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Default for GyroStreamState {
    fn default() -> Self {
        Self {
            current: Arc::new(Mutex::new(None)),
        }
    }
}

impl Default for PersistentRttState {
    fn default() -> Self {
        Self {
            current: Arc::new(Mutex::new(None)),
            last_request: Arc::new(Mutex::new(None)),
            drainer: Arc::new(Mutex::new(None)),
        }
    }
}

#[tauri::command]
async fn run_backend_cli(
    gyro_state: tauri::State<'_, GyroStreamState>,
    rtt_state: tauri::State<'_, PersistentRttState>,
    args: Vec<String>,
) -> Result<Value, String> {
    if command_requires_rtt_session(&args) {
        let gyro_current = Arc::clone(&gyro_state.current);
        let rtt_current = Arc::clone(&rtt_state.current);
        let rtt_last_request = Arc::clone(&rtt_state.last_request);
        let rtt_drainer = Arc::clone(&rtt_state.drainer);
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let _ = stop_gyro_stream_inner(&gyro_current);
            let _ = disconnect_rtt_inner(&rtt_current, &rtt_last_request, &rtt_drainer);
        })
        .await;
    }

    tauri::async_runtime::spawn_blocking(move || execute_backend_args(args))
        .await
        .map_err(|err| format!("backend task join error: {err}"))?
}

fn command_requires_rtt_session(args: &[String]) -> bool {
    let mut idx = 0usize;
    while idx < args.len() {
        match args[idx].as_str() {
            "--firmware-dir" | "--nrfjprog" | "--jlink-gdb-server" => {
                if idx + 1 >= args.len() {
                    return false;
                }
                idx += 2;
            }
            command => {
                return matches!(command, "rtt-command" | "icm-capture-cal" | "icm-write-cal");
            }
        }
    }

    false
}

#[tauri::command]
async fn start_gyro_stream(
    app: tauri::AppHandle,
    gyro_state: tauri::State<'_, GyroStreamState>,
    rtt_state: tauri::State<'_, PersistentRttState>,
    request: GyroRealtimeStreamRequest,
) -> Result<(), String> {
    let gyro_current = Arc::clone(&gyro_state.current);
    let rtt_current = Arc::clone(&rtt_state.current);
    let rtt_last_request = Arc::clone(&rtt_state.last_request);
    let rtt_drainer = Arc::clone(&rtt_state.drainer);
    let app_handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        start_gyro_stream_inner(
            app_handle,
            &gyro_current,
            &rtt_current,
            &rtt_last_request,
            &rtt_drainer,
            request,
        )
    })
    .await
    .map_err(|err| format!("start gyro stream task join error: {err}"))?
}

fn start_gyro_stream_inner(
    app: tauri::AppHandle,
    gyro_current: &Arc<Mutex<Option<GyroStreamControl>>>,
    rtt_current: &Arc<Mutex<Option<PersistentRttConnection>>>,
    rtt_last_request: &Arc<Mutex<Option<PersistentRttConnectRequest>>>,
    rtt_drainer: &Arc<Mutex<Option<PersistentRttDrainer>>>,
    request: GyroRealtimeStreamRequest,
) -> Result<(), String> {
    let _ = stop_gyro_stream_inner(gyro_current)?;
    let _ = disconnect_rtt_inner(rtt_current, rtt_last_request, rtt_drainer)?;

    let mut config = BackendConfig::default();
    if let Some(path) = request.nrfjprog.as_deref().map(str::trim) {
        if !path.is_empty() {
            config.nrfjprog_executable = path.to_string();
        }
    }
    if let Some(path) = request.jlink_gdb_server.as_deref().map(str::trim) {
        if !path.is_empty() {
            config.jlink_gdb_server_executable = path.to_string();
        }
    }

    let backend = CalibrationBackend::new(config);
    let mut session = backend
        .open_rtt_text_session(
            request.serial_number.as_deref().map(str::trim).and_then(|value| {
                if value.is_empty() {
                    None
                } else {
                    Some(value.to_string())
                }
            }),
            if request.device_name.trim().is_empty() {
                "nRF52840_xxAA".to_string()
            } else {
                request.device_name.trim().to_string()
            },
            request.speed_khz.max(100),
            request.gdb_port,
            request.rtt_telnet_port,
            request.connect_timeout_ms.max(500),
        )
        .map_err(|err| err.to_string())?;

    let ack_timeout = Duration::from_millis(request.ack_timeout_ms.max(500));
    let _ = session.send_command_and_wait_ack("STOP", ack_timeout);

    let setup_commands = [
        "IMU ICM45686".to_string(),
        "STREAM_FORMAT CSV".to_string(),
        format!("STREAM_HZ {}", request.stream_hz.max(1)),
        format!("ODR {}", request.odr_hz.max(1)),
        format!("ACCEL_RANGE {}", request.accel_range_g),
        format!("GYRO_RANGE {}", request.gyro_range_dps),
        format!("LOW_NOISE {}", if request.low_noise { 1 } else { 0 }),
        format!("FIFO {}", if request.fifo { 1 } else { 0 }),
        format!("FIFO_HIRES {}", if request.fifo_hires { 1 } else { 0 }),
        "APPLY".to_string(),
        "START".to_string(),
    ];

    for command in &setup_commands {
        session
            .send_command_and_wait_ack(command, ack_timeout)
            .map_err(|err| err.to_string())?;
    }

    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_clone = Arc::clone(&stop_flag);
    let app_handle = app.clone();

    let worker = std::thread::spawn(move || {
        emit_gyro_stream_status(&app_handle, "info", "gyro stream connected");

        while !stop_flag_clone.load(Ordering::Relaxed) {
            let deadline = Instant::now() + Duration::from_millis(220);
            match session.read_line_until(deadline) {
                Ok(Some(line)) => {
                    if let Some(sample) = parse_icm_csv_sample(&line, 0.0) {
                        let payload = GyroRealtimeSampleEvent {
                            timestamp_ms: sample.timestamp_ms,
                            ax: sample.accel_mps2[0],
                            ay: sample.accel_mps2[1],
                            az: sample.accel_mps2[2],
                            gx: sample.gyro_dps[0],
                            gy: sample.gyro_dps[1],
                            gz: sample.gyro_dps[2],
                        };
                        if app_handle.emit(GYRO_STREAM_SAMPLE_EVENT, payload).is_err() {
                            break;
                        }
                    }
                }
                Ok(None) => {}
                Err(err) => {
                    emit_gyro_stream_status(
                        &app_handle,
                        "error",
                        format!("gyro stream io error: {err}"),
                    );
                    break;
                }
            }
        }

        let _ = session.send_command_and_wait_ack("STOP", ack_timeout);
        emit_gyro_stream_status(&app_handle, "info", "gyro stream stopped");
    });

    {
        let mut guard = gyro_current
            .lock()
            .map_err(|_| "gyro stream state lock poisoned".to_string())?;
        *guard = Some(GyroStreamControl {
            stop_flag,
            worker: Some(worker),
        });
    }

    Ok(())
}

#[tauri::command]
async fn stop_gyro_stream(state: tauri::State<'_, GyroStreamState>) -> Result<bool, String> {
    let gyro_current = Arc::clone(&state.current);
    tauri::async_runtime::spawn_blocking(move || stop_gyro_stream_inner(&gyro_current))
        .await
        .map_err(|err| format!("stop gyro stream task join error: {err}"))?
}

fn stop_gyro_stream_inner(
    gyro_current: &Arc<Mutex<Option<GyroStreamControl>>>,
) -> Result<bool, String> {
    let mut control = {
        let mut guard = gyro_current
            .lock()
            .map_err(|_| "gyro stream state lock poisoned".to_string())?;
        guard.take()
    };

    if let Some(control_state) = control.as_mut() {
        control_state.stop_flag.store(true, Ordering::Relaxed);
        if let Some(worker) = control_state.worker.take() {
            let _ = worker.join();
        }
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
async fn connect_rtt(
    app: tauri::AppHandle,
    gyro_state: tauri::State<'_, GyroStreamState>,
    rtt_state: tauri::State<'_, PersistentRttState>,
    request: PersistentRttConnectRequest,
) -> Result<(), String> {
    let gyro_current = Arc::clone(&gyro_state.current);
    let rtt_current = Arc::clone(&rtt_state.current);
    let rtt_last_request = Arc::clone(&rtt_state.last_request);
    let rtt_drainer = Arc::clone(&rtt_state.drainer);
    let app_handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _ = stop_gyro_stream_inner(&gyro_current)?;
        let _ = disconnect_rtt_inner(&rtt_current, &rtt_last_request, &rtt_drainer)?;

        let connection = open_persistent_rtt_connection(&request)?;

        let mut guard = rtt_current
            .lock()
            .map_err(|_| "persistent RTT state lock poisoned".to_string())?;
        *guard = Some(connection);
        drop(guard);

        let mut last_request_guard = rtt_last_request
            .lock()
            .map_err(|_| "persistent RTT request state lock poisoned".to_string())?;
        *last_request_guard = Some(request);
        drop(last_request_guard);

        start_rtt_drainer(&rtt_current, &rtt_last_request, &rtt_drainer, app_handle.clone())?;
        emit_rtt_connection_status(&app_handle, true, "RTT connected");
        Ok::<(), String>(())
    })
    .await
    .map_err(|err| format!("connect RTT task join error: {err}"))?
}

#[tauri::command]
async fn disconnect_rtt(
    app: tauri::AppHandle,
    rtt_state: tauri::State<'_, PersistentRttState>,
) -> Result<bool, String> {
    let rtt_current = Arc::clone(&rtt_state.current);
    let rtt_last_request = Arc::clone(&rtt_state.last_request);
    let rtt_drainer = Arc::clone(&rtt_state.drainer);
    let app_handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let disconnected = disconnect_rtt_inner(&rtt_current, &rtt_last_request, &rtt_drainer)?;
        emit_rtt_connection_status(
            &app_handle,
            false,
            if disconnected {
                "RTT disconnected"
            } else {
                "RTT already disconnected"
            },
        );
        Ok::<bool, String>(disconnected)
    })
    .await
    .map_err(|err| format!("disconnect RTT task join error: {err}"))?
}

fn disconnect_rtt_inner(
    current: &Arc<Mutex<Option<PersistentRttConnection>>>,
    last_request: &Arc<Mutex<Option<PersistentRttConnectRequest>>>,
    drainer: &Arc<Mutex<Option<PersistentRttDrainer>>>,
) -> Result<bool, String> {
    stop_rtt_drainer(drainer)?;

    {
        let mut request_guard = last_request
            .lock()
            .map_err(|_| "persistent RTT request state lock poisoned".to_string())?;
        *request_guard = None;
    }

    let mut guard = current
        .lock()
        .map_err(|_| "persistent RTT state lock poisoned".to_string())?;

    if let Some(mut connection) = guard.take() {
        let _ = connection
            .session
            .send_command_and_wait_ack("STOP", connection.ack_timeout.min(Duration::from_millis(1200)));
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
fn rtt_connection_status(state: tauri::State<PersistentRttState>) -> Result<RttConnectionStatus, String> {
    let guard = state
        .current
        .lock()
        .map_err(|_| "persistent RTT state lock poisoned".to_string())?;
    Ok(RttConnectionStatus {
        connected: guard.is_some(),
    })
}

#[tauri::command]
async fn rtt_command_connected(
    app: tauri::AppHandle,
    rtt_state: tauri::State<'_, PersistentRttState>,
    request: RttConnectedCommandRequest,
) -> Result<Vec<RttCommandResult>, String> {
    let connection = Arc::clone(&rtt_state.current);
    let last_request = Arc::clone(&rtt_state.last_request);
    let app_handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        rtt_command_connected_inner(&app_handle, &connection, &last_request, request)
    })
    .await
    .map_err(|err| format!("RTT command task join error: {err}"))?
}

fn rtt_command_connected_inner(
    app: &tauri::AppHandle,
    connection: &Arc<Mutex<Option<PersistentRttConnection>>>,
    last_request: &Arc<Mutex<Option<PersistentRttConnectRequest>>>,
    request: RttConnectedCommandRequest,
) -> Result<Vec<RttCommandResult>, String> {
    if request.commands.is_empty() {
        return Err("at least one RTT command is required".to_string());
    }
    let requested_ack_timeout = request
        .ack_timeout_ms
        .map(|value| Duration::from_millis(value.max(500)));

    let mut last_retryable_error: Option<String> = None;

    for attempt in 0..2 {
        let mut results = Vec::with_capacity(request.commands.len());
        let mut should_retry = false;

        for command in &request.commands {
            let send_result = {
                let mut guard = connection
                    .lock()
                    .map_err(|_| "persistent RTT state lock poisoned".to_string())?;

                let conn = guard
                    .as_mut()
                    .ok_or_else(|| "RTT is not connected. Use Connect first.".to_string())?;

                let ack_timeout = requested_ack_timeout.unwrap_or(conn.ack_timeout);
                conn.session.send_command_and_wait_ack(command, ack_timeout)
            };

            match send_result {
                Ok(result) => results.push(result),
                Err(err) => {
                    if is_retryable_connection_io_error(&err) {
                        if let Ok(mut guard) = connection.lock() {
                            *guard = None;
                        }
                        should_retry = true;
                        last_retryable_error = Some(err.to_string());
                        break;
                    }
                    return Err(err.to_string());
                }
            }
        }

        if !should_retry {
            return Ok(results);
        }

        if attempt == 0 {
            let reconnect_stop = Arc::new(AtomicBool::new(false));
            if try_reconnect_persistent_rtt(
                connection,
                last_request,
                &reconnect_stop,
                app,
            ) {
                continue;
            }
        }
        break;
    }

    let message =
        last_retryable_error.unwrap_or_else(|| "RTT command failed after reconnect".to_string());
    emit_rtt_connection_status(app, false, format!("RTT command failed ({message})"));
    Err(message)
}

#[tauri::command]
async fn icm_capture_calibration_connected(
    app: tauri::AppHandle,
    rtt_state: tauri::State<'_, PersistentRttState>,
    request: IcmCaptureCalibrationRequest,
) -> Result<IcmCaptureCalibrationResult, String> {
    let current = Arc::clone(&rtt_state.current);
    let last_request = Arc::clone(&rtt_state.last_request);
    let drainer = Arc::clone(&rtt_state.drainer);
    let app_handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        icm_capture_calibration_connected_inner(
            &app_handle,
            &current,
            &last_request,
            &drainer,
            request,
        )
    })
    .await
    .map_err(|err| format!("connected capture task join error: {err}"))?
}

fn icm_capture_calibration_connected_inner(
    app: &tauri::AppHandle,
    current: &Arc<Mutex<Option<PersistentRttConnection>>>,
    last_request: &Arc<Mutex<Option<PersistentRttConnectRequest>>>,
    drainer: &Arc<Mutex<Option<PersistentRttDrainer>>>,
    request: IcmCaptureCalibrationRequest,
) -> Result<IcmCaptureCalibrationResult, String> {
    if !request.compute_gyro && !request.compute_accel {
        return Err(
            "at least one capture mode must be enabled (compute_gyro or compute_accel)".to_string(),
        );
    }

    stop_rtt_drainer(drainer)?;
    let mut drainer_started_early = false;
    let result = (|| -> Result<IcmCaptureCalibrationResult, String> {
        let ack_timeout = Duration::from_millis(request.ack_timeout_ms.max(500));
        let mut responses = Vec::<String>::new();

        if !request.keep_stream_running {
            let commands = [
                "IMU ICM45686".to_string(),
                "STREAM_FORMAT CSV".to_string(),
                format!("STREAM_HZ {}", request.stream_hz.max(1)),
                format!("ODR {}", request.odr_hz.max(1)),
                format!("ACCEL_RANGE {}", request.accel_range_g),
                format!("GYRO_RANGE {}", request.gyro_range_dps),
                format!("LOW_NOISE {}", if request.low_noise { 1 } else { 0 }),
                format!("FIFO {}", if request.fifo { 1 } else { 0 }),
                format!("FIFO_HIRES {}", if request.fifo_hires { 1 } else { 0 }),
                "APPLY".to_string(),
            ];

            for command in &commands {
                let command_result = {
                    let mut guard = current
                        .lock()
                        .map_err(|_| "persistent RTT state lock poisoned".to_string())?;
                    let connection = guard
                        .as_mut()
                        .ok_or_else(|| "RTT is not connected. Use Connect first.".to_string())?;
                    connection
                        .session
                        .send_command_and_wait_ack(command, ack_timeout)
                        .map_err(|err| err.to_string())?
                };
                responses.extend(command_result.lines);
            }

            let start_result = {
                let mut guard = current
                    .lock()
                    .map_err(|_| "persistent RTT state lock poisoned".to_string())?;
                let connection = guard
                    .as_mut()
                    .ok_or_else(|| "RTT is not connected. Use Connect first.".to_string())?;
                connection
                    .session
                    .send_command_and_wait_ack("START", ack_timeout)
                    .map_err(|err| err.to_string())?
            };
            responses.extend(start_result.lines);
        }

        let capture_seconds = request.capture_seconds.max(1.0);
        let capture_deadline = Instant::now() + Duration::from_secs_f32(capture_seconds);
        let capture_start = Instant::now();
        let mut samples = Vec::new();

        while Instant::now() < capture_deadline {
            let read_deadline = Instant::now() + Duration::from_millis(200);
            let line = {
                let mut guard = current
                    .lock()
                    .map_err(|_| "persistent RTT state lock poisoned".to_string())?;
                let connection = guard
                    .as_mut()
                    .ok_or_else(|| "RTT disconnected during capture".to_string())?;
                connection
                    .session
                    .read_line_until(read_deadline)
                    .map_err(|err| err.to_string())?
            };

            if let Some(line) = line {
                if samples.len() < 100 || responses.len() < 300 {
                    responses.push(line.clone());
                }
                if let Some(sample) =
                    parse_icm_csv_sample(&line, capture_start.elapsed().as_secs_f32())
                {
                    let payload = GyroRealtimeSampleEvent {
                        timestamp_ms: sample.timestamp_ms,
                        ax: sample.accel_mps2[0],
                        ay: sample.accel_mps2[1],
                        az: sample.accel_mps2[2],
                        gx: sample.gyro_dps[0],
                        gy: sample.gyro_dps[1],
                        gz: sample.gyro_dps[2],
                    };
                    let _ = app.emit(GYRO_STREAM_SAMPLE_EVENT, payload);
                    samples.push(sample);
                }
            }
        }

        if request.keep_stream_running {
            // Resume the shared drainer before local compute so plotting can continue
            // while calibration estimation runs.
            start_rtt_drainer(current, last_request, drainer, app.clone())?;
            drainer_started_early = true;
        } else {
            let stop_result = {
                let mut guard = current
                    .lock()
                    .map_err(|_| "persistent RTT state lock poisoned".to_string())?;
                if let Some(connection) = guard.as_mut() {
                    connection
                        .session
                        .send_command_and_wait_ack("STOP", ack_timeout)
                        .ok()
                } else {
                    None
                }
            };
            if let Some(stop_result) = stop_result {
                responses.extend(stop_result.lines);
            }
        }

        ensure_min_total_samples(&samples, request.min_total_samples.max(1))
            .map_err(|err| err.to_string())?;

        let mut estimate = IcmCalibrationEstimate {
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
            )
            .map_err(|err| err.to_string())?;
            estimate.gyro_bias_dps = gyro_bias;
            estimate.gyro_sample_count = gyro_sample_count;
        }

        if request.compute_accel {
            let (accel_offset, accel_xform, residual_rms, residual_max, _point_count) =
                estimate_accel_ellipsoid_with_min_points(&samples, request.min_accel_points.max(1))
                    .map_err(|err| err.to_string())?;
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
    })();

    let should_restart = {
        let has_connection = current.lock().map(|guard| guard.is_some()).unwrap_or(false);
        let has_request = last_request
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false);
        has_connection && has_request
    };

    if should_restart && !drainer_started_early {
        if let Err(err) = start_rtt_drainer(current, last_request, drainer, app.clone()) {
            if result.is_ok() {
                return Err(err);
            }
        }
    }

    result
}

fn start_rtt_drainer(
    current: &Arc<Mutex<Option<PersistentRttConnection>>>,
    last_request: &Arc<Mutex<Option<PersistentRttConnectRequest>>>,
    drainer: &Arc<Mutex<Option<PersistentRttDrainer>>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    stop_rtt_drainer(drainer)?;

    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_clone = Arc::clone(&stop_flag);
    let connection = Arc::clone(current);
    let last_request = Arc::clone(last_request);
    let app_handle = app.clone();

    let worker = std::thread::spawn(move || {
        while !stop_flag_clone.load(Ordering::Relaxed) {
            let (read_result, had_connection) = {
                let mut guard = match connection.lock() {
                    Ok(guard) => guard,
                    Err(_) => break,
                };

                if let Some(conn) = guard.as_mut() {
                    let deadline = Instant::now() + Duration::from_millis(120);
                    (conn.session.read_line_until(deadline), true)
                } else {
                    (Ok(None), false)
                }
            };

            match read_result {
                Ok(Some(line)) => {
                    if let Some(sample) = parse_icm_csv_sample(&line, 0.0) {
                        let payload = GyroRealtimeSampleEvent {
                            timestamp_ms: sample.timestamp_ms,
                            ax: sample.accel_mps2[0],
                            ay: sample.accel_mps2[1],
                            az: sample.accel_mps2[2],
                            gx: sample.gyro_dps[0],
                            gy: sample.gyro_dps[1],
                            gz: sample.gyro_dps[2],
                        };
                        let _ = app_handle.emit(GYRO_STREAM_SAMPLE_EVENT, payload);
                    }
                }
                Ok(None) => {
                    if had_connection {
                        std::thread::sleep(Duration::from_millis(20));
                    } else {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
                Err(err) => {
                    if is_retryable_connection_io_error(&err) {
                        if !try_reconnect_persistent_rtt(
                            &connection,
                            &last_request,
                            &stop_flag_clone,
                            &app_handle,
                        ) {
                            emit_rtt_connection_status(
                                &app_handle,
                                false,
                                format!("RTT disconnected ({err})"),
                            );
                            break;
                        }
                    } else {
                        emit_rtt_connection_status(
                            &app_handle,
                            false,
                            format!("RTT disconnected ({err})"),
                        );
                        break;
                    }
                }
            }
        }
    });

    let mut drainer_guard = drainer
        .lock()
        .map_err(|_| "persistent RTT drainer state lock poisoned".to_string())?;
    *drainer_guard = Some(PersistentRttDrainer {
        stop_flag,
        worker: Some(worker),
    });

    Ok(())
}

fn try_reconnect_persistent_rtt(
    connection: &Arc<Mutex<Option<PersistentRttConnection>>>,
    last_request: &Arc<Mutex<Option<PersistentRttConnectRequest>>>,
    stop_flag: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
) -> bool {
    let request = match last_request.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => return false,
    };
    let Some(request) = request else {
        return false;
    };

    for _ in 0..3 {
        if stop_flag.load(Ordering::Relaxed) {
            return false;
        }

        match open_persistent_rtt_connection(&request) {
            Ok(new_connection) => {
                if let Ok(mut guard) = connection.lock() {
                    *guard = Some(new_connection);
                    emit_rtt_connection_status(app, true, "RTT reconnected");
                    return true;
                }
                return false;
            }
            Err(_) => {
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    }

    if let Ok(mut guard) = connection.lock() {
        *guard = None;
    }
    false
}

fn open_persistent_rtt_connection(
    request: &PersistentRttConnectRequest,
) -> Result<PersistentRttConnection, String> {
    let mut config = BackendConfig::default();
    if let Some(path) = request.nrfjprog.as_deref().map(str::trim) {
        if !path.is_empty() {
            config.nrfjprog_executable = path.to_string();
        }
    }
    if let Some(path) = request.jlink_gdb_server.as_deref().map(str::trim) {
        if !path.is_empty() {
            config.jlink_gdb_server_executable = path.to_string();
        }
    }

    let backend = CalibrationBackend::new(config);
    let session = backend
        .open_rtt_text_session(
            request.serial_number.as_deref().map(str::trim).and_then(|value| {
                if value.is_empty() {
                    None
                } else {
                    Some(value.to_string())
                }
            }),
            if request.device_name.trim().is_empty() {
                "nRF52840_xxAA".to_string()
            } else {
                request.device_name.trim().to_string()
            },
            request.speed_khz.max(100),
            request.gdb_port,
            request.rtt_telnet_port,
            request.connect_timeout_ms.max(500),
        )
        .map_err(|err| err.to_string())?;

    Ok(PersistentRttConnection {
        session,
        ack_timeout: Duration::from_millis(request.ack_timeout_ms.max(500)),
    })
}

fn stop_rtt_drainer(drainer: &Arc<Mutex<Option<PersistentRttDrainer>>>) -> Result<(), String> {
    let mut drainer = {
        let mut guard = drainer
            .lock()
            .map_err(|_| "persistent RTT drainer state lock poisoned".to_string())?;
        guard.take()
    };

    if let Some(drainer_state) = drainer.as_mut() {
        drainer_state.stop_flag.store(true, Ordering::Relaxed);
        if let Some(worker) = drainer_state.worker.take() {
            let _ = worker.join();
        }
    }

    Ok(())
}

fn emit_gyro_stream_status(app: &tauri::AppHandle, level: &str, message: impl Into<String>) {
    let payload = GyroRealtimeStatusEvent {
        level: level.to_string(),
        message: message.into(),
    };
    let _ = app.emit(GYRO_STREAM_STATUS_EVENT, payload);
}

fn emit_rtt_connection_status(app: &tauri::AppHandle, connected: bool, message: impl Into<String>) {
    let payload = RttConnectionStatusEvent {
        connected,
        message: message.into(),
    };
    let _ = app.emit(RTT_CONNECTION_STATUS_EVENT, payload);
}

fn is_retryable_connection_io_error(err: &calibration_backend::BackendError) -> bool {
    match err {
        calibration_backend::BackendError::Io(io_err) => matches!(
            io_err.kind(),
            std::io::ErrorKind::BrokenPipe
                | std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::NotConnected
                | std::io::ErrorKind::UnexpectedEof
        ),
        _ => false,
    }
}

fn execute_backend_args(args: Vec<String>) -> Result<Value, String> {
    let mut cursor = ArgCursor::new(args);
    let mut config = BackendConfig::default();

    parse_global_options(&mut cursor, &mut config)?;

    let command = cursor
        .next()
        .ok_or_else(|| {
            "missing command (expected tools|probes|flash|rtt-command|icm-capture-cal|icm-write-cal)"
                .to_string()
        })?;

    let backend = CalibrationBackend::new(config.clone());

    match command.as_str() {
        "tools" => to_json(backend.check_tools()),
        "probes" => {
            let probes = backend.list_probes().map_err(|err| err.to_string())?;
            to_json(probes)
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
                    "--compute-gyro" => {
                        request.compute_gyro =
                            parse_bool(&cursor.require_value("--compute-gyro")?, flag.as_str())?
                    }
                    "--compute-accel" => {
                        request.compute_accel =
                            parse_bool(&cursor.require_value("--compute-accel")?, flag.as_str())?
                    }
                    "--min-total-samples" => {
                        request.min_total_samples =
                            parse_usize(&cursor.require_value("--min-total-samples")?, flag.as_str())?
                    }
                    "--min-gyro-samples" => {
                        request.min_gyro_samples =
                            parse_usize(&cursor.require_value("--min-gyro-samples")?, flag.as_str())?
                    }
                    "--min-accel-points" => {
                        request.min_accel_points =
                            parse_usize(&cursor.require_value("--min-accel-points")?, flag.as_str())?
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
                    "--write-gyro-bias" => {
                        request.write_gyro_bias =
                            parse_bool(&cursor.require_value("--write-gyro-bias")?, flag.as_str())?
                    }
                    "--write-accel" => {
                        request.write_accel =
                            parse_bool(&cursor.require_value("--write-accel")?, flag.as_str())?
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
            "--nrfjprog" => {
                cursor.next();
                config.nrfjprog_executable = cursor.require_value("--nrfjprog")?;
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

fn parse_usize(value: &str, option: &str) -> Result<usize, String> {
    value
        .parse::<usize>()
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
        .plugin(tauri_plugin_dialog::init())
        .manage(GyroStreamState::default())
        .manage(PersistentRttState::default())
        .invoke_handler(tauri::generate_handler![
            run_backend_cli,
            connect_rtt,
            disconnect_rtt,
            rtt_connection_status,
            rtt_command_connected,
            icm_capture_calibration_connected,
            start_gyro_stream,
            stop_gyro_stream
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
