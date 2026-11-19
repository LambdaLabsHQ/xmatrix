//! Daemon startup-service installation: the one definition of how the xMatrix
//! daemon is registered with the user's login-session manager.
//!
//! `install.sh` / `install.ps1` and the Desktop App's bundled seed all call
//! `xmatrix setup daemon` after placing the binary, so the launchd plist, the
//! systemd user unit, and the Windows login Scheduled Task are generated here
//! and nowhere else.

use std::path::{Path, PathBuf};

use xmatrix_cli_core::error::{self, CliError};

pub const LAUNCHD_LABEL: &str = "sh.xmatrix.daemon";
pub const SYSTEMD_UNIT: &str = "xmatrix-daemon.service";
pub const WINDOWS_DAEMON_TASK_NAME: &str = "xmatrix-daemon";
pub const WINDOWS_DAEMON_LEGACY_TASK_NAME: &str = "xMatrix Daemon";
pub const WINDOWS_DAEMON_RUN_KEY_PATH: &str = r"HKCU:\Software\Microsoft\Windows\CurrentVersion\Run";
pub const WINDOWS_DAEMON_RUN_VALUE_NAME: &str = "xMatrixDaemon";
pub const WINDOWS_RUN_KEY_MANAGER: &str = "windows-run-key";
pub const DAEMON_SERVICE_MANAGER_FILE: &str = "daemon-service-manager";

/// What `install_daemon_service` registered, for the caller's report.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DaemonServiceInstall {
    pub manager: &'static str,
    pub definition_path: PathBuf,
}

impl DaemonServiceInstall {
    /// Whether the registered service manager restarts a daemon that exits
    /// unexpectedly (`launchd` KeepAlive, `systemd` Restart=always, or the
    /// Windows Scheduled Task 1-minute watchdog). The HKCU Run fallback only
    /// starts at Windows logon and has no watchdog.
    pub fn has_watchdog(&self) -> bool {
        self.manager != WINDOWS_RUN_KEY_MANAGER
    }
}

pub fn daemon_service_manager_state_path() -> PathBuf {
    xmatrix_cli_core::config::config_dir().join(DAEMON_SERVICE_MANAGER_FILE)
}

fn record_daemon_service_manager(manager: &str) {
    let path = daemon_service_manager_state_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let temporary = xmatrix_cli_core::config::unique_temporary_path(&path);
    if std::fs::write(&temporary, format!("{manager}\n")).is_ok()
        && xmatrix_cli_core::config::replace_file_atomically(&temporary, &path).is_err()
    {
        let _ = std::fs::remove_file(&temporary);
    }
}

fn clear_daemon_service_manager() {
    let _ = std::fs::remove_file(daemon_service_manager_state_path());
}

/// Last daemon service manager recorded on this machine (for example
/// `"scheduled-task"` or `"windows-run-key"`), if any.
pub fn recorded_daemon_service_manager() -> Option<String> {
    std::fs::read_to_string(daemon_service_manager_state_path())
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The PATH a login-session daemon sees. A service manager starts the daemon
/// with a bare system PATH, so the common user bin directories are added
/// explicitly; the binary's own directory comes first so the daemon can find
/// the copy that registered it.
pub fn daemon_path_unix(binary: &Path, home: &Path) -> String {
    let bin_dir = binary.parent().unwrap_or_else(|| Path::new("."));
    let home = home.display();
    format!(
        "{}:{home}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:{home}/.local/bin:{home}/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        bin_dir.display()
    )
}

pub fn launchd_plist_path(home: &Path) -> PathBuf {
    home.join("Library")
        .join("LaunchAgents")
        .join(format!("{LAUNCHD_LABEL}.plist"))
}

pub fn systemd_unit_path(home: &Path) -> PathBuf {
    home.join(".config")
        .join("systemd")
        .join("user")
        .join(SYSTEMD_UNIT)
}

/// launchd user agent: starts at login, is kept alive, and leaves the Agent
/// processes it spawned alive across its own restarts (`AbandonProcessGroup`).
/// launchd hands a job the C locale, which every spawned Agent inherits; under
/// it PostgreSQL refuses to start ("postmaster became multithreaded").
pub fn launchd_plist(binary: &Path, home: &Path) -> String {
    let binary = xml_escape(&binary.display().to_string());
    let path = xml_escape(&daemon_path_unix(Path::new(&binary), home));
    let logs = home.join("Library").join("Logs");
    let stdout = xml_escape(&logs.join("xmatrix-daemon.log").display().to_string());
    let stderr = xml_escape(&logs.join("xmatrix-daemon.err.log").display().to_string());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{binary}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
    <key>LC_ALL</key>
    <string>en_US.UTF-8</string>
    <key>PATH</key>
    <string>{path}</string>
    <key>XMATRIX_DAEMON_RESTART_WAIT_LOCK</key>
    <string>1</string>
  </dict>
  <key>StandardOutPath</key>
  <string>{stdout}</string>
  <key>StandardErrorPath</key>
  <string>{stderr}</string>
</dict>
</plist>
"#
    )
}

/// systemd user unit; `KillMode=process` keeps spawned Agents alive across a
/// daemon restart, matching launchd's `AbandonProcessGroup`.
pub fn systemd_unit(binary: &Path, home: &Path) -> String {
    let path = daemon_path_unix(binary, home);
    format!(
        r#"[Unit]
Description=xMatrix daemon
After=network-online.target

[Service]
ExecStart="{}" daemon
Environment=PATH={path}
Restart=always
RestartSec=5
KillMode=process

[Install]
WantedBy=default.target
"#,
        binary.display()
    )
}

fn xml_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            other => escaped.push(other),
        }
    }
    escaped
}

fn resolve_binary(binary: Option<&Path>) -> error::Result<PathBuf> {
    let candidate = match binary {
        Some(path) => path.to_path_buf(),
        None => std::env::current_exe()?,
    };
    let absolute = if candidate.is_absolute() {
        candidate
    } else {
        std::env::current_dir()?.join(candidate)
    };
    if !absolute.is_file() {
        return Err(CliError::Launch(format!(
            "daemon binary {} is not a file",
            absolute.display()
        )));
    }
    Ok(absolute)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn home_dir() -> error::Result<PathBuf> {
    dirs::home_dir()
        .ok_or_else(|| CliError::Launch("HOME is unavailable for the daemon service".into()))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn write_definition(path: &Path, contents: &str) -> error::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = xmatrix_cli_core::config::unique_temporary_path(path);
    std::fs::write(&temporary, contents)?;
    xmatrix_cli_core::config::replace_file_atomically(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        CliError::Io(error)
    })
}

/// Registers the daemon with the login-session manager and starts it now.
///
/// `binary` defaults to the running executable. Re-running is safe: the
/// definition is rewritten and the service is re-bootstrapped in place.
pub fn install_daemon_service(binary: Option<&Path>) -> error::Result<DaemonServiceInstall> {
    let binary = resolve_binary(binary)?;
    let installed = install_resolved_daemon_service(&binary)?;
    record_daemon_service_manager(installed.manager);
    Ok(installed)
}

/// Removes the daemon startup registration (including any Windows HKCU Run
/// fallback value) and stops the managed daemon.
pub fn uninstall_daemon_service() -> error::Result<()> {
    uninstall_resolved_daemon_service()?;
    clear_daemon_service_manager();
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_resolved_daemon_service(binary: &Path) -> error::Result<DaemonServiceInstall> {
    use std::process::{Command, Stdio};

    let home = home_dir()?;
    let plist_path = launchd_plist_path(&home);
    write_definition(&plist_path, &launchd_plist(binary, &home))?;

    let uid = unsafe { libc::getuid() };
    let domain = format!("gui/{uid}");
    let service = format!("{domain}/{LAUNCHD_LABEL}");
    let plist = plist_path.to_string_lossy().to_string();
    let quiet = |command: &mut Command| {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    };
    // A previous registration may still be loaded; bootout is best effort.
    let _ = quiet(Command::new("launchctl").args(["bootout", &domain, &plist]));
    // launchd releases the old registration asynchronously; retry briefly
    // instead of failing the install on the first attempt.
    crate::retry_launchctl_bootstrap("launchctl bootstrap", || {
        quiet(Command::new("launchctl").args(["bootstrap", &domain, &plist]))
    })?;
    let _ = quiet(Command::new("launchctl").args(["enable", &service]));
    let _ = quiet(Command::new("launchctl").args(["kickstart", "-k", &service]));
    Ok(DaemonServiceInstall {
        manager: "launchd",
        definition_path: plist_path,
    })
}

#[cfg(target_os = "linux")]
fn install_resolved_daemon_service(binary: &Path) -> error::Result<DaemonServiceInstall> {
    use std::process::{Command, Stdio};

    let home = home_dir()?;
    let unit_path = systemd_unit_path(&home);
    write_definition(&unit_path, &systemd_unit(binary, &home))?;
    let run = |args: &[&str]| -> error::Result<()> {
        let status = Command::new("systemctl")
            .args(args)
            .stdin(Stdio::null())
            .status()
            .map_err(|error| {
                CliError::Launch(format!(
                    "systemctl is required to install the xMatrix daemon service: {error}"
                ))
            })?;
        if status.success() {
            Ok(())
        } else {
            Err(CliError::Launch(format!(
                "systemctl {} failed with {status}",
                args.join(" ")
            )))
        }
    };
    run(&["--user", "daemon-reload"])?;
    run(&["--user", "enable", "--now", SYSTEMD_UNIT])?;
    enable_linux_user_linger()?;
    Ok(DaemonServiceInstall {
        manager: "systemd",
        definition_path: unit_path,
    })
}

/// A user manager without lingering dies with the login session, which stops
/// the daemon even when the unit is enabled. Enable lingering for the current
/// user so the unit keeps running after logout.
#[cfg(target_os = "linux")]
fn enable_linux_user_linger() -> error::Result<()> {
    use std::process::{Command, Stdio};

    let status = Command::new("loginctl")
        .args(linux_user_linger_args())
        .stdin(Stdio::null())
        .status()
        .map_err(|error| {
            CliError::Launch(format!(
                "loginctl is required so the user daemon keeps running after logout: {error}"
            ))
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(CliError::Launch(format!(
            "loginctl enable-linger failed with {status}. The daemon unit is installed, but it stops when this login ends."
        )))
    }
}

#[cfg(any(target_os = "linux", test))]
fn linux_user_linger_args() -> &'static [&'static str] {
    &["enable-linger"]
}

fn windows_stop_daemon_processes_snippet() -> &'static str {
    r#"function Stop-XMatrixDaemonProcesses {
  Get-CimInstance Win32_Process -Filter "Name = 'xmatrix.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProcessId -ne $callerPid -and
      $_.CommandLine -match 'xmatrix\.exe"?\s+daemon(\s|$)'
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}"#
}

/// Whether a Windows Scheduled Task registration failure was caused by missing
/// Task Scheduler permissions (`Access is denied`, `PermissionDenied`,
/// `0x80070005`, or localized `拒绝访问`).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn is_windows_task_permission_denied(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    lower.contains("access is denied")
        || lower.contains("permissiondenied")
        || lower.contains("0x80070005")
        || detail.contains("拒绝访问")
}

fn windows_run_key_prelude(caller_pid: u32) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'\n\
         $runKey = {run_key}\n\
         $runValueName = {run_value}\n\
         $callerPid = {caller_pid}\n",
        run_key = powershell_single_quoted(WINDOWS_DAEMON_RUN_KEY_PATH),
        run_value = powershell_single_quoted(WINDOWS_DAEMON_RUN_VALUE_NAME),
    )
}

fn windows_daemon_script_prelude(binary: &Path, caller_pid: u32) -> String {
    let mut script = windows_run_key_prelude(caller_pid);
    script.push_str(&format!(
        "$InstallPath = {install_path}\n\
         $installDirectory = Split-Path -Parent $InstallPath\n",
        install_path = powershell_single_quoted(&binary.display().to_string()),
    ));
    script
}

/// Removes every Windows daemon startup entry (both Scheduled Tasks and any
/// HKCU Run fallback value) and stops running daemon processes.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_daemon_uninstall_script(caller_pid: u32) -> String {
    let mut script = windows_run_key_prelude(caller_pid);
    script.push_str(&format!(
        "$taskName = {}\n$legacyTaskName = {}\n",
        powershell_single_quoted(WINDOWS_DAEMON_TASK_NAME),
        powershell_single_quoted(WINDOWS_DAEMON_LEGACY_TASK_NAME),
    ));
    script.push_str(windows_stop_daemon_processes_snippet());
    script.push_str(
        r#"
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $legacyTaskName -Confirm:$false -ErrorAction SilentlyContinue
Remove-ItemProperty -Path $runKey -Name $runValueName -ErrorAction SilentlyContinue
Stop-XMatrixDaemonProcesses
"#,
    );
    script
}

/// Per-user HKCU Run-key fallback when Windows policy or an elevated prior task
/// refuses `Register-ScheduledTask` (`0x80070005`): registers login startup
/// under the current user's hive, stops leftover daemon processes, and starts
/// the daemon directly without requiring Task Scheduler access.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_daemon_run_key_fallback_script(binary: &Path, caller_pid: u32) -> String {
    let mut script = windows_daemon_script_prelude(binary, caller_pid);
    script.push_str(
        r#"if (-not (Test-Path -Path $runKey)) {
  New-Item -Path $runKey -Force | Out-Null
}
New-ItemProperty -Path $runKey -Name $runValueName -Value ('"' + $InstallPath + '" daemon') -PropertyType String -Force | Out-Null
"#,
    );
    script.push_str(windows_stop_daemon_processes_snippet());
    script.push_str(
        r#"
Stop-XMatrixDaemonProcesses
Start-Process -FilePath $InstallPath -ArgumentList 'daemon' -WorkingDirectory $installDirectory -WindowStyle Hidden
"#,
    );
    script
}

/// Per-user login Scheduled Task that runs the stable CLI as `daemon`.
///
/// Mirrors the former `Install-DaemonStartup` body from `install.ps1`: direct
/// execute of the binary (no WScript bridge), keep an already-correct task,
/// replace anything else, then stop leftover daemon processes and start the
/// task. Pure so every host can assert the shape; only Windows runs it.
///
/// `caller_pid` is the `xmatrix setup daemon` process that spawned this
/// script. The stop filter must skip it: its command line contains
/// ` setup daemon `, which used to match a looser `\sdaemon` pattern and kill
/// the installer mid-run.
pub fn windows_daemon_scheduled_task_script(binary: &Path, caller_pid: u32) -> String {
    let mut script = windows_daemon_script_prelude(binary, caller_pid);
    script.push_str(&format!(
        "$taskName = {}\n$legacyTaskName = {}\n",
        powershell_single_quoted(WINDOWS_DAEMON_TASK_NAME),
        powershell_single_quoted(WINDOWS_DAEMON_LEGACY_TASK_NAME),
    ));
    script.push_str(
        r#"$action = New-ScheduledTaskAction `
  -Execute $InstallPath `
  -Argument "daemon" `
  -WorkingDirectory $installDirectory
# A logon trigger without -User fires for every user, and registering one
# needs an elevated shell; a standard user gets "Access is denied".
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
# The restart settings below only cover a task that fails to start; Task
# Scheduler never restarts a daemon that exits later. This trigger asks for the
# task every minute, and IgnoreNew makes that a no-op while the daemon runs, so
# an exited daemon is back within a minute, as launchd/systemd do elsewhere.
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Today) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 0)

if (Get-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $legacyTaskName -Confirm:$false
}

$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$keepExistingTask = $false
if ($existingTask) {
  $existingAction = $existingTask.Actions | Select-Object -First 1
  $keepExistingTask = (
    $existingAction -and
    ([System.IO.Path]::GetFullPath([string]$existingAction.Execute) -ieq [System.IO.Path]::GetFullPath($InstallPath)) -and
    ([string]$existingAction.Arguments).Trim() -eq "daemon" -and
    ([System.IO.Path]::GetFullPath([string]$existingAction.WorkingDirectory) -ieq [System.IO.Path]::GetFullPath($installDirectory)) -and
    (@($existingTask.Triggers | Where-Object { $_.Repetition -and $_.Repetition.Interval -eq 'PT1M' }).Count -gt 0)
  )
}

if (-not $keepExistingTask) {
  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger @($trigger, $watchdogTrigger) `
    -Settings $settings `
    -Description "Starts the xMatrix daemon at user login." `
    -Force | Out-Null
}

# Remove any earlier HKCU Run fallback once the Scheduled Task owns logon start.
Remove-ItemProperty -Path $runKey -Name $runValueName -ErrorAction SilentlyContinue

"#,
    );
    script.push_str(windows_stop_daemon_processes_snippet());
    script.push_str(
        r#"

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Stop-XMatrixDaemonProcesses
Start-ScheduledTask -TaskName $taskName
"#,
    );
    script
}

fn powershell_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Runs a generated setup script with Windows PowerShell and returns its
/// failure text when it exits unsuccessfully.
///
/// The failure text must reach the CLI as UTF-8 in every Windows locale.
/// Left alone, Windows PowerShell writes through the OEM code page (CP936 on
/// Chinese Windows), so an error such as `拒绝访问。` arrives as U+FFFD. The
/// prelude switches the console output encoding to UTF-8, and the catch
/// writes through `[Console]::Error`, which .NET recreates with that
/// encoding, rather than through the host's own error formatter.
#[cfg(windows)]
fn run_windows_setup_script(body: &str) -> error::Result<Result<(), String>> {
    use std::process::{Command, Stdio};

    let script_path = std::env::temp_dir().join(format!(
        "xmatrix-setup-daemon-{}-{}.ps1",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));
    // Windows PowerShell reads a BOM-less script in the ANSI code page, which
    // would garble a non-ASCII install path such as a Chinese user name.
    let script = format!(
        "\u{feff}$OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n\
         try {{ [Console]::OutputEncoding = $OutputEncoding }} catch {{ }}\n\
         try {{\n{body}\n}} catch {{\n\
           [Console]::Error.WriteLine(($_ | Out-String -Width 4096).Trim())\n\
           exit 1\n\
         }}\n"
    );
    std::fs::write(&script_path, script)?;
    let mut command = Command::new("powershell");
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script_path.display().to_string(),
        ])
        .stdin(Stdio::null())
        .output();
    let _ = std::fs::remove_file(&script_path);
    let output = output.map_err(|error| {
        CliError::Launch(format!(
            "powershell is required to install the xMatrix daemon Scheduled Task: {error}"
        ))
    })?;
    if output.status.success() {
        return Ok(Ok(()));
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(Err([stderr.trim(), stdout.trim()]
        .into_iter()
        .find(|part| !part.is_empty())
        .unwrap_or("no output")
        .to_string()))
}

/// Windows' own switch for Win32 paths past MAX_PATH (260). Without it no
/// process can open them, whatever its manifest says; Git, Node and every
/// harness an Agent runs read it when they start.
#[cfg_attr(not(windows), allow(dead_code))]
pub const WINDOWS_LONG_PATHS_KEY: &str = r"HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem";

/// The administrator command that turns Windows long paths on.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_long_paths_enable_command() -> String {
    format!(
        "New-ItemProperty -Path '{WINDOWS_LONG_PATHS_KEY}' -Name LongPathsEnabled -Value 1 -PropertyType DWord -Force"
    )
}

/// Turns Windows long paths on when they are off. Setting a machine-wide
/// value needs an administrator, so a standard user approves one UAC prompt;
/// an already-enabled machine is left alone without one.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_long_paths_script() -> String {
    let key = powershell_single_quoted(WINDOWS_LONG_PATHS_KEY);
    let enable = powershell_single_quoted(&windows_long_paths_enable_command());
    format!(
        r#"$key = {key}
function Test-LongPaths {{
  (Get-ItemProperty -Path $key -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled -eq 1
}}
if (-not (Test-LongPaths)) {{
  Start-Process -FilePath powershell -Verb RunAs -Wait -WindowStyle Hidden `
    -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', {enable})
  if (-not (Test-LongPaths)) {{
    throw 'LongPathsEnabled is still 0 after the administrator command ran'
  }}
}}"#
    )
}

#[cfg(windows)]
fn install_resolved_daemon_service(binary: &Path) -> error::Result<DaemonServiceInstall> {
    // Before the daemon starts: a process reads the switch once, at start.
    if let Err(detail) = run_windows_setup_script(&windows_long_paths_script())? {
        eprintln!(
            "Windows long paths are off ({WINDOWS_LONG_PATHS_KEY}\\LongPathsEnabled is not 1), so Agents cannot use paths longer than 260 characters. Turning them on needs an administrator: {detail}\nRun this in an administrator PowerShell, then restart the xMatrix daemon:\n  {}",
            windows_long_paths_enable_command()
        );
    }
    let script = windows_daemon_scheduled_task_script(binary, std::process::id());
    if let Err(detail) = run_windows_setup_script(&script)? {
        if is_windows_task_permission_denied(&detail) {
            let fallback = windows_daemon_run_key_fallback_script(binary, std::process::id());
            if let Err(fallback_detail) = run_windows_setup_script(&fallback)? {
                return Err(CliError::Launch(format!(
                    "Registering Scheduled Task {WINDOWS_DAEMON_TASK_NAME} failed: {detail}\n\
                     Fallback HKCU Run registration also failed: {fallback_detail}"
                )));
            }
            eprintln!(
                "Windows denied registering Scheduled Task {WINDOWS_DAEMON_TASK_NAME}; \
                 installed per-user login startup under {WINDOWS_DAEMON_RUN_KEY_PATH}\\{WINDOWS_DAEMON_RUN_VALUE_NAME} and started the daemon directly.\n\
                 Warning: without Task Scheduler, there is no automatic restart watchdog — if the daemon exits, it will not restart until your next Windows sign-in or reopening the xMatrix app."
            );
            return Ok(DaemonServiceInstall {
                manager: WINDOWS_RUN_KEY_MANAGER,
                definition_path: PathBuf::from(WINDOWS_DAEMON_RUN_KEY_PATH),
            });
        }
        return Err(CliError::Launch(format!(
            "Registering Scheduled Task {WINDOWS_DAEMON_TASK_NAME} failed: {detail}"
        )));
    }
    Ok(DaemonServiceInstall {
        manager: "scheduled-task",
        definition_path: PathBuf::from(WINDOWS_DAEMON_TASK_NAME),
    })
}

#[cfg(target_os = "macos")]
fn uninstall_resolved_daemon_service() -> error::Result<()> {
    use std::process::{Command, Stdio};

    let home = home_dir()?;
    let plist_path = launchd_plist_path(&home);
    let uid = unsafe { libc::getuid() };
    let domain = format!("gui/{uid}");
    let plist = plist_path.to_string_lossy().to_string();
    let _ = Command::new("launchctl")
        .args(["bootout", &domain, &plist])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if plist_path.exists() {
        std::fs::remove_file(&plist_path)?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn uninstall_resolved_daemon_service() -> error::Result<()> {
    use std::process::{Command, Stdio};

    let home = home_dir()?;
    let unit_path = systemd_unit_path(&home);
    let _ = Command::new("systemctl")
        .args(["--user", "disable", "--now", SYSTEMD_UNIT])
        .stdin(Stdio::null())
        .status();
    if unit_path.exists() {
        std::fs::remove_file(&unit_path)?;
    }
    let _ = Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .stdin(Stdio::null())
        .status();
    Ok(())
}

#[cfg(windows)]
fn uninstall_resolved_daemon_service() -> error::Result<()> {
    let script = windows_daemon_uninstall_script(std::process::id());
    if let Err(detail) = run_windows_setup_script(&script)? {
        return Err(CliError::Launch(format!(
            "Removing Windows daemon startup entries failed: {detail}"
        )));
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn uninstall_resolved_daemon_service() -> error::Result<()> {
    Err(CliError::Launch(
        "`xmatrix setup uninstall` supports launchd, systemd --user, and Windows only".into(),
    ))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn install_resolved_daemon_service(binary: &Path) -> error::Result<DaemonServiceInstall> {
    let _ = binary;
    Err(CliError::Launch(
        "`xmatrix setup daemon` supports launchd, systemd --user, and Windows Scheduled Tasks only"
            .into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/Users/tester")
    }

    #[test]
    fn windows_setup_turns_long_paths_on_through_one_elevated_command() {
        let script = windows_long_paths_script();
        assert!(script.starts_with(r"$key = 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem'"));
        assert!(script.contains("-Verb RunAs"));
        // The elevated child receives the exact command, single-quoted once.
        assert!(script.contains(
            r"'New-ItemProperty -Path ''HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem'' -Name LongPathsEnabled -Value 1 -PropertyType DWord -Force'"
        ));
        assert!(script.contains("throw 'LongPathsEnabled is still 0"));
    }

    #[test]
    fn daemon_path_puts_the_binary_directory_first_and_covers_user_bins() {
        let path = daemon_path_unix(Path::new("/opt/xm/bin/xmatrix"), &home());
        assert!(path.starts_with("/opt/xm/bin:"));
        for required in [
            "/Users/tester/.cargo/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/Users/tester/.local/bin",
            "/Users/tester/bin",
            "/usr/bin",
        ] {
            assert!(
                path.split(':').any(|segment| segment == required),
                "{required}"
            );
        }
    }

    // Unix artifacts: `Path::join` puts backslashes in these on Windows.
    #[cfg(unix)]
    #[test]
    fn launchd_plist_registers_the_binary_with_agent_survival_and_a_full_path() {
        let plist = launchd_plist(Path::new("/Users/tester/.local/bin/xmatrix"), &home());
        assert!(plist.contains("<string>sh.xmatrix.daemon</string>"));
        assert!(plist.contains(
            "<array>\n    <string>/Users/tester/.local/bin/xmatrix</string>\n    <string>daemon</string>\n  </array>"
        ));
        assert!(plist.contains("<key>AbandonProcessGroup</key>\n  <true/>"));
        assert!(plist.contains("<key>KeepAlive</key>\n  <true/>"));
        assert!(
            plist.contains("<key>XMATRIX_DAEMON_RESTART_WAIT_LOCK</key>\n    <string>1</string>")
        );
        assert!(plist.contains("<key>LANG</key>\n    <string>en_US.UTF-8</string>"));
        assert!(plist.contains("<key>LC_ALL</key>\n    <string>en_US.UTF-8</string>"));
        assert!(plist.contains("<string>/Users/tester/.local/bin:/Users/tester/.cargo/bin:"));
        assert!(plist.contains("<string>/Users/tester/Library/Logs/xmatrix-daemon.log</string>"));
        assert!(
            plist.contains("<string>/Users/tester/Library/Logs/xmatrix-daemon.err.log</string>")
        );
    }

    // Unix artifacts: `Path::join` puts backslashes in these on Windows.
    #[cfg(unix)]
    #[test]
    fn launchd_plist_escapes_xml_in_paths() {
        let plist = launchd_plist(Path::new("/Users/a&b/<bin>/\"x\"/xmatrix"), &home());
        assert!(
            plist.contains("<string>/Users/a&amp;b/&lt;bin&gt;/&quot;x&quot;/xmatrix</string>")
        );
        assert!(!plist.contains("a&b"));
    }

    #[test]
    fn linux_user_linger_enables_lingering_for_the_current_user() {
        assert_eq!(linux_user_linger_args(), ["enable-linger"]);
    }

    // Unix artifacts: `Path::join` puts backslashes in these on Windows.
    #[cfg(unix)]
    #[test]
    fn systemd_unit_keeps_agents_alive_across_daemon_restarts() {
        let unit = systemd_unit(
            Path::new("/home/tester/.local/bin/xmatrix"),
            Path::new("/home/tester"),
        );
        assert!(unit.contains("ExecStart=\"/home/tester/.local/bin/xmatrix\" daemon\n"));
        assert!(unit.contains("Environment=PATH=/home/tester/.local/bin:/home/tester/.cargo/bin:"));
        assert!(unit.contains("KillMode=process\n"));
        assert!(unit.contains("Restart=always\n"));
        assert!(unit.contains("WantedBy=default.target\n"));
    }

    // Unix artifacts: `Path::join` puts backslashes in these on Windows.
    #[cfg(unix)]
    #[test]
    fn definition_paths_follow_each_manager_convention() {
        assert_eq!(
            launchd_plist_path(&home()),
            PathBuf::from("/Users/tester/Library/LaunchAgents/sh.xmatrix.daemon.plist")
        );
        assert_eq!(
            systemd_unit_path(Path::new("/home/tester")),
            PathBuf::from("/home/tester/.config/systemd/user/xmatrix-daemon.service")
        );
    }

    #[test]
    fn a_missing_binary_is_refused_before_any_service_is_touched() {
        let error = install_daemon_service(Some(Path::new("/definitely/missing/xmatrix")))
            .unwrap_err()
            .to_string();
        assert!(error.contains("is not a file"), "{error}");
    }

    #[test]
    fn windows_scheduled_task_runs_the_stable_binary_directly_at_logon() {
        let script = windows_daemon_scheduled_task_script(
            Path::new(r"C:\Users\tester\.local\bin\xmatrix.exe"),
            4242,
        );
        assert!(script.contains(r"$InstallPath = 'C:\Users\tester\.local\bin\xmatrix.exe'"));
        assert!(script.contains(&format!("$taskName = '{WINDOWS_DAEMON_TASK_NAME}'")));
        assert!(script.contains(&format!(
            "$legacyTaskName = '{WINDOWS_DAEMON_LEGACY_TASK_NAME}'"
        )));
        assert!(script.contains("New-ScheduledTaskAction"));
        assert!(script.contains("-Execute $InstallPath"));
        assert!(script.contains("-Argument \"daemon\""));
        assert!(script.contains("-WorkingDirectory $installDirectory"));
        assert!(script.contains("New-ScheduledTaskTrigger -AtLogOn -User $currentUser"));
        assert!(script.contains("-RestartCount 999"));
        // Task Scheduler restarts only a task that failed to start; the
        // repeating trigger is what brings back a daemon that exited (#1750).
        assert!(script.contains(
            "New-ScheduledTaskTrigger -Once -At ([DateTime]::Today) -RepetitionInterval (New-TimeSpan -Minutes 1)"
        ));
        assert!(script.contains("-Trigger @($trigger, $watchdogTrigger)"));
        assert!(script.contains("$_.Repetition.Interval -eq 'PT1M'"));
        assert!(script.contains("$keepExistingTask = ("));
        assert!(script.contains("if (-not $keepExistingTask)"));
        assert!(script.contains("GetFullPath([string]$existingAction.Execute)"));
        assert!(script.contains("Arguments).Trim() -eq \"daemon\""));
        assert!(script.contains("Register-ScheduledTask"));
        assert!(script.contains("Start-ScheduledTask -TaskName $taskName"));
        assert!(!script.to_ascii_lowercase().contains("wscript"));
        assert!(!script.to_ascii_lowercase().contains("launch-hidden"));
        assert!(!script.to_ascii_lowercase().contains("active-generation"));
    }

    #[test]
    fn windows_daemon_stop_filter_skips_the_setup_daemon_caller() {
        let script = windows_daemon_scheduled_task_script(
            Path::new(r"C:\Users\tester\.local\bin\xmatrix.exe"),
            4242,
        );
        assert!(script.contains("$callerPid = 4242"));
        assert!(script.contains("$_.ProcessId -ne $callerPid"));
        assert!(script.contains(r#"xmatrix\.exe"?\s+daemon(\s|$)"#));
        assert!(
            !script.contains(r"\sdaemon(\s|$)"),
            "loose daemon substring must not remain; it matches `setup daemon`"
        );
    }

    // The failure text a Chinese-locale PowerShell reports (`拒绝访问。`) must
    // reach the caller readable, not as OEM-code-page bytes decoded as U+FFFD.
    #[cfg(windows)]
    #[test]
    fn windows_setup_script_failures_reach_the_caller_as_utf8() {
        let detail = run_windows_setup_script(
            "$path = 'C:\\Users\\张三\\.local\\bin\\xmatrix.exe'\nthrow \"拒绝访问。 $path\"",
        )
        .unwrap()
        .unwrap_err();
        assert!(
            detail.contains(r"拒绝访问。 C:\Users\张三\.local\bin\xmatrix.exe"),
            "{detail}"
        );
        assert!(!detail.contains('\u{fffd}'), "{detail}");
    }

    #[cfg(windows)]
    #[test]
    fn a_successful_windows_setup_script_reports_no_failure() {
        assert_eq!(
            run_windows_setup_script("Write-Output 'ok'").unwrap(),
            Ok(())
        );
    }

    #[test]
    fn windows_scheduled_task_script_escapes_single_quotes_in_paths() {
        let script = windows_daemon_scheduled_task_script(
            Path::new(r"C:\Users\O'Brien\.local\bin\xmatrix.exe"),
            1,
        );
        assert!(script.contains(r"$InstallPath = 'C:\Users\O''Brien\.local\bin\xmatrix.exe'"));
        assert!(script.contains("Remove-ItemProperty -Path $runKey -Name $runValueName"));
    }

    #[test]
    fn windows_task_permission_denied_matches_english_hresult_and_chinese_errors() {
        assert!(is_windows_task_permission_denied(
            "Register-ScheduledTask : Access is denied.\n+ CategoryInfo : PermissionDenied"
        ));
        assert!(is_windows_task_permission_denied(
            "FullyQualifiedErrorId : HRESULT 0x80070005,Register-ScheduledTask"
        ));
        assert!(is_windows_task_permission_denied(
            "Register-ScheduledTask : 拒绝访问。"
        ));
        assert!(!is_windows_task_permission_denied(
            "The system cannot find the file specified."
        ));
    }

    #[test]
    fn windows_run_key_fallback_registers_hkcu_logon_and_starts_daemon_directly() {
        let script = windows_daemon_run_key_fallback_script(
            Path::new(r"C:\Users\O'Brien\.local\bin\xmatrix.exe"),
            4242,
        );
        assert!(script.contains(r"$InstallPath = 'C:\Users\O''Brien\.local\bin\xmatrix.exe'"));
        assert!(script.contains(WINDOWS_DAEMON_RUN_KEY_PATH));
        assert!(script.contains(WINDOWS_DAEMON_RUN_VALUE_NAME));
        assert!(script.contains("New-ItemProperty -Path $runKey -Name $runValueName"));
        assert!(script.contains("$_.ProcessId -ne $callerPid"));
        assert!(script.contains(
            "Start-Process -FilePath $InstallPath -ArgumentList 'daemon' -WorkingDirectory $installDirectory -WindowStyle Hidden"
        ));
        assert!(!script.contains("Register-ScheduledTask"));
    }

    #[test]
    fn windows_daemon_uninstall_removes_scheduled_tasks_hkcu_run_and_stops_processes() {
        let script = windows_daemon_uninstall_script(4242);
        assert!(script.contains(&format!("$taskName = '{WINDOWS_DAEMON_TASK_NAME}'")));
        assert!(script.contains(&format!(
            "$legacyTaskName = '{WINDOWS_DAEMON_LEGACY_TASK_NAME}'"
        )));
        assert!(script.contains(WINDOWS_DAEMON_RUN_KEY_PATH));
        assert!(script.contains(WINDOWS_DAEMON_RUN_VALUE_NAME));
        assert!(script.contains("Unregister-ScheduledTask -TaskName $taskName"));
        assert!(script.contains("Unregister-ScheduledTask -TaskName $legacyTaskName"));
        assert!(script.contains("Remove-ItemProperty -Path $runKey -Name $runValueName"));
        assert!(script.contains("$callerPid = 4242"));
        assert!(script.contains("Stop-XMatrixDaemonProcesses"));
    }

    #[test]
    fn windows_run_key_reports_no_watchdog_while_other_managers_have_one() {
        let run_key = DaemonServiceInstall {
            manager: WINDOWS_RUN_KEY_MANAGER,
            definition_path: PathBuf::from(WINDOWS_DAEMON_RUN_KEY_PATH),
        };
        assert!(!run_key.has_watchdog());

        let scheduled = DaemonServiceInstall {
            manager: "scheduled-task",
            definition_path: PathBuf::from(WINDOWS_DAEMON_TASK_NAME),
        };
        assert!(scheduled.has_watchdog());
    }
}
