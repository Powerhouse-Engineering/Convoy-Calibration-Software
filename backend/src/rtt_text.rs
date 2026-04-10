use crate::types::RttCommandResult;
use crate::{BackendError, Result};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const READ_POLL_TIMEOUT: Duration = Duration::from_millis(150);

#[derive(Debug, Clone)]
pub struct RttServerConfig {
    pub serial_number: Option<String>,
    pub device_name: String,
    pub speed_khz: u32,
    pub gdb_port: u16,
    pub rtt_telnet_port: u16,
    pub connect_timeout: Duration,
    pub rtt_control_block_addr: Option<u32>,
}

pub struct RttSession {
    child: Child,
    reader: BufReader<TcpStream>,
    writer: TcpStream,
    script_path: Option<PathBuf>,
}

impl RttSession {
    pub fn start(gdb_server_executable: &str, config: &RttServerConfig) -> Result<Self> {
        cleanup_stale_jlink_servers(config.gdb_port, config.rtt_telnet_port);

        let mut args = vec![
            "-if".to_string(),
            "SWD".to_string(),
            "-speed".to_string(),
            config.speed_khz.to_string(),
            "-device".to_string(),
            config.device_name.clone(),
            "-port".to_string(),
            config.gdb_port.to_string(),
            "-swoport".to_string(),
            (config.gdb_port.saturating_add(1)).to_string(),
            "-telnetport".to_string(),
            (config.gdb_port.saturating_add(2)).to_string(),
            "-RTTTelnetPort".to_string(),
            config.rtt_telnet_port.to_string(),
            "-nohalt".to_string(),
            "-nogui".to_string(),
            "-silent".to_string(),
        ];

        let mut script_path = None;
        if let Some(rtt_addr) = config.rtt_control_block_addr {
            let script = write_rtt_jlink_script(rtt_addr)?;
            args.push("-jlinkscriptfile".to_string());
            args.push(script.display().to_string());
            script_path = Some(script);
        }

        if let Some(serial_number) = &config.serial_number {
            if !serial_number.trim().is_empty() {
                args.push("-select".to_string());
                args.push(format!("USB={serial_number}"));
            }
        }

        let mut child = match Command::new(gdb_server_executable)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(err) => {
                cleanup_script_file(script_path.as_deref());
                return Err(BackendError::Io(err));
            }
        };

        let addr = SocketAddr::new(
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
            config.rtt_telnet_port,
        );

        let connect_start = Instant::now();
        let writer = loop {
            match TcpStream::connect(addr) {
                Ok(stream) => break stream,
                Err(_) => {
                    if let Some(status) = child.try_wait()? {
                        cleanup_script_file(script_path.as_deref());
                        return Err(BackendError::InvalidInput(format!(
                            "J-Link GDB server exited before RTT connection (status: {status})"
                        )));
                    }

                    if connect_start.elapsed() >= config.connect_timeout {
                        let _ = child.kill();
                        let _ = child.wait();
                        cleanup_script_file(script_path.as_deref());
                        return Err(BackendError::InvalidInput(format!(
                            "timed out connecting to RTT telnet on {addr}"
                        )));
                    }

                    thread::sleep(Duration::from_millis(100));
                }
            }
        };

        writer.set_nodelay(true)?;
        writer.set_write_timeout(Some(Duration::from_secs(2)))?;

        let reader_stream = writer.try_clone()?;
        reader_stream.set_read_timeout(Some(READ_POLL_TIMEOUT))?;
        let reader = BufReader::new(reader_stream);

        Ok(Self {
            child,
            reader,
            writer,
            script_path,
        })
    }

    pub fn send_line(&mut self, command: &str) -> Result<()> {
        for byte in command
            .as_bytes()
            .iter()
            .copied()
            .chain(std::iter::once(b'\n'))
        {
            self.writer.write_all(&[byte])?;
            self.writer.flush()?;
            // Some targets use tiny RTT down-buffers; pacing avoids truncating long commands.
            thread::sleep(Duration::from_millis(2));
        }
        Ok(())
    }

    pub fn read_line_until(&mut self, deadline: Instant) -> Result<Option<String>> {
        loop {
            if Instant::now() > deadline {
                return Ok(None);
            }

            let mut line = String::new();
            match self.reader.read_line(&mut line) {
                Ok(0) => {
                    return Err(BackendError::Io(std::io::Error::new(
                        ErrorKind::UnexpectedEof,
                        "RTT socket closed by peer",
                    )));
                }
                Ok(_) => {
                    let trimmed = line.trim_end_matches(['\r', '\n']).to_string();
                    if trimmed.is_empty() {
                        continue;
                    }
                    return Ok(Some(trimmed));
                }
                Err(err)
                    if err.kind() == ErrorKind::WouldBlock || err.kind() == ErrorKind::TimedOut =>
                {
                    continue;
                }
                Err(err) => return Err(BackendError::Io(err)),
            }
        }
    }

    pub fn send_command_and_wait_ack(
        &mut self,
        command: &str,
        ack_timeout: Duration,
    ) -> Result<RttCommandResult> {
        let max_attempts = 2;
        let mut final_lines = Vec::<String>::new();
        let mut final_err_msg: Option<String> = None;
        let command_upper = command.trim().to_ascii_uppercase();
        let command_keyword = command_upper.split_whitespace().next().unwrap_or("");
        let ack_timeout_for_command = command_ack_timeout(command_keyword, ack_timeout);

        for attempt in 0..max_attempts {
            self.send_line(command)?;

            let deadline = Instant::now() + ack_timeout_for_command;
            let mut lines = Vec::<String>::new();
            let mut first_err_msg: Option<String> = None;
            let mut saw_imu_stream_line = false;

            while let Some(line) = self.read_line_until(deadline)? {
                let line_trimmed = line.trim();
                let line_sanitized = strip_ansi_sequences(line_trimmed);
                let line_sanitized_trimmed = line_sanitized.trim();

                if line_sanitized_trimmed.starts_with("RTT_IMU,")
                    || line_sanitized_trimmed.starts_with("RTT_BIN,")
                {
                    saw_imu_stream_line = true;
                    if command_keyword == "START" {
                        lines.push(line);
                        return Ok(RttCommandResult {
                            command: command.to_string(),
                            ack: "STARTED (stream active; ACK dropped)".to_string(),
                            lines,
                        });
                    }
                }

                if let Some(ack) = parse_ack_ok_line(line_sanitized_trimmed) {
                    lines.push(line);
                    return Ok(RttCommandResult {
                        command: command.to_string(),
                        ack,
                        lines,
                    });
                }

                if let Some(err_msg) = parse_ack_err_line(line_sanitized_trimmed) {
                    if first_err_msg.is_none() {
                        first_err_msg = Some(err_msg);
                    }
                    lines.push(line);
                    continue;
                }

                lines.push(line);
            }

            if command_keyword == "START" && saw_imu_stream_line {
                return Ok(RttCommandResult {
                    command: command.to_string(),
                    ack: "STARTED (stream active; ACK dropped)".to_string(),
                    lines,
                });
            }

            if let Some(err_msg) = first_err_msg {
                final_lines = lines;
                final_err_msg = Some(err_msg);
                if attempt + 1 < max_attempts {
                    if saw_imu_stream_line && should_quiet_stream_before_retry(command_keyword) {
                        self.try_stop_stream(ack_timeout.min(Duration::from_millis(900)));
                    }
                    thread::sleep(Duration::from_millis(300));
                    continue;
                }
                break;
            }

            if attempt + 1 < max_attempts
                && saw_imu_stream_line
                && should_quiet_stream_before_retry(command_keyword)
            {
                final_lines = lines;
                self.try_stop_stream(ack_timeout.min(Duration::from_millis(900)));
                thread::sleep(Duration::from_millis(300));
                continue;
            }

            let banner_only = !lines.is_empty() && looks_like_jlink_banner_only(&lines);
            let no_output = lines.is_empty();
            final_lines = lines;

            if attempt + 1 < max_attempts && (banner_only || no_output) {
                // RTT can accept TCP before the target command channel is ready.
                thread::sleep(Duration::from_millis(300));
                continue;
            }
        }

        if let Some(err_msg) = final_err_msg {
            return Err(BackendError::InvalidInput(format!(
                "RTT command '{command}' failed: {err_msg}"
            )));
        }

        if !final_lines.is_empty() {
            let tail = final_lines
                .iter()
                .rev()
                .take(6)
                .rev()
                .cloned()
                .collect::<Vec<String>>()
                .join("\n");

            if looks_like_jlink_banner_only(&final_lines) {
                return Err(BackendError::InvalidInput(format!(
                    "timeout waiting for RTT_ACK after '{command}'. J-Link RTT is connected, but target firmware did not reply.\n\
Hint: flash calibration RTT firmware (build profile imu_calibration_rtt) and ensure app firmware is running (not halted).\n\
Last RTT lines:\n{tail}"
                )));
            }

            return Err(BackendError::InvalidInput(format!(
                "timeout waiting for RTT_ACK after '{command}'. Last RTT lines:\n{tail}"
            )));
        }

        Err(BackendError::InvalidInput(format!(
            "timeout waiting for RTT_ACK after '{command}'"
        )))
    }

    pub fn is_process_alive(&mut self) -> Result<bool> {
        Ok(self.child.try_wait()?.is_none())
    }

    fn try_stop_stream(&mut self, timeout: Duration) {
        if self.send_line("STOP").is_err() {
            return;
        }

        let deadline = Instant::now() + timeout;
        while let Ok(Some(line)) = self.read_line_until(deadline) {
            let line_sanitized = strip_ansi_sequences(line.trim());
            let trimmed = line_sanitized.trim();
            if parse_ack_ok_line(trimmed).is_some() || parse_ack_err_line(trimmed).is_some() {
                break;
            }
        }
    }
}

impl Drop for RttSession {
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        cleanup_script_file(self.script_path.as_deref());
    }
}

fn write_rtt_jlink_script(rtt_addr: u32) -> Result<PathBuf> {
    let timestamp_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let script_name = format!(
        "convoy_cal_rtt_{}_{}.JLinkScript",
        std::process::id(),
        timestamp_nanos
    );
    let script_path = env::temp_dir().join(script_name);
    let search_base = rtt_addr & !0x0FFF;

    let script_content = format!(
        "int ConfigTargetSettings(void) {{\n  JLINK_ExecCommand(\"SetRTTSearchRanges 0x{search_base:08X} 0x1000\");\n  JLINK_ExecCommand(\"SetRTTAddr 0x{rtt_addr:08X}\");\n  return 0;\n}}\n"
    );

    fs::write(&script_path, script_content)?;
    Ok(script_path)
}

fn cleanup_script_file(path: Option<&Path>) {
    if let Some(path) = path {
        let _ = fs::remove_file(path);
    }
}

#[cfg(target_os = "linux")]
fn cleanup_stale_jlink_servers(gdb_port: u16, rtt_telnet_port: u16) {
    let mut pids = find_jlink_server_pids_by_port(gdb_port);
    pids.extend(find_jlink_server_pids_by_port(rtt_telnet_port));
    pids.sort_unstable();
    pids.dedup();

    for pid in pids {
        if !is_jlink_server_pid(pid) {
            continue;
        }
        terminate_pid(pid);
    }
}

#[cfg(not(target_os = "linux"))]
fn cleanup_stale_jlink_servers(_gdb_port: u16, _rtt_telnet_port: u16) {}

#[cfg(target_os = "linux")]
fn find_jlink_server_pids_by_port(port: u16) -> Vec<u32> {
    let mut pids = Vec::<u32>::new();
    let Ok(output) = Command::new("ss").args(["-ltnp"]).output() else {
        return pids;
    };
    if !output.status.success() {
        return pids;
    }

    let port_marker = format!(":{port}");
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if !line.contains(&port_marker) {
            continue;
        }
        if !line.contains("JLinkGDBServer") && !line.contains("JLinkGDBServerC") {
            continue;
        }
        if let Some(pid) = parse_pid_from_ss_line(line) {
            pids.push(pid);
        }
    }

    pids
}

#[cfg(target_os = "linux")]
fn parse_pid_from_ss_line(line: &str) -> Option<u32> {
    let marker = "pid=";
    let idx = line.find(marker)?;
    let mut end = idx + marker.len();
    let bytes = line.as_bytes();
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    line[idx + marker.len()..end].parse::<u32>().ok()
}

#[cfg(target_os = "linux")]
fn is_jlink_server_pid(pid: u32) -> bool {
    let cmdline_path = format!("/proc/{pid}/cmdline");
    let Ok(bytes) = fs::read(cmdline_path) else {
        return false;
    };
    let cmdline = String::from_utf8_lossy(&bytes);
    cmdline.contains("JLinkGDBServer")
}

#[cfg(target_os = "linux")]
fn terminate_pid(pid: u32) {
    let pid_text = pid.to_string();
    let _ = Command::new("kill").args(["-TERM", &pid_text]).status();

    for _ in 0..8 {
        if !process_exists(pid) {
            return;
        }
        thread::sleep(Duration::from_millis(75));
    }

    let _ = Command::new("kill").args(["-KILL", &pid_text]).status();
}

#[cfg(target_os = "linux")]
fn process_exists(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

fn parse_ack_ok_line(line: &str) -> Option<String> {
    let ack_marker = "RTT_ACK,OK";
    if let Some(idx) = line.find(ack_marker) {
        let suffix = line[idx + ack_marker.len()..].trim_start_matches(',').trim();
        return Some(if suffix.is_empty() {
            "OK".to_string()
        } else {
            suffix.to_string()
        });
    }

    if let Some(idx) = line.find("ACK,OK") {
        let suffix = line[idx + "ACK,OK".len()..].trim_start_matches(',').trim();
        return Some(if suffix.is_empty() {
            "OK".to_string()
        } else {
            suffix.to_string()
        });
    }

    if line.eq_ignore_ascii_case("OK") {
        return Some("OK".to_string());
    }

    None
}

fn parse_ack_err_line(line: &str) -> Option<String> {
    let err_marker = "RTT_ACK,ERR";
    if let Some(idx) = line.find(err_marker) {
        let suffix = line[idx + err_marker.len()..].trim_start_matches(',').trim();
        return Some(if suffix.is_empty() {
            "unknown RTT error".to_string()
        } else {
            suffix.to_string()
        });
    }

    if let Some(idx) = line.find("ACK,ERR") {
        let suffix = line[idx + "ACK,ERR".len()..].trim_start_matches(',').trim();
        return Some(if suffix.is_empty() {
            "unknown RTT error".to_string()
        } else {
            suffix.to_string()
        });
    }

    if line.eq_ignore_ascii_case("ERR") {
        return Some("unknown RTT error".to_string());
    }

    if let Some(rest) = line.strip_prefix("ERR,") {
        let msg = rest.trim();
        return Some(if msg.is_empty() {
            "unknown RTT error".to_string()
        } else {
            msg.to_string()
        });
    }

    None
}

fn looks_like_jlink_banner_only(lines: &[String]) -> bool {
    if lines.is_empty() {
        return false;
    }

    let mut has_jlink_banner = false;
    for line in lines {
        let upper = line.to_ascii_uppercase();
        if upper.contains("RTT_ACK")
            || upper.contains("RTT_EVT")
            || upper.contains("RTT_STATUS")
            || upper.contains("RTT_HELP")
            || upper.contains("RTT_IMU")
        {
            return false;
        }

        if upper.contains("SEGGER J-LINK")
            || upper.contains("REAL TIME TERMINAL OUTPUT")
            || upper.contains("PROCESS: JLINKGDBSERVER")
            || upper.contains("JLINKGDBSERVERCL")
        {
            has_jlink_banner = true;
        }
    }

    has_jlink_banner
}

fn should_quiet_stream_before_retry(command_upper: &str) -> bool {
    command_upper != "START"
        && command_upper != "STOP"
        && command_upper != "STATUS"
        && command_upper != "PING"
        && command_upper != "HELP"
}

fn command_ack_timeout(command_keyword_upper: &str, base_timeout: Duration) -> Duration {
    match command_keyword_upper {
        // BNO APPLY can trigger internal sensor reset/erase workflows that exceed 2s.
        "APPLY" => base_timeout.max(Duration::from_millis(8_000)),
        _ => base_timeout,
    }
}

#[cfg(test)]
mod tests {
    use super::command_ack_timeout;
    use std::time::Duration;

    #[test]
    fn apply_timeout_is_extended() {
        let timeout = command_ack_timeout("APPLY", Duration::from_millis(2_000));
        assert_eq!(timeout, Duration::from_millis(8_000));
    }

    #[test]
    fn non_apply_timeout_is_unchanged() {
        let timeout = command_ack_timeout("STATUS", Duration::from_millis(2_000));
        assert_eq!(timeout, Duration::from_millis(2_000));
    }
}

fn strip_ansi_sequences(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;

    while i < bytes.len() {
        if bytes[i] == 0x1B {
            i += 1;
            if i < bytes.len() && bytes[i] == b'[' {
                i += 1;
                while i < bytes.len() {
                    let b = bytes[i];
                    i += 1;
                    if (0x40..=0x7E).contains(&b) {
                        break;
                    }
                }
                continue;
            }
            continue;
        }

        out.push(bytes[i] as char);
        i += 1;
    }

    out
}
