//! Process-scoped PowerShell entrypoints for Windows Agent tools. No profile or
//! machine-wide locale changes; the signed CLI supplies the entrypoint bytes.

#[cfg(any(windows, test))]
use base64::{Engine as _, engine::general_purpose::STANDARD};

#[cfg(any(windows, test))]
const PRELUDE: &str = "$global:OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = $global:OutputEncoding; [Console]::OutputEncoding = $global:OutputEncoding; ";

#[cfg(any(windows, test))]
fn encoded(script: &str) -> String {
    STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    )
}

#[cfg(any(windows, test))]
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Preserve host options, but run the fixed encoding setup before the caller's
/// command. EncodedCommand is UTF-16LE as specified by PowerShell itself.
#[cfg(any(windows, test))]
fn shell_args(args: &[String]) -> Result<Vec<String>, String> {
    let mut options = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let option = args[index].to_ascii_lowercase();
        match option.as_str() {
            "-command" | "-c" => {
                let command = args[index + 1..].join(" ");
                if command == "-" {
                    return Err("UTF-8 PowerShell requires a command argument; use -Command with the script text".into());
                }
                options.extend(["-EncodedCommand".into(), encoded(&format!("{PRELUDE}. {{\n{command}\n}}"))]);
                return Ok(options);
            }
            "-encodedcommand" | "-enc" | "-e" => {
                let payload = args.get(index + 1).ok_or("PowerShell EncodedCommand is missing")?;
                let bytes = STANDARD.decode(payload).map_err(|_| "Invalid PowerShell EncodedCommand")?;
                if bytes.len() % 2 != 0 || index + 2 != args.len() {
                    return Err("Invalid PowerShell EncodedCommand".into());
                }
                let units = bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect::<Vec<_>>();
                let command = String::from_utf16(&units).map_err(|_| "Invalid PowerShell EncodedCommand")?;
                options.extend(["-EncodedCommand".into(), encoded(&format!("{PRELUDE}. {{\n{command}\n}}"))]);
                return Ok(options);
            }
            "-file" | "-f" => {
                let file = args.get(index + 1).ok_or("PowerShell File is missing")?;
                let mut command = format!("{PRELUDE}& {}", quote(file));
                for argument in &args[index + 2..] {
                    command.push(' ');
                    // File parameter names remain tokens; all values are data.
                    if argument.starts_with('-') && argument[1..].chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && argument.len() > 1 {
                        command.push_str(argument);
                    } else {
                        command.push_str(&quote(argument));
                    }
                }
                command.push_str("; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }");
                options.extend(["-EncodedCommand".into(), encoded(&command)]);
                return Ok(options);
            }
            "-version" | "-v" | "-help" | "-?" | "--help" => return Ok(args.to_vec()),
            "-executionpolicy" | "-ep" | "-inputformat" | "-outputformat" | "-windowstyle" | "-configurationname" | "-workingdirectory" => {
                options.push(args[index].clone());
                index += 1;
                options.push(args.get(index).ok_or("PowerShell host option is missing its value")?.clone());
            }
            "-noprofile" | "-nop" | "-nologo" | "-noninteractive" | "-noni" | "-noexit" | "-sta" | "-mta" => options.push(args[index].clone()),
            _ => return Err("Unsupported UTF-8 PowerShell invocation; use -NoProfile -Command with the script text".into()),
        }
        index += 1;
    }
    if !options
        .iter()
        .any(|value| value.eq_ignore_ascii_case("-NoExit"))
    {
        options.push("-NoExit".into());
    }
    options.extend(["-EncodedCommand".into(), encoded(PRELUDE)]);
    Ok(options)
}

/// Called before Clap, only by the executable aliases in the Agent's PATH.
pub fn maybe_run_utf8_shell() -> Option<Result<i32, String>> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().ok()?;
        let name = exe.file_name()?.to_str()?.to_ascii_lowercase();
        let key = match name.as_str() {
            "powershell.exe" => "XMATRIX_UTF8_POWERSHELL_REAL",
            "pwsh.exe" => "XMATRIX_UTF8_PWSH_REAL",
            _ => return None,
        };
        return Some((|| {
            let real = std::env::var_os(key).ok_or("UTF-8 shell target is missing")?;
            let real = std::path::PathBuf::from(real);
            if !real.is_absolute()
                || std::fs::canonicalize(&real).ok() == std::fs::canonicalize(&exe).ok()
            {
                return Err("UTF-8 shell target is invalid".into());
            }
            let args = std::env::args().skip(1).collect::<Vec<_>>();
            let args = shell_args(&args)?;
            let mut command = std::process::Command::new(real);
            command.args(args);
            {
                use std::io::IsTerminal as _;
                use std::os::windows::process::CommandExt as _;
                if !std::io::stdin().is_terminal() {
                    command.creation_flags(0x0800_0000);
                }
            }
            let status = command
                .status()
                .map_err(|_| "Failed to start UTF-8 PowerShell")?;
            Ok(status.code().unwrap_or(1))
        })());
    }
    #[cfg(not(windows))]
    None
}

#[cfg(windows)]
pub(crate) fn child_env(
    path: Option<&std::ffi::OsStr>,
) -> Result<Vec<(std::ffi::OsString, std::ffi::OsString)>, String> {
    // Unit-test providers execute the test runner, which has no alias entrypoint.
    // Binary integration tests exercise the real alias entrypoint.
    #[cfg(test)]
    if std::env::var_os("XMATRIX_UTF8_TEST_CLI_EXE").is_none() {
        return Ok(Vec::new());
    }
    use std::path::PathBuf;
    let exe = std::env::current_exe().map_err(|_| "Cannot resolve UTF-8 shell executable")?;
    let bytes = std::fs::read(&exe).map_err(|_| "Cannot read UTF-8 shell executable")?;
    let root = xmatrix_cli_core::config::config_dir().join("utf8-shells");
    let directory = root.clone();
    std::fs::create_dir_all(&directory).map_err(|_| "Cannot prepare UTF-8 shell directory")?;
    let original = path
        .map(std::ffi::OsStr::to_os_string)
        .or_else(|| std::env::var_os("PATH"))
        .unwrap_or_default();
    let original_paths = std::env::split_paths(&original)
        .filter(|p| !p.starts_with(&root))
        .collect::<Vec<_>>();
    let search_path =
        std::env::join_paths(&original_paths).map_err(|_| "Cannot resolve original shell PATH")?;
    let cwd = std::env::current_dir().map_err(|_| "Cannot resolve shell working directory")?;
    let mut env = Vec::new();
    for (name, key) in [
        ("pwsh.exe", "XMATRIX_UTF8_PWSH_REAL"),
        ("powershell.exe", "XMATRIX_UTF8_POWERSHELL_REAL"),
    ] {
        let inherited = std::env::var_os(key)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute() && p.is_file() && !p.starts_with(&root));
        let real = inherited.or_else(|| which::which_in(name, Some(&search_path), &cwd).ok());
        let Some(real) = real else {
            let alias = directory.join(name);
            if alias.exists() && std::fs::remove_file(alias).is_err() {
                return Err(
                    "Cannot retire unavailable UTF-8 shell; retry after active commands finish"
                        .into(),
                );
            }
            continue;
        };
        let alias = directory.join(name);
        if std::fs::read(&alias)
            .map(|old| old != bytes)
            .unwrap_or(true)
        {
            let temporary = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
            if std::fs::hard_link(&exe, &temporary).is_err() {
                std::fs::write(&temporary, &bytes)
                    .map_err(|_| "Cannot write UTF-8 shell executable")?;
            }
            if std::fs::rename(&temporary, &alias).is_err() {
                let _ = std::fs::remove_file(&temporary);
                return Err("Cannot replace UTF-8 shell executable; retry after active shell commands finish".into());
            }
        }
        env.push((key.into(), real.into_os_string()));
    }
    if env.is_empty() {
        return Err("Windows Agent requires PowerShell on PATH for UTF-8 tools".into());
    }
    let paths = std::iter::once(directory.clone()).chain(original_paths);
    env.push((
        "PATH".into(),
        std::env::join_paths(paths).map_err(|_| "Cannot configure UTF-8 shell PATH")?,
    ));
    let preferred = if directory.join("pwsh.exe").exists() {
        "pwsh.exe"
    } else {
        "powershell.exe"
    };
    env.push((
        "XMATRIX_UTF8_SHELL".into(),
        directory.join(preferred).into_os_string(),
    ));
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn decode(args: &[String]) -> String {
        let bytes = STANDARD.decode(args.last().unwrap()).unwrap();
        String::from_utf16(
            &bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>(),
        )
        .unwrap()
    }
    #[test]
    fn unicode_commands_get_encoding_before_execution_without_shell_quoting_loss() {
        let source = "'中文 😀'; $x = 'a''b'; exit 7";
        let args = shell_args(&["-NoProfile".into(), "-Command".into(), source.into()]).unwrap();
        assert_eq!(args[0], "-NoProfile");
        assert_eq!(decode(&args), format!("{PRELUDE}. {{\n{source}\n}}"));
        assert_eq!(
            decode(&shell_args(&["-EncodedCommand".into(), encoded(source)]).unwrap()),
            format!("{PRELUDE}. {{\n{source}\n}}")
        );
        assert!(shell_args(&["-EncodedCommand".into(), "invalid!".into()]).is_err());
        assert!(shell_args(&["-Command".into(), "-".into()]).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn windows_powershell_native_arguments_and_pipe_are_utf8() {
        let javascript = "const fs = require('fs'); process.stdout.write(JSON.stringify({arg: process.argv[1], stdin: fs.readFileSync(0, 'utf8')}));";
        let node = which::which("node").unwrap();
        let script = format!(
            "[Console]::OutputEncoding.CodePage; $OutputEncoding.CodePage; '中文摘要😀' | & {} -e {} '中文标题😀'; exit 7",
            quote(&node.to_string_lossy()),
            quote(javascript)
        );
        let args = shell_args(&["-NoProfile".into(), "-Command".into(), script]).unwrap();
        let output = std::process::Command::new("powershell.exe")
            .args(args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(7));
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(text.contains("65001"), "{text}");
        assert!(text.contains("中文摘要😀"), "{text}");
        assert!(text.contains("中文标题😀"), "{text}");
    }
}
