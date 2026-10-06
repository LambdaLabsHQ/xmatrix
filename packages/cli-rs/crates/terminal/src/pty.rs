/// PTY wrapper: spawns child processes in a pseudo-terminal,
/// enabling ghost typing (stdin injection) and raw output capture.
use std::io::{Read, Write};

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};

use xmatrix_cli_core::error::{CliError, Result};

type PtyReader = Box<dyn std::io::Read + Send>;
type PtyWriter = Box<dyn std::io::Write + Send>;
type PtyMaster = Box<dyn MasterPty + Send>;
type PtyChild = Box<dyn Child + Send + Sync>;
type PtySlave = Box<dyn portable_pty::SlavePty>;

pub struct PtyWrapper {
    child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    reader: Box<dyn Read + Send>,
    // Keep the slave (pseudo-console handle on Windows) alive for the
    // lifetime of the session. Dropping it on Windows calls
    // ClosePseudoConsole which tears down the ConPTY immediately.
    _slave: Box<dyn portable_pty::SlavePty>,
}

impl PtyWrapper {
    /// Spawn a command inside a new PTY.
    pub fn spawn(
        cmd: &str,
        args: &[String],
        cwd: Option<&str>,
        env_vars: &[(String, String)],
        cols: u16,
        rows: u16,
    ) -> Result<Self> {
        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| CliError::Pty(format!("Failed to open PTY: {e}")))?;

        let mut command = CommandBuilder::new(cmd);
        command.args(args);
        if let Some(dir) = cwd {
            command.cwd(dir);
        }
        for (key, value) in env_vars {
            command.env(key, value);
        }

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| CliError::Pty(format!("Failed to spawn '{cmd}': {e}")))?;

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| CliError::Pty(format!("Failed to clone PTY reader: {e}")))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| CliError::Pty(format!("Failed to take PTY writer: {e}")))?;

        Ok(Self {
            child,
            master: pair.master,
            writer,
            reader,
            _slave: pair.slave,
        })
    }

    /// Ghost typing: inject text into the PTY's stdin as if a human typed it.
    /// Appends carriage return to simulate pressing Enter.
    #[allow(dead_code)]
    pub fn inject(&mut self, text: &str) -> Result<()> {
        self.writer
            .write_all(text.as_bytes())
            .map_err(|e| CliError::Pty(format!("inject write failed: {e}")))?;
        self.writer
            .write_all(b"\r")
            .map_err(|e| CliError::Pty(format!("inject CR failed: {e}")))?;
        self.writer
            .flush()
            .map_err(|e| CliError::Pty(format!("inject flush failed: {e}")))?;
        Ok(())
    }

    /// Write raw bytes into PTY stdin (no automatic CR).
    #[allow(dead_code)]
    pub fn write_raw(&mut self, data: &[u8]) -> Result<()> {
        self.writer
            .write_all(data)
            .map_err(|e| CliError::Pty(format!("write_raw failed: {e}")))?;
        self.writer
            .flush()
            .map_err(|e| CliError::Pty(format!("flush failed: {e}")))?;
        Ok(())
    }

    /// Take ownership of the reader (for use in a dedicated async task).
    /// Returns (reader, writer, child, _slave_guard). The caller must keep
    /// `_slave_guard` alive — on Windows it holds the ConPTY pseudo-console.
    pub fn take_reader(self) -> (PtyReader, PtyWriter, PtyMaster, PtyChild, PtySlave) {
        (
            self.reader,
            self.writer,
            self.master,
            self.child,
            self._slave,
        )
    }

    /// Check if child process is still running.
    #[allow(dead_code)]
    pub fn try_wait(&mut self) -> Result<Option<portable_pty::ExitStatus>> {
        self.child
            .try_wait()
            .map_err(|e| CliError::Pty(format!("try_wait failed: {e}")))
    }

    /// Wait for the child to exit.
    #[allow(dead_code)]
    pub fn wait(&mut self) -> Result<portable_pty::ExitStatus> {
        self.child
            .wait()
            .map_err(|e| CliError::Pty(format!("wait failed: {e}")))
    }

    /// Kill the child process.
    #[allow(dead_code)]
    pub fn kill(&mut self) -> Result<()> {
        self.child
            .kill()
            .map_err(|e| CliError::Pty(format!("kill failed: {e}")))
    }
}
