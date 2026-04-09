use crate::types::RttCommandResult;
use crate::{BackendError, Result};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const READ_POLL_TIMEOUT: Duration = Duration::from_millis(150);

#[derive(Debug, Clone)]
pub struct RttServerConfig {
    pub serial_number: Option<String>,
    pub device_name: String,
    pub speed_khz: u32,
    pub gdb_port: u16,
    pub rtt_telnet_port: u16,
    pub connect_timeout: Duration,
}

pub struct RttSession {
    child: Child,
    reader: BufReader<TcpStream>,
    writer: TcpStream,
}

impl RttSession {
    pub fn start(gdb_server_executable: &str, config: &RttServerConfig) -> Result<Self> {
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

        if let Some(serial_number) = &config.serial_number {
            if !serial_number.trim().is_empty() {
                args.push("-select".to_string());
                args.push(format!("USB={serial_number}"));
            }
        }

        let mut child = Command::new(gdb_server_executable)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;

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
                        return Err(BackendError::InvalidInput(format!(
                            "J-Link GDB server exited before RTT connection (status: {status})"
                        )));
                    }

                    if connect_start.elapsed() >= config.connect_timeout {
                        let _ = child.kill();
                        let _ = child.wait();
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
        })
    }

    pub fn send_line(&mut self, command: &str) -> Result<()> {
        self.writer.write_all(command.as_bytes())?;
        self.writer.write_all(b"\n")?;
        self.writer.flush()?;
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
                    thread::sleep(Duration::from_millis(20));
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
        self.send_line(command)?;

        let deadline = Instant::now() + ack_timeout;
        let mut lines = Vec::<String>::new();

        while let Some(line) = self.read_line_until(deadline)? {
            if line.starts_with("RTT_ACK,OK") {
                let ack = line.splitn(3, ',').nth(2).unwrap_or("OK").to_string();

                lines.push(line);
                return Ok(RttCommandResult {
                    command: command.to_string(),
                    ack,
                    lines,
                });
            }

            if line.starts_with("RTT_ACK,ERR") {
                let err_msg = line
                    .splitn(3, ',')
                    .nth(2)
                    .unwrap_or("unknown RTT error")
                    .to_string();

                return Err(BackendError::InvalidInput(format!(
                    "RTT command '{command}' failed: {err_msg}"
                )));
            }

            lines.push(line);
        }

        Err(BackendError::InvalidInput(format!(
            "timeout waiting for RTT_ACK after '{command}'"
        )))
    }

    pub fn is_process_alive(&mut self) -> Result<bool> {
        Ok(self.child.try_wait()?.is_none())
    }
}

impl Drop for RttSession {
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}
