use crate::{BackendError, Result};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
}

pub fn run_command(program: &str, args: &[String], cwd: Option<&Path>) -> Result<CommandOutput> {
    let mut cmd = Command::new(program);
    cmd.args(args);

    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }

    let output = cmd.output()?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(BackendError::CommandFailed {
            program: format!("{} {}", program, args.join(" ")),
            exit_code: output.status.code(),
            stdout,
            stderr,
        });
    }

    Ok(CommandOutput { stdout, stderr })
}

pub fn tail_lines(text: &str, line_count: usize) -> String {
    let mut lines: Vec<&str> = text.lines().collect();
    if lines.len() > line_count {
        lines = lines.split_off(lines.len() - line_count);
    }
    lines.join("\n")
}
