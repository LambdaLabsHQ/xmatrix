#![deny(warnings)]

use std::path::{Path, PathBuf};
use std::process::Stdio;

use colored::Colorize;
use serde::Deserialize;
use xmatrix_cli_core::error::{self, CliError};
use xmatrix_cli_core::http;

mod cli_install;
mod daemon_service;
pub use cli_install::{
    CLI_BINARY_NAME, InstalledCliSeed, default_install_dir, install_cli_from_seed,
};
pub use daemon_service::{
    DaemonServiceInstall, LAUNCHD_LABEL, SYSTEMD_UNIT, WINDOWS_DAEMON_LEGACY_TASK_NAME,
    WINDOWS_DAEMON_TASK_NAME, daemon_path_unix, install_daemon_service, launchd_plist,
    launchd_plist_path, systemd_unit, systemd_unit_path, windows_daemon_scheduled_task_script,
};

pub const DEFAULT_CLI_RELEASE_API_URL: &str = "https://xmatrix.sh/api/cli/releases/latest";

const WINDOWS_DAEMON_LAUNCHER: &str = r#"Option Explicit

Function QuoteArgument(value)
  QuoteArgument = """" & Replace(CStr(value), """", """""") & """"
End Function

Function IsSafeGenerationName(value)
  Dim expression
  If Len(CStr(value)) < 1 Or Len(CStr(value)) > 128 Then
    IsSafeGenerationName = False
    Exit Function
  End If
  Set expression = New RegExp
  expression.Pattern = "^[A-Za-z0-9][A-Za-z0-9._-]*$"
  expression.Global = False
  IsSafeGenerationName = expression.Test(CStr(value))
End Function

Dim shell, fileSystem, launcherDir, pointerPath, pointerFile, pendingPath, pendingFile
Dim generationName, pendingText, pendingLines, candidateName, previousName, pendingAge
Dim executablePath, command, index, exitCode
If WScript.Arguments.Count = 0 Then
  WScript.Quit 2
End If

Set fileSystem = CreateObject("Scripting.FileSystemObject")
launcherDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)
pointerPath = fileSystem.BuildPath(launcherDir, "active-generation")
executablePath = WScript.Arguments(0)

If fileSystem.FileExists(pointerPath) Then
  If fileSystem.GetFile(pointerPath).Size > 128 Then
    WScript.Quit 3
  End If
  Set pointerFile = fileSystem.OpenTextFile(pointerPath, 1, False)
  generationName = Trim(pointerFile.ReadAll)
  pointerFile.Close
  If Not IsSafeGenerationName(generationName) Then
    WScript.Quit 3
  End If
  executablePath = fileSystem.BuildPath(fileSystem.BuildPath(fileSystem.BuildPath(launcherDir, "generations"), generationName), "xmatrix.exe")
  If Not fileSystem.FileExists(executablePath) Then
    WScript.Quit 4
  End If
End If

pendingPath = fileSystem.BuildPath(launcherDir, "pending-generation")
If fileSystem.FileExists(pendingPath) Then
  If fileSystem.GetFile(pendingPath).Size > 257 Then
    WScript.Quit 5
  End If
  Set pendingFile = fileSystem.OpenTextFile(pendingPath, 1, False)
  pendingText = Replace(pendingFile.ReadAll, vbCr, "")
  pendingFile.Close
  pendingLines = Split(pendingText, vbLf)
  If UBound(pendingLines) <> 1 Then
    WScript.Quit 5
  End If
  candidateName = Trim(pendingLines(0))
  previousName = Trim(pendingLines(1))
  If Not IsSafeGenerationName(candidateName) Then
    WScript.Quit 6
  End If
  If previousName <> "-" And Not IsSafeGenerationName(previousName) Then
    WScript.Quit 7
  End If
  If generationName = candidateName Then
    pendingAge = DateDiff("s", fileSystem.GetFile(pendingPath).DateLastModified, Now)
    If pendingAge > 300 Or pendingAge < -300 Then
      If previousName = "-" Then
        executablePath = WScript.Arguments(0)
      Else
        executablePath = fileSystem.BuildPath(fileSystem.BuildPath(fileSystem.BuildPath(launcherDir, "generations"), previousName), "xmatrix.exe")
        If Not fileSystem.FileExists(executablePath) Then
          WScript.Quit 8
        End If
      End If
    End If
  End If
End If

command = QuoteArgument(executablePath)
For index = 1 To WScript.Arguments.Count - 1
  command = command & " " & QuoteArgument(WScript.Arguments(index))
Next

Set shell = CreateObject("WScript.Shell")
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
"#;

#[derive(Debug, Deserialize)]
pub struct CliReleaseManifest {
    pub tag_name: String,
    pub version: Option<String>,
    #[serde(rename = "releaseVersion")]
    pub release_version: Option<String>,
    pub assets: Vec<CliReleaseAsset>,
    pub provenance: Option<CliReleaseProvenance>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliReleaseProvenance {
    pub workflow: String,
    pub git_sha: String,
    pub run_id: String,
    pub run_attempt: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CliReleaseAsset {
    pub name: String,
    pub browser_download_url: String,
    pub size: Option<u64>,
    pub sha256: Option<String>,
}

pub struct PendingCliUpdate {
    pub current_version: String,
    pub latest_version: String,
    pub asset: CliReleaseAsset,
    pub install_path: PathBuf,
    pub temp_path: PathBuf,
    pub release_envelope_asset: Option<CliReleaseAsset>,
    pub release_envelope_temp_path: Option<PathBuf>,
    pub provenance: Option<CliReleaseProvenance>,
}

pub struct InstalledCliUpdate {
    pub previous_version: String,
    pub latest_version: String,
    pub install_path: PathBuf,
}

#[cfg(windows)]
pub struct WindowsStagedDaemonCandidate {
    pub previous_version: String,
    pub latest_version: String,
    pub artifact: xmatrix_windows_continuity::ArtifactIdentity,
}

#[cfg(windows)]
pub async fn stage_windows_daemon_candidate(
    update: PendingCliUpdate,
) -> error::Result<WindowsStagedDaemonCandidate> {
    use xmatrix_cli_core::hex::sha256_hex;

    let expected_size = update.asset.size.ok_or_else(|| {
        CliError::Launch("Windows release manifest omitted candidate size".into())
    })?;
    let expected_sha256 = update
        .asset
        .sha256
        .clone()
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            CliError::Launch("Windows release manifest omitted candidate SHA-256".into())
        })?;
    let provenance = update.provenance.as_ref().ok_or_else(|| {
        CliError::Launch("Windows release manifest omitted reviewed provenance".into())
    })?;
    let envelope_asset = update.release_envelope_asset.as_ref().ok_or_else(|| {
        CliError::Launch("Windows release manifest omitted the signed release envelope".into())
    })?;
    let envelope_temp_path = update.release_envelope_temp_path.as_ref().ok_or_else(|| {
        CliError::Launch("Windows signed release envelope has no staging path".into())
    })?;
    let envelope_size = envelope_asset.size.ok_or_else(|| {
        CliError::Launch("Windows release envelope omitted its exact size".into())
    })?;
    let envelope_sha256 = envelope_asset
        .sha256
        .clone()
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            CliError::Launch("Windows release envelope omitted its exact SHA-256".into())
        })?;
    if provenance.workflow != "cli-release.yml"
        || provenance.git_sha.len() != 40
        || !provenance
            .git_sha
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || provenance
            .run_id
            .parse::<u64>()
            .ok()
            .filter(|value| *value > 0)
            .is_none()
    {
        return Err(CliError::Launch(
            "Windows release provenance is invalid".into(),
        ));
    }
    download_release_asset(&update.asset.browser_download_url, &update.temp_path).await?;
    download_release_asset(&envelope_asset.browser_download_url, envelope_temp_path).await?;
    let bytes = std::fs::read(&update.temp_path)?;
    let actual_sha256 = sha256_hex(&bytes);
    if bytes.len() as u64 != expected_size || actual_sha256 != expected_sha256 {
        let _ = std::fs::remove_file(&update.temp_path);
        return Err(CliError::Launch(
            "Windows staged daemon size or digest does not match release authority".into(),
        ));
    }
    let envelope_bytes = std::fs::read(envelope_temp_path)?;
    let actual_envelope_sha256 = sha256_hex(&envelope_bytes);
    if envelope_bytes.len() as u64 != envelope_size || actual_envelope_sha256 != envelope_sha256 {
        let _ = std::fs::remove_file(&update.temp_path);
        let _ = std::fs::remove_file(envelope_temp_path);
        return Err(CliError::Launch(
            "Windows signed release envelope size or digest is invalid".into(),
        ));
    }
    let publisher_sha256 = xmatrix_windows_continuity::verify_authenticode_publisher(
        &update.temp_path,
    )
    .map_err(|error| {
        CliError::Launch(format!(
            "Windows staged daemon publisher is invalid: {error}"
        ))
    })?;
    let current = std::env::current_exe()?;
    // The downloaded publisher is evidence, not a trust anchor. Keep the same
    // publisher continuity enforced by the Supervisor before probing any code.
    let trusted_publisher_sha256 =
        xmatrix_windows_continuity::verify_authenticode_publisher(&current).map_err(|error| {
            CliError::Launch(format!("Current daemon publisher is invalid: {error}"))
        })?;
    let daemon_root = current
        .ancestors()
        .find(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("xmatrix-daemon"))
        })
        .ok_or_else(|| {
            CliError::Launch("Windows daemon is outside the stable Supervisor root".into())
        })?;
    let generation = format!("{}-{expected_sha256}", update.latest_version);
    if !is_safe_windows_daemon_generation_name(&generation) {
        return Err(CliError::Launch(
            "Windows candidate generation is invalid".into(),
        ));
    }
    let generation_dir = daemon_root.join("generations").join(&generation);
    std::fs::create_dir_all(&generation_dir)?;
    let executable_path = generation_dir.join("xmatrix.exe");
    let release_envelope_path = generation_dir.join("release-envelope.exe");
    if executable_path.exists() {
        if xmatrix_windows_continuity::sha256_file(&executable_path)
            .map_err(|error| CliError::Launch(error.to_string()))?
            != expected_sha256
        {
            return Err(CliError::Launch(
                "Immutable Windows candidate generation already has different bytes".into(),
            ));
        }
    } else {
        std::fs::rename(&update.temp_path, &executable_path)?;
    }
    if release_envelope_path.exists() {
        if xmatrix_windows_continuity::sha256_file(&release_envelope_path)
            .map_err(|error| CliError::Launch(error.to_string()))?
            != envelope_sha256
        {
            return Err(CliError::Launch(
                "Immutable Windows release envelope already has different bytes".into(),
            ));
        }
    } else {
        std::fs::rename(envelope_temp_path, &release_envelope_path)?;
    }
    let release_sequence =
        xmatrix_windows_continuity::release_sequence_from_version(&update.latest_version)
            .map_err(|error| CliError::Launch(error.to_string()))?;
    let artifact = xmatrix_windows_continuity::ArtifactIdentity {
        generation,
        sha256: expected_sha256,
        executable_path,
        release_envelope_path,
        release_envelope_sha256: envelope_sha256,
        publisher_sha256: publisher_sha256.clone(),
        version: update.latest_version.clone(),
        target: "x86_64-pc-windows-msvc".into(),
        release_sequence,
        protocol_min: 1,
        protocol_max: 1,
    };
    xmatrix_windows_continuity::verify_signed_artifact(
        &artifact,
        xmatrix_windows_continuity::current_unix_time()
            .map_err(|error| CliError::Launch(error.to_string()))?,
        0,
        Some(&trusted_publisher_sha256),
        false,
    )
    .map_err(|error| CliError::Launch(error.to_string()))?;
    validate_downloaded_binary(&artifact.executable_path)?;
    Ok(WindowsStagedDaemonCandidate {
        previous_version: update.current_version,
        latest_version: update.latest_version.clone(),
        artifact,
    })
}

pub enum CliUpdateCheck {
    UpToDate {
        current_version: String,
        latest_version: String,
    },
    Pending(PendingCliUpdate),
}

#[derive(Clone, Copy)]
pub enum UpdateHintTarget {
    Cli,
    Daemon,
}

pub async fn warn_if_cli_update_available(release_api_url: &str, target: UpdateHintTarget) {
    let Ok(CliUpdateCheck::Pending(update)) = check_cli_update(release_api_url, false).await else {
        return;
    };
    print_update_hint(
        target,
        update.current_version.as_str(),
        update.latest_version.as_str(),
    );
}

pub fn print_update_hint(target: UpdateHintTarget, current_version: &str, latest_version: &str) {
    let lines = update_hint_lines(target, current_version, latest_version);
    if let Some(first) = lines.first() {
        eprintln!("{} {first}", "⚠".yellow().bold());
    }
    for line in lines.iter().skip(1) {
        eprintln!("  {line}");
    }
}

pub fn update_hint_lines(
    target: UpdateHintTarget,
    current_version: &str,
    latest_version: &str,
) -> Vec<String> {
    match target {
        UpdateHintTarget::Cli => vec![
            format!("xMatrix CLI update available: {current_version} -> {latest_version}"),
            "Update CLI: xmatrix update".to_string(),
        ],
        UpdateHintTarget::Daemon => vec![
            format!("xMatrix daemon update available: {current_version} -> {latest_version}"),
            "Update daemon: xmatrix update".to_string(),
            "Restart daemon: xmatrix daemon".to_string(),
        ],
    }
}

pub async fn cmd_update(release_api_url: &str, force: bool, hub_url: &str) -> error::Result<()> {
    #[cfg(windows)]
    {
        let current_exe = std::env::current_exe()
            .map_err(|e| CliError::Launch(format!("Could not locate current executable: {e}")))?;
        let current_exe = normalize_executable_path(current_exe)?;
        let host_cli_path = windows_host_cli_path(&current_exe);
        if let Some(path) = reconcile_windows_daemon_launcher_if_installed(&host_cli_path)? {
            println!("{} Reconciled Windows daemon launcher", "✓".green().bold());
            println!("  {}", path.display().to_string().dimmed());
        }
    }

    println!("{} Checking latest xMatrix CLI release", "○".cyan().bold());

    let update = match check_cli_update(release_api_url, force).await? {
        CliUpdateCheck::Pending(update) => update,
        CliUpdateCheck::UpToDate {
            current_version,
            latest_version,
        } => {
            if latest_version == current_version {
                println!(
                    "{} xMatrix CLI is already up to date ({})",
                    "✓".green().bold(),
                    current_version
                );
            } else {
                println!(
                    "{} xMatrix CLI is newer than the latest release ({} > {})",
                    "✓".green().bold(),
                    current_version,
                    latest_version
                );
            }
            return Ok(());
        }
    };

    println!(
        "{} Downloading {} ({})",
        "○".cyan().bold(),
        update.asset.name,
        update.latest_version
    );
    let installed = install_cli_update(update, hub_url).await?;

    println!(
        "{} Staged xMatrix CLI {} -> {}; the handoff receipt is authoritative",
        "✓".green().bold(),
        installed.previous_version,
        installed.latest_version
    );
    println!(
        "  {}",
        installed.install_path.display().to_string().dimmed()
    );

    Ok(())
}

pub async fn check_cli_update(release_api_url: &str, force: bool) -> error::Result<CliUpdateCheck> {
    let current_version = xmatrix_cli_core::version::current().to_string();
    let asset_name = current_platform_asset_name()?;

    let manifest: CliReleaseManifest =
        http::request_json(release_api_url, "GET", None, None).await?;
    let latest_version = latest_release_manifest_version(&manifest);

    if !force && !release_version_is_newer(&latest_version, &current_version) {
        return Ok(CliUpdateCheck::UpToDate {
            current_version,
            latest_version,
        });
    }

    let asset = manifest
        .assets
        .iter()
        .find(|asset| asset.name == asset_name)
        .ok_or_else(|| {
            CliError::Launch(format!(
                "No release asset named '{asset_name}' found in {}",
                manifest.tag_name
            ))
        })?;

    let current_exe = std::env::current_exe()
        .map_err(|e| CliError::Launch(format!("Could not locate current executable: {e}")))?;
    let current_exe = normalize_executable_path(current_exe)?;
    #[cfg(windows)]
    let install_path = windows_host_cli_path(&current_exe);
    #[cfg(not(windows))]
    let install_path = current_exe;
    let temp_path = update_temp_path(&install_path, &latest_version);
    #[cfg(windows)]
    let release_envelope_asset = manifest
        .assets
        .iter()
        .find(|candidate| candidate.name == format!("{asset_name}.release-envelope.exe"))
        .cloned();
    #[cfg(not(windows))]
    let release_envelope_asset = None;
    let release_envelope_temp_path = release_envelope_asset
        .as_ref()
        .map(|_| temp_path.with_extension("release-envelope.exe.download"));

    Ok(CliUpdateCheck::Pending(PendingCliUpdate {
        current_version,
        latest_version,
        asset: asset.clone(),
        install_path,
        temp_path,
        release_envelope_asset,
        release_envelope_temp_path,
        provenance: manifest.provenance.clone(),
    }))
}

pub fn latest_release_manifest_version(manifest: &CliReleaseManifest) -> String {
    manifest
        .version
        .as_deref()
        .or(manifest.release_version.as_deref())
        .or_else(|| manifest.tag_name.strip_prefix("cli-v"))
        .or_else(|| manifest.tag_name.strip_prefix('v'))
        .unwrap_or(&manifest.tag_name)
        .to_string()
}

pub async fn install_cli_update(
    update: PendingCliUpdate,
    hub_url: &str,
) -> error::Result<InstalledCliUpdate> {
    download_verified_cli_asset(&update.asset, &update.temp_path).await?;
    make_executable(&update.temp_path)?;
    validate_downloaded_binary(&update.temp_path)?;

    schedule_downloaded_host_update(
        &update.temp_path,
        &update.install_path,
        &update.latest_version,
        hub_url,
    )?;

    Ok(InstalledCliUpdate {
        previous_version: update.current_version,
        latest_version: update.latest_version,
        install_path: update.install_path,
    })
}

pub async fn install_cli_update_for_daemon_restart(
    update: PendingCliUpdate,
    hub_url: &str,
    token_override: Option<&str>,
) -> error::Result<InstalledCliUpdate> {
    download_verified_cli_asset(&update.asset, &update.temp_path).await?;
    make_executable(&update.temp_path)?;
    validate_downloaded_binary(&update.temp_path)?;

    #[cfg(windows)]
    {
        // The updater writes a new immutable daemon generation and atomically switches the
        // stable launcher pointer. The Scheduled Task action remains an immutable OS anchor.
        let latest_version = update.latest_version.clone();
        let installed = InstalledCliUpdate {
            previous_version: update.current_version,
            latest_version: update.latest_version,
            install_path: update.install_path.clone(),
        };
        schedule_windows_daemon_restart_after_update(
            &update.temp_path,
            &installed.install_path,
            &latest_version,
            hub_url,
            token_override,
        )?;
        return Ok(installed);
    }

    #[cfg(not(windows))]
    {
        let installed = InstalledCliUpdate {
            previous_version: update.current_version,
            latest_version: update.latest_version,
            install_path: update.install_path,
        };
        schedule_downloaded_host_update(
            &update.temp_path,
            &installed.install_path,
            &installed.latest_version,
            hub_url,
        )?;
        let _ = token_override;
        Ok(installed)
    }
}

pub fn release_version_is_newer(latest_version: &str, current_version: &str) -> bool {
    match release_version_cmp(latest_version, current_version) {
        Some(std::cmp::Ordering::Greater) => true,
        Some(_) => false,
        None => latest_version != current_version,
    }
}

pub fn release_version_cmp(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    let left_parts = parse_release_version(left)?;
    let right_parts = parse_release_version(right)?;
    let len = left_parts.len().max(right_parts.len());

    for index in 0..len {
        let left_part = left_parts.get(index).copied().unwrap_or(0);
        let right_part = right_parts.get(index).copied().unwrap_or(0);
        match left_part.cmp(&right_part) {
            std::cmp::Ordering::Equal => {}
            ordering => return Some(ordering),
        }
    }

    Some(std::cmp::Ordering::Equal)
}

fn parse_release_version(version: &str) -> Option<Vec<u64>> {
    let core = version
        .split_once('-')
        .map(|(core, _)| core)
        .unwrap_or(version)
        .split_once('+')
        .map(|(core, _)| core)
        .unwrap_or(version);
    let parts = core
        .split('.')
        .map(|part| part.parse::<u64>().ok())
        .collect::<Option<Vec<_>>>()?;

    if parts.is_empty() { None } else { Some(parts) }
}

fn current_platform_asset_name() -> error::Result<String> {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        return Err(CliError::Launch("Unsupported operating system".into()));
    };

    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        return Err(CliError::Launch("Unsupported CPU architecture".into()));
    };

    let suffix = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    Ok(format!("xmatrix-{os}-{arch}{suffix}"))
}

fn normalize_executable_path(path: PathBuf) -> error::Result<PathBuf> {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return Err(CliError::Launch(
            "Current executable path is invalid".into(),
        ));
    };

    if file_name.ends_with(".new") {
        return Err(CliError::Launch(
            "Refusing to update from a temporary update binary".into(),
        ));
    }

    Ok(path)
}

fn update_temp_path(install_path: &Path, version: &str) -> PathBuf {
    let mut filename = install_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("xmatrix")
        .to_string();
    filename.push_str(&format!(".{version}.{}.new", std::process::id()));
    std::env::temp_dir().join(filename)
}

fn windows_slot_root_dir(install_path: &Path, slot_root_name: &str) -> PathBuf {
    let parent = install_path.parent().unwrap_or_else(|| Path::new("."));

    let mut root = None;
    for ancestor in parent.ancestors() {
        if ancestor
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(slot_root_name))
        {
            root = Some(ancestor.to_path_buf());
        }
    }

    if let Some(root) = root {
        return root;
    }

    parent.join(slot_root_name)
}

fn windows_daemon_root_dir(install_path: &Path) -> PathBuf {
    windows_slot_root_dir(install_path, "xmatrix-daemon")
}

fn is_safe_windows_daemon_generation_name(value: &str) -> bool {
    xmatrix_windows_continuity::is_safe_generation_name(value)
}

pub fn windows_daemon_generation_path(
    install_path: &Path,
    version: &str,
    generation: &str,
) -> PathBuf {
    let safe_component = |value: &str| {
        let value = value
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                    character
                } else {
                    '-'
                }
            })
            .take(48)
            .collect::<String>();
        let value = value.trim_matches(|character: char| !character.is_ascii_alphanumeric());
        if value.is_empty() {
            "unknown".to_string()
        } else {
            value.to_string()
        }
    };
    windows_daemon_root_dir(install_path)
        .join("generations")
        .join(format!(
            "{}-{}",
            safe_component(version),
            safe_component(generation)
        ))
        .join("xmatrix.exe")
}

pub fn reconcile_windows_daemon_generations(current_exe: &Path) -> error::Result<usize> {
    let daemon_root = windows_daemon_root_dir(current_exe);
    let generations_root = daemon_root.join("generations");
    let task_anchor_path = daemon_root.join("task-anchor-generation");
    let task_anchor_dir = std::fs::metadata(&task_anchor_path)
        .ok()
        .filter(|metadata| metadata.len() <= 128)
        .and_then(|_| std::fs::read_to_string(&task_anchor_path).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| is_safe_windows_daemon_generation_name(value))
        .map(|value| generations_root.join(value));
    let mut generations = match std::fs::read_dir(&generations_root) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let metadata = entry.metadata().ok()?;
                if !metadata.is_dir() {
                    return None;
                }
                Some((entry.path(), metadata.modified().ok()))
            })
            .collect::<Vec<_>>(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(err) => return Err(CliError::Io(err)),
    };
    generations.sort_by_key(|generation| std::cmp::Reverse(generation.1));

    let current_dir = current_exe.parent();
    let previous_dir = generations
        .iter()
        .map(|(path, _)| path)
        .find(|path| current_dir.is_none_or(|current| !paths_equal_relaxed(path, current)))
        .cloned();
    let mut removed = 0;
    for (path, _) in generations {
        if current_dir.is_some_and(|current| paths_equal_relaxed(&path, current))
            || previous_dir
                .as_ref()
                .is_some_and(|previous| paths_equal_relaxed(&path, previous))
            || task_anchor_dir
                .as_ref()
                .is_some_and(|anchor| paths_equal_relaxed(&path, anchor))
        {
            continue;
        }
        if std::fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }

    Ok(removed)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn windows_host_cli_path(install_path: &Path) -> PathBuf {
    let default_host_cli = dirs::home_dir()
        .map(|home| home.join(".local").join("bin").join("xmatrix.exe"))
        .filter(|path| path.is_file());
    windows_host_cli_path_with_default(install_path, default_host_cli.as_deref())
}

fn windows_host_cli_path_with_default(
    install_path: &Path,
    default_host_cli: Option<&Path>,
) -> PathBuf {
    let parent = install_path.parent().unwrap_or_else(|| Path::new("."));
    for ancestor in parent.ancestors() {
        let is_managed_slot_root = ancestor
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.eq_ignore_ascii_case("xmatrix-daemon")
                    || name.eq_ignore_ascii_case("xmatrix-cli")
            });
        if is_managed_slot_root {
            return ancestor.parent().unwrap_or(parent).join("xmatrix.exe");
        }
    }
    // A signed bootstrap binary lives under xMatrix/bootstrap-*. If the
    // official default installation already exists, update that stable
    // user-facing CLI rather than replacing the one-shot bootstrap copy.
    // Custom and portable installations retain the current-executable fallback.
    let bootstrap_parent = install_path.parent();
    let is_xmatrix_bootstrap = bootstrap_parent
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.to_ascii_lowercase().starts_with("bootstrap-"))
        && bootstrap_parent
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("xmatrix"));
    if is_xmatrix_bootstrap && let Some(default_host_cli) = default_host_cli {
        return default_host_cli.to_path_buf();
    }
    install_path.to_path_buf()
}

pub fn windows_daemon_launcher_path(install_path: &Path) -> PathBuf {
    windows_daemon_root_dir(install_path).join("launch-hidden.vbs")
}

pub fn reconcile_windows_daemon_launcher_if_installed(
    install_path: &Path,
) -> error::Result<Option<PathBuf>> {
    let daemon_root = windows_daemon_root_dir(install_path);
    if !daemon_root.is_dir() {
        return Ok(None);
    }

    let launcher_path = windows_daemon_launcher_path(install_path);
    if std::fs::read(&launcher_path)
        .ok()
        .is_some_and(|bytes| windows_daemon_launcher_matches(&bytes))
    {
        return Ok(None);
    }

    let temporary_path = xmatrix_cli_core::config::unique_temporary_path(&launcher_path);
    if let Err(err) =
        std::fs::write(&temporary_path, WINDOWS_DAEMON_LAUNCHER.as_bytes()).and_then(|()| {
            xmatrix_cli_core::config::replace_file_atomically(&temporary_path, &launcher_path)
        })
    {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(CliError::Io(std::io::Error::new(
            err.kind(),
            format!(
                "Failed to reconcile Windows daemon launcher {}: {err}",
                launcher_path.display()
            ),
        )));
    }

    Ok(Some(launcher_path))
}

fn windows_daemon_launcher_matches(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes).is_ok_and(|text| {
        text.replace("\r\n", "\n").trim_end_matches('\n')
            == WINDOWS_DAEMON_LAUNCHER.trim_end_matches('\n')
    })
}

pub fn windows_daemon_ping_path(install_path: &Path) -> PathBuf {
    windows_daemon_root_dir(install_path)
        .join("ping")
        .join("xmatrix.exe")
}

pub fn windows_daemon_pong_path(install_path: &Path) -> PathBuf {
    windows_daemon_root_dir(install_path)
        .join("pong")
        .join("xmatrix.exe")
}

pub fn windows_next_daemon_slot_path(install_path: &Path) -> PathBuf {
    let ping = windows_daemon_ping_path(install_path);
    let pong = windows_daemon_pong_path(install_path);

    if paths_equal_relaxed(install_path, &ping) {
        pong
    } else {
        ping
    }
}

fn windows_cli_root_dir(install_path: &Path) -> PathBuf {
    windows_slot_root_dir(install_path, "xmatrix-cli")
}

pub fn windows_cli_ping_path(install_path: &Path) -> PathBuf {
    windows_cli_root_dir(install_path)
        .join("ping")
        .join("xmatrix.exe")
}

pub fn windows_cli_pong_path(install_path: &Path) -> PathBuf {
    windows_cli_root_dir(install_path)
        .join("pong")
        .join("xmatrix.exe")
}

pub fn windows_next_cli_slot_path(install_path: &Path) -> PathBuf {
    let ping = windows_cli_ping_path(install_path);
    let pong = windows_cli_pong_path(install_path);

    if paths_equal_relaxed(install_path, &ping) {
        pong
    } else {
        ping
    }
}

fn paths_equal_relaxed(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .replace('\\', "/")
        .eq_ignore_ascii_case(&right.to_string_lossy().replace('\\', "/"))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn windows_daemon_update_log_path() -> PathBuf {
    xmatrix_cli_core::config::config_dir().join("daemon-update.log")
}

#[cfg_attr(not(windows), allow(dead_code))]
const WINDOWS_DAEMON_TASK_PATH_RESOLUTION_PS: &str = "\
             $taskAction = @($task.Actions | Select-Object -First 1)\n\
             $daemonPath = $taskAction.Execute\n\
             if ($taskAction -and $taskAction.WorkingDirectory -and ([System.IO.Path]::GetFileName($daemonPath) -ieq 'wscript.exe')) {\n\
               $daemonPath = Join-Path $taskAction.WorkingDirectory 'xmatrix.exe'\n\
             }\n\
             if (-not $daemonPath) { $daemonPath = $installPath }\n";

#[cfg_attr(not(windows), allow(dead_code))]
fn windows_daemon_launcher_reconciliation_ps() -> String {
    format!(
        "             if ($taskAction -and $taskAction.WorkingDirectory -and ([System.IO.Path]::GetFileName($taskAction.Execute) -ieq 'wscript.exe')) {{\n\
         $daemonRoot = Join-Path (Split-Path -Parent $installPath) 'xmatrix-daemon'\n\
         $launcherPath = Join-Path $daemonRoot 'launch-hidden.vbs'\n\
         $launcherTemporaryPath = $launcherPath + '.tmp-' + [System.Guid]::NewGuid().ToString('N')\n\
         $launcherBackupPath = $launcherPath + '.bak-' + [System.Guid]::NewGuid().ToString('N')\n\
         $launcher = {}\n\
         Set-Content -LiteralPath $launcherTemporaryPath -Value $launcher -Encoding ASCII\n\
         if (Test-Path -LiteralPath $launcherPath) {{\n\
           [System.IO.File]::Replace($launcherTemporaryPath, $launcherPath, $launcherBackupPath, $true)\n\
           Remove-Item -LiteralPath $launcherBackupPath -Force -ErrorAction SilentlyContinue\n\
         }} else {{\n\
           [System.IO.File]::Move($launcherTemporaryPath, $launcherPath)\n\
         }}\n\
       }}\n",
        powershell_single_quoted(WINDOWS_DAEMON_LAUNCHER)
    )
}

#[cfg_attr(not(windows), allow(dead_code))]
const WINDOWS_DAEMON_GENERATION_ACTIVATION_PS: &str = r#"
             $daemonRoot = Join-Path (Split-Path -Parent $installPath) 'xmatrix-daemon'
             $launcherPath = Join-Path $daemonRoot 'launch-hidden.vbs'
             $expectedWscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
             $taskArguments = [string]$taskAction.Arguments
             $launcherArgumentPattern = '^//B\s+//NoLogo\s+"' + [regex]::Escape($launcherPath) + '"\s+"(?<daemon>[^"]+)"\s+"machine"\s+"supervisor"\s+"start-daemon"\s*$'
             if (([System.IO.Path]::GetFullPath($taskAction.Execute) -ine [System.IO.Path]::GetFullPath($expectedWscript)) -or ($taskArguments -notmatch $launcherArgumentPattern)) {
               throw 'refusing pointer activation because the existing task is not the managed xMatrix launcher'
             }
             $daemonRootPrefix = [System.IO.Path]::GetFullPath($daemonRoot).TrimEnd('\') + '\'
             $taskDaemonPathFull = [System.IO.Path]::GetFullPath($Matches['daemon'])
             if (([System.IO.Path]::GetFileName($taskDaemonPathFull) -ine 'xmatrix.exe') -or (-not $taskDaemonPathFull.StartsWith($daemonRootPrefix, [System.StringComparison]::OrdinalIgnoreCase))) {
               throw 'refusing pointer activation for unmanaged task daemon path'
             }
             $workingDirectoryFull = [System.IO.Path]::GetFullPath([string]$taskAction.WorkingDirectory)
             if (-not ($workingDirectoryFull + '\').StartsWith($daemonRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
               throw "refusing pointer activation for unmanaged task working directory $workingDirectoryFull"
             }
             $generationsRoot = Join-Path $daemonRoot 'generations'
             $generationsRootPrefix = [System.IO.Path]::GetFullPath($generationsRoot).TrimEnd('\') + '\'
             if (($workingDirectoryFull + '\').StartsWith($generationsRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
               $anchorGenerationName = [System.IO.Path]::GetFileName($workingDirectoryFull.TrimEnd('\'))
               if ($anchorGenerationName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw 'invalid scheduled-task anchor generation name' }
               Write-AtomicTextFile (Join-Path $daemonRoot 'task-anchor-generation') $anchorGenerationName $null | Out-Null
             }
             $generationPointerPath = Join-Path $daemonRoot 'active-generation'
             $previousGenerationName = '-'
             if ($generationName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw 'candidate daemon generation name is invalid' }
             if (Test-Path -LiteralPath $generationPointerPath) {
               if ((Get-Item -LiteralPath $generationPointerPath).Length -gt 128) { throw 'existing daemon generation pointer is oversized' }
               $previousGenerationName = ([System.IO.File]::ReadAllText($generationPointerPath)).Trim()
               if ($previousGenerationName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw 'existing daemon generation pointer is invalid' }
               $previousDaemonPath = Join-Path (Join-Path $generationsRoot $previousGenerationName) 'xmatrix.exe'
             }
             $pendingGenerationPath = Join-Path $daemonRoot 'pending-generation'
             Write-AtomicTextFile $pendingGenerationPath ($generationName + "`n" + $previousGenerationName) $null | Out-Null
             $pendingGenerationWritten = $true
             $generationPointerBackupPath = $generationPointerPath + '.rollback-' + [System.Guid]::NewGuid().ToString('N')
             $generationPointerHadPrevious = Write-AtomicTextFile $generationPointerPath $generationName $generationPointerBackupPath
             $generationPointerReplaced = $true
             $expectedDaemonPath = $nextDaemonPath
             Write-DaemonUpdateLog "activated daemon generation $generationName through the stable launcher pointer without editing the scheduled task"
"#;

// Reject unsigned metadata gaps and changed bytes before invoking the candidate.
// The manifest remains the existing release authority; this is integrity
// validation, not an independent publisher signature.
fn verify_cli_asset_bytes(asset: &CliReleaseAsset, bytes: &[u8]) -> error::Result<()> {
    let expected = asset
        .sha256
        .as_deref()
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| CliError::Launch("CLI release asset is missing a valid SHA-256".into()))?;
    let size = asset
        .size
        .filter(|size| *size > 0)
        .ok_or_else(|| CliError::Launch("CLI release asset is missing its size".into()))?;
    if bytes.len() as u64 != size
        || !xmatrix_cli_core::hex::sha256_hex(bytes).eq_ignore_ascii_case(expected)
    {
        return Err(CliError::Launch(
            "CLI release asset integrity check failed".into(),
        ));
    }
    Ok(())
}

async fn download_verified_cli_asset(asset: &CliReleaseAsset, path: &Path) -> error::Result<()> {
    download_release_asset(&asset.browser_download_url, path).await?;
    let bytes = tokio::fs::read(path).await?;
    if let Err(error) = verify_cli_asset_bytes(asset, &bytes) {
        let _ = tokio::fs::remove_file(path).await;
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod asset_integrity_tests {
    use super::*;

    #[test]
    fn changed_or_unverifiable_assets_are_rejected_before_execution() {
        let bytes = b"verified release bytes";
        let mut asset = CliReleaseAsset {
            name: "test".into(),
            browser_download_url: "https://example.invalid/test".into(),
            size: Some(bytes.len() as u64),
            sha256: Some(xmatrix_cli_core::hex::sha256_hex(bytes)),
        };
        assert!(verify_cli_asset_bytes(&asset, bytes).is_ok());
        assert!(verify_cli_asset_bytes(&asset, b"replaced release bytes").is_err());
        asset.size = Some(1);
        assert!(verify_cli_asset_bytes(&asset, bytes).is_err());
        asset.size = None;
        assert!(verify_cli_asset_bytes(&asset, bytes).is_err());
        asset.size = Some(bytes.len() as u64);
        asset.sha256 = None;
        assert!(verify_cli_asset_bytes(&asset, bytes).is_err());
        asset.sha256 = Some("invalid".into());
        assert!(verify_cli_asset_bytes(&asset, bytes).is_err());
    }
}

async fn download_release_asset(url: &str, output_path: &Path) -> error::Result<()> {
    let response = reqwest::Client::new().get(url).send().await?;
    let status = response.status();
    if status.is_client_error() || status.is_server_error() {
        return Err(CliError::Http(format!(
            "Release asset download failed with status {status}"
        )));
    }

    let bytes = response.bytes().await?;
    if bytes.is_empty() {
        return Err(CliError::Http("Release asset download was empty".into()));
    }

    tokio::fs::write(output_path, bytes).await?;
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> error::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> error::Result<()> {
    Ok(())
}

fn validate_downloaded_binary(path: &Path) -> error::Result<()> {
    let mut command = std::process::Command::new(path);
    configure_background_command(&mut command);
    let output = command
        .arg("--version")
        .output()
        .map_err(|e| CliError::Launch(format!("Downloaded binary failed to start: {e}")))?;

    if !output.status.success() {
        let _ = std::fs::remove_file(path);
        return Err(CliError::Launch(
            "Downloaded release asset failed validation".into(),
        ));
    }

    Ok(())
}

fn schedule_downloaded_host_update(
    temp_path: &Path,
    install_path: &Path,
    latest_version: &str,
    hub_url: &str,
) -> error::Result<()> {
    #[cfg(windows)]
    {
        let _ = hub_url;
        install_downloaded_update_windows(temp_path, install_path, latest_version)
    }

    #[cfg(not(windows))]
    {
        schedule_unix_update_handoff(temp_path, install_path, latest_version, hub_url)
    }
}

#[cfg(not(windows))]
fn replace_downloaded_binary(temp_path: &Path, install_path: &Path) -> error::Result<()> {
    std::fs::rename(temp_path, install_path).map_err(|err| {
        CliError::Io(std::io::Error::new(
            err.kind(),
            format!(
                "Failed to replace {}. Try running the install script again or use a writable install path: {err}",
                install_path.display()
            ),
        ))
    })
}

#[cfg(not(windows))]
const UNIX_UPDATE_HANDOFF_ENV: &str = "XMATRIX_INTERNAL_UPDATE_HANDOFF";
#[cfg(not(windows))]
const UNIX_UPDATE_INSTALL_PATH_ENV: &str = "XMATRIX_INTERNAL_UPDATE_INSTALL_PATH";
#[cfg(not(windows))]
const UNIX_UPDATE_PARENT_PID_ENV: &str = "XMATRIX_INTERNAL_UPDATE_PARENT_PID";
#[cfg(not(windows))]
const UNIX_UPDATE_VERSION_ENV: &str = "XMATRIX_INTERNAL_UPDATE_VERSION";
#[cfg(not(windows))]
const UNIX_UPDATE_HUB_URL_ENV: &str = "XMATRIX_INTERNAL_UPDATE_HUB_URL";
#[cfg(not(windows))]
const UNIX_UPDATE_OWNERSHIP_PATH_ENV: &str = "XMATRIX_INTERNAL_UPDATE_OWNERSHIP_PATH";
#[cfg(not(windows))]
const UNIX_UPDATE_SENSITIVE_PARENT_ENV: &[&str] = &[
    "XMATRIX_TOKEN",
    "XMATRIX_HEADLESS",
    "XMATRIX_AGENT_SESSION",
    "XMATRIX_AGENT_NAME_OVERRIDE",
    "XMATRIX_AGENT_IDENTITY_ID_OVERRIDE",
    "XMATRIX_AUTO_JOIN_CHANNEL_ID",
    "XMATRIX_RESUME_INSTANCE_ID",
    "XMATRIX_RUN_ID",
    "XMATRIX_EXECUTION_KEY",
    "XMATRIX_DAEMON_AUTH_URL",
    "XMATRIX_DAEMON_AUTH_CAPABILITY",
    "XMATRIX_DAEMON_REQUEST_URL",
    "XMATRIX_DAEMON_REQUEST_CAPABILITY",
    "XMATRIX_ENVIRONMENT",
    "XMATRIX_HUB_URL",
];

#[cfg(not(windows))]
#[derive(Debug, Deserialize)]
struct UnixDaemonReadyState {
    version: String,
    pid: u32,
    #[serde(rename = "executablePath")]
    executable_path: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

#[cfg(not(windows))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UnixDaemonManager {
    Launchd,
    Systemd,
    Unmanaged,
}

#[cfg(not(windows))]
fn schedule_unix_update_handoff(
    temp_path: &Path,
    install_path: &Path,
    latest_version: &str,
    hub_url: &str,
) -> error::Result<()> {
    let ownership_path = xmatrix_cli_core::config::unique_temporary_path(
        &xmatrix_cli_core::config::config_dir().join("update-handoff.owned"),
    );
    let _ = std::fs::remove_file(&ownership_path);

    let mut command = std::process::Command::new(temp_path);
    scrub_unix_update_child_environment(&mut command);
    command
        .env(UNIX_UPDATE_HANDOFF_ENV, "1")
        .env(UNIX_UPDATE_INSTALL_PATH_ENV, install_path)
        .env(UNIX_UPDATE_PARENT_PID_ENV, std::process::id().to_string())
        .env(UNIX_UPDATE_VERSION_ENV, latest_version)
        .env(UNIX_UPDATE_HUB_URL_ENV, hub_url)
        .env(UNIX_UPDATE_OWNERSHIP_PATH_ENV, &ownership_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|err| CliError::Launch(format!("Failed to start Unix update handoff: {err}")))?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if ownership_path.is_file() {
            let _ = std::fs::remove_file(&ownership_path);
            println!(
                "{} Update staged; daemon handoff will continue after this command exits",
                "•".cyan().bold()
            );
            return Ok(());
        }
        if let Some(status) = child.try_wait().map_err(|err| {
            CliError::Launch(format!("Could not inspect Unix update handoff: {err}"))
        })? {
            return Err(CliError::Launch(format!(
                "Unix update handoff exited before taking ownership ({status})"
            )));
        }
        if std::time::Instant::now() >= deadline {
            return Err(CliError::Launch(
                "Unix update handoff did not take ownership within 10 seconds".to_string(),
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

#[cfg(not(windows))]
fn scrub_unix_update_child_environment(command: &mut std::process::Command) {
    for name in UNIX_UPDATE_SENSITIVE_PARENT_ENV {
        command.env_remove(name);
    }
    command
        .env_remove(UNIX_UPDATE_HANDOFF_ENV)
        .env_remove(UNIX_UPDATE_INSTALL_PATH_ENV)
        .env_remove(UNIX_UPDATE_PARENT_PID_ENV)
        .env_remove(UNIX_UPDATE_VERSION_ENV)
        .env_remove(UNIX_UPDATE_HUB_URL_ENV)
        .env_remove(UNIX_UPDATE_OWNERSHIP_PATH_ENV);
}

pub fn maybe_run_update_handoff_from_env() -> Option<error::Result<()>> {
    #[cfg(windows)]
    {
        None
    }

    #[cfg(not(windows))]
    {
        if std::env::var(UNIX_UPDATE_HANDOFF_ENV).ok().as_deref() != Some("1") {
            return None;
        }
        Some(run_unix_update_handoff())
    }
}

#[cfg(not(windows))]
fn run_unix_update_handoff() -> error::Result<()> {
    let current_exe = std::env::current_exe().map_err(|err| {
        CliError::Launch(format!("Could not locate staged update executable: {err}"))
    })?;
    let install_path = required_update_handoff_path(UNIX_UPDATE_INSTALL_PATH_ENV)?;
    let ownership_path = required_update_handoff_path(UNIX_UPDATE_OWNERSHIP_PATH_ENV)?;
    let latest_version = required_update_handoff_value(UNIX_UPDATE_VERSION_ENV)?;
    let hub_url = required_update_handoff_value(UNIX_UPDATE_HUB_URL_ENV)?;
    let parent_pid = required_update_handoff_value(UNIX_UPDATE_PARENT_PID_ENV)?
        .parse::<u32>()
        .map_err(|err| CliError::Launch(format!("Invalid update parent PID: {err}")))?;
    if latest_version != xmatrix_cli_core::version::current() {
        return Err(CliError::Launch(format!(
            "Staged update version mismatch: expected {latest_version}, running {}",
            xmatrix_cli_core::version::current()
        )));
    }
    if install_path.file_name().and_then(|value| value.to_str()) != Some("xmatrix") {
        return Err(CliError::Launch(format!(
            "Refusing Unix update handoff for unexpected install path {}",
            install_path.display()
        )));
    }

    let config_dir = xmatrix_cli_core::config::config_dir();
    std::fs::create_dir_all(&config_dir)?;
    let log_path = config_dir.join("daemon-update.log");
    let receipt_path = config_dir.join("daemon-update-receipt.json");
    let ready_path = config_dir.join("daemon-ready.json");
    let rollback_dir = config_dir.join("updates").join("rollback");
    std::fs::create_dir_all(&rollback_dir)?;
    set_private_dir_permissions(&rollback_dir)?;
    let rollback_path = rollback_dir.join("xmatrix");
    let rollback_temp = xmatrix_cli_core::config::unique_temporary_path(&rollback_path);
    let manager = detect_unix_daemon_manager();
    if manager == UnixDaemonManager::Systemd {
        reconcile_linux_daemon_update_boundary()?;
    } else if manager == UnixDaemonManager::Launchd {
        reconcile_macos_daemon_update_boundary()?;
    }
    let old_ready = read_unix_daemon_ready_state(&ready_path);

    std::fs::copy(&install_path, &rollback_temp).map_err(|err| {
        CliError::Launch(format!(
            "Could not stage rollback binary from {}: {err}",
            install_path.display()
        ))
    })?;
    set_executable_permissions_like(&rollback_temp, &install_path)?;
    xmatrix_cli_core::config::replace_file_atomically(&rollback_temp, &rollback_path)?;
    if let Err(err) = write_unix_update_receipt(
        &receipt_path,
        "staged",
        &latest_version,
        &install_path,
        None,
    )
    .and_then(|()| write_private_marker(&ownership_path))
    {
        let reason = format!("could not confirm Unix update handoff ownership: {err}");
        let _ = write_unix_update_receipt(
            &receipt_path,
            "rolled-back",
            old_ready
                .as_ref()
                .map(|ready| ready.version.as_str())
                .unwrap_or("unknown"),
            &install_path,
            Some(&reason),
        );
        append_unix_update_log(&log_path, &reason);
        return Err(CliError::Launch(reason));
    }
    append_unix_update_log(
        &log_path,
        &format!(
            "staged {latest_version} at {}; manager={manager:?}",
            install_path.display()
        ),
    );

    if let Err(err) = wait_for_process_exit(parent_pid, std::time::Duration::from_secs(300)) {
        let reason = format!("update owner process did not exit: {err}");
        write_unix_update_receipt(
            &receipt_path,
            "rolled-back",
            old_ready
                .as_ref()
                .map(|ready| ready.version.as_str())
                .unwrap_or("unknown"),
            &install_path,
            Some(&reason),
        )?;
        append_unix_update_log(&log_path, &reason);
        return Err(CliError::Launch(reason));
    }
    if let Err(err) = stop_unix_daemon_for_update(manager, old_ready.as_ref()) {
        return rollback_unix_update(
            &rollback_path,
            &install_path,
            manager,
            old_ready.as_ref(),
            &hub_url,
            &receipt_path,
            &log_path,
            format!("daemon stop before replacement failed: {err}"),
        );
    }
    if let Err(err) = replace_downloaded_binary(&current_exe, &install_path) {
        return rollback_unix_update(
            &rollback_path,
            &install_path,
            manager,
            old_ready.as_ref(),
            &hub_url,
            &receipt_path,
            &log_path,
            format!("signed CLI replacement failed after daemon stop: {err}"),
        );
    }
    let handoff_started_at = xmatrix_cli_core::config::unix_now_secs();
    let replacement_already_healthy = wait_for_unix_daemon_health(
        &ready_path,
        &latest_version,
        &install_path,
        handoff_started_at,
        std::time::Duration::from_millis(100),
    );
    let restart_result = if replacement_already_healthy {
        Ok(())
    } else {
        restart_unix_daemon(manager, old_ready.as_ref(), &install_path, &hub_url)
    };
    if let Err(err) = restart_result {
        return rollback_unix_update(
            &rollback_path,
            &install_path,
            manager,
            old_ready.as_ref(),
            &hub_url,
            &receipt_path,
            &log_path,
            format!("daemon restart failed: {err}"),
        );
    }

    if manager != UnixDaemonManager::Unmanaged || old_ready.is_some() {
        let healthy = wait_for_unix_daemon_health(
            &ready_path,
            &latest_version,
            &install_path,
            handoff_started_at,
            std::time::Duration::from_secs(60),
        );
        if !healthy {
            return rollback_unix_update(
                &rollback_path,
                &install_path,
                manager,
                old_ready.as_ref(),
                &hub_url,
                &receipt_path,
                &log_path,
                "new daemon did not become healthy within 60 seconds".to_string(),
            );
        }
    }

    write_unix_update_receipt(
        &receipt_path,
        "committed",
        &latest_version,
        &install_path,
        None,
    )?;
    append_unix_update_log(
        &log_path,
        &format!("committed Unix daemon update {latest_version}"),
    );
    Ok(())
}

#[cfg(not(windows))]
fn required_update_handoff_value(name: &str) -> error::Result<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CliError::Launch(format!("Missing internal update handoff value {name}")))
}

#[cfg(not(windows))]
fn required_update_handoff_path(name: &str) -> error::Result<PathBuf> {
    Ok(PathBuf::from(required_update_handoff_value(name)?))
}

/// Probe a service-manager command without exposing output or inheriting stdin.
pub fn quiet_service_status(program: &str, args: &[&str]) -> bool {
    std::process::Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(not(windows))]
fn detect_unix_daemon_manager() -> UnixDaemonManager {
    #[cfg(target_os = "macos")]
    {
        let uid = unsafe { libc::getuid() };
        if quiet_service_status(
            "launchctl",
            &["print", &format!("gui/{uid}/sh.xmatrix.daemon")],
        ) {
            return UnixDaemonManager::Launchd;
        }
    }
    #[cfg(target_os = "linux")]
    {
        if std::process::Command::new("systemctl")
            .args([
                "--user",
                "show",
                "--property=LoadState",
                "--value",
                "xmatrix-daemon.service",
            ])
            .stdin(Stdio::null())
            .output()
            .is_ok_and(|output| output.status.success() && output.stdout == b"loaded\n")
        {
            return UnixDaemonManager::Systemd;
        }
    }
    UnixDaemonManager::Unmanaged
}

#[cfg(target_os = "linux")]
fn reconcile_linux_daemon_update_boundary() -> error::Result<()> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| CliError::Launch("HOME is unavailable for systemd user service".into()))?;
    let drop_in_dir = home.join(".config/systemd/user/xmatrix-daemon.service.d");
    std::fs::create_dir_all(&drop_in_dir)?;
    let drop_in_path = drop_in_dir.join("10-agent-survival.conf");
    let temporary_path = xmatrix_cli_core::config::unique_temporary_path(&drop_in_path);
    std::fs::write(&temporary_path, b"[Service]\nKillMode=process\n")?;
    xmatrix_cli_core::config::replace_file_atomically(&temporary_path, &drop_in_path)?;
    let status = std::process::Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .status()?;
    if !status.success() {
        return Err(CliError::Launch(format!(
            "systemctl --user daemon-reload failed with {status}"
        )));
    }
    let output = std::process::Command::new("systemctl")
        .args([
            "--user",
            "show",
            "--property=KillMode",
            "--value",
            "xmatrix-daemon.service",
        ])
        .output()?;
    if !output.status.success() || String::from_utf8_lossy(&output.stdout).trim() != "process" {
        return Err(CliError::Launch(
            "systemd did not apply KillMode=process; refusing to restart running Agents".into(),
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn reconcile_macos_daemon_update_boundary() -> error::Result<()> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| CliError::Launch("HOME is unavailable for launchd user service".into()))?;
    let plist_path = home.join("Library/LaunchAgents/sh.xmatrix.daemon.plist");
    if !plist_path.is_file() {
        return Err(CliError::Launch(format!(
            "launchd reports sh.xmatrix.daemon but {} is missing",
            plist_path.display()
        )));
    }
    let status = std::process::Command::new("/usr/bin/plutil")
        .args([
            "-replace",
            "AbandonProcessGroup",
            "-bool",
            "true",
            plist_path.to_string_lossy().as_ref(),
        ])
        .status()?;
    if !status.success() {
        return Err(CliError::Launch(format!(
            "could not enable launchd Agent survival boundary ({status})"
        )));
    }
    Ok(())
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn reconcile_macos_daemon_update_boundary() -> error::Result<()> {
    Ok(())
}

#[cfg(all(not(windows), not(target_os = "linux")))]
fn reconcile_linux_daemon_update_boundary() -> error::Result<()> {
    Ok(())
}

#[cfg(not(windows))]
fn stop_unix_daemon_for_update(
    manager: UnixDaemonManager,
    old_ready: Option<&UnixDaemonReadyState>,
) -> error::Result<()> {
    match manager {
        UnixDaemonManager::Launchd => {
            #[cfg(target_os = "macos")]
            {
                let uid = unsafe { libc::getuid() };
                let service = format!("gui/{uid}/sh.xmatrix.daemon");
                let status = std::process::Command::new("launchctl")
                    .args(["bootout", &service])
                    .status()?;
                if !status.success() {
                    let still_loaded = std::process::Command::new("launchctl")
                        .args(["print", &service])
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .is_ok_and(|print_status| print_status.success());
                    if still_loaded
                        || old_ready
                            .is_some_and(|ready| xmatrix_process_tree::process_alive(ready.pid))
                    {
                        return Err(CliError::Launch(format!(
                            "launchctl daemon bootout failed with {status}"
                        )));
                    }
                }
            }
        }
        UnixDaemonManager::Systemd => {
            #[cfg(target_os = "linux")]
            {
                let status = std::process::Command::new("systemctl")
                    .args(["--user", "stop", "xmatrix-daemon.service"])
                    .status()?;
                if !status.success()
                    && old_ready.is_some_and(|ready| xmatrix_process_tree::process_alive(ready.pid))
                {
                    return Err(CliError::Launch(format!(
                        "systemctl daemon stop failed with {status}"
                    )));
                }
            }
        }
        UnixDaemonManager::Unmanaged => {
            if let Some(ready) =
                old_ready.filter(|ready| xmatrix_process_tree::process_alive(ready.pid))
            {
                signal_process(ready.pid, libc::SIGTERM)?;
            }
        }
    }

    if let Some(ready) = old_ready.filter(|ready| xmatrix_process_tree::process_alive(ready.pid)) {
        wait_for_process_exit(ready.pid, std::time::Duration::from_secs(30))?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn restart_unix_daemon(
    manager: UnixDaemonManager,
    old_ready: Option<&UnixDaemonReadyState>,
    install_path: &Path,
    hub_url: &str,
) -> error::Result<()> {
    match manager {
        UnixDaemonManager::Launchd => {
            #[cfg(target_os = "macos")]
            {
                let uid = unsafe { libc::getuid() };
                let domain = format!("gui/{uid}");
                let service = format!("{domain}/sh.xmatrix.daemon");
                let home = std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| {
                    CliError::Launch("HOME is unavailable for launchd user service".into())
                })?;
                let plist_path = home.join("Library/LaunchAgents/sh.xmatrix.daemon.plist");
                let _ = std::process::Command::new("launchctl")
                    .args(["bootout", &service])
                    .status()?;
                retry_launchctl_bootstrap("launchctl daemon bootstrap", || {
                    std::process::Command::new("launchctl")
                        .args(["bootstrap", &domain, plist_path.to_string_lossy().as_ref()])
                        .status()
                })?;
                let _ = std::process::Command::new("launchctl")
                    .args(["enable", &service])
                    .status();
            }
            Ok(())
        }
        UnixDaemonManager::Systemd => {
            let status = std::process::Command::new("systemctl")
                .args(["--user", "restart", "xmatrix-daemon.service"])
                .status()?;
            if status.success() {
                Ok(())
            } else {
                Err(CliError::Launch(format!(
                    "systemctl daemon restart failed with {status}"
                )))
            }
        }
        UnixDaemonManager::Unmanaged => {
            if let Some(ready) =
                old_ready.filter(|ready| xmatrix_process_tree::process_alive(ready.pid))
            {
                signal_process(ready.pid, libc::SIGTERM)?;
                wait_for_process_exit(ready.pid, std::time::Duration::from_secs(30))?;
            }
            spawn_unmanaged_daemon(install_path, hub_url)
        }
    }
}

#[cfg(not(windows))]
fn spawn_unmanaged_daemon(install_path: &Path, hub_url: &str) -> error::Result<()> {
    let mut command = std::process::Command::new(install_path);
    scrub_unix_update_child_environment(&mut command);
    command
        .arg("daemon")
        .env("XMATRIX_HUB_URL", hub_url)
        .env("XMATRIX_DAEMON_RESTART_WAIT_LOCK", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    command.spawn().map_err(|err| {
        CliError::Launch(format!("Could not start unmanaged updated daemon: {err}"))
    })?;
    Ok(())
}

#[cfg(not(windows))]
fn rollback_unix_update(
    rollback_path: &Path,
    install_path: &Path,
    manager: UnixDaemonManager,
    old_ready: Option<&UnixDaemonReadyState>,
    hub_url: &str,
    receipt_path: &Path,
    log_path: &Path,
    reason: String,
) -> error::Result<()> {
    append_unix_update_log(log_path, &format!("rolling back Unix update: {reason}"));
    let stop_result = if manager == UnixDaemonManager::Unmanaged {
        terminate_unmanaged_daemon_from_lock()
    } else {
        stop_unix_daemon_for_update(manager, None)
    };
    if let Err(stop_error) = stop_result {
        let failure = format!(
            "{reason}; rollback could not stop the replacement daemon before restoring the prior signed executable: {stop_error}"
        );
        write_unix_update_receipt(
            receipt_path,
            "failed",
            old_ready
                .map(|ready| ready.version.as_str())
                .unwrap_or("unknown"),
            install_path,
            Some(&failure),
        )?;
        append_unix_update_log(log_path, &failure);
        return Err(CliError::Launch(failure));
    }
    restore_unix_update_binary(rollback_path, install_path)?;
    restart_unix_daemon(manager, None, install_path, hub_url)?;
    let rollback_version = old_ready
        .map(|ready| ready.version.as_str())
        .unwrap_or("unknown");
    write_unix_update_receipt(
        receipt_path,
        "rolled-back",
        rollback_version,
        install_path,
        Some(&reason),
    )?;
    append_unix_update_log(log_path, "restored previous Unix daemon binary");
    Err(CliError::Launch(reason))
}

#[cfg(not(windows))]
fn restore_unix_update_binary(rollback_path: &Path, install_path: &Path) -> error::Result<()> {
    let restore_path = xmatrix_cli_core::config::unique_temporary_path(install_path);
    std::fs::copy(rollback_path, &restore_path)?;
    set_executable_permissions_like(&restore_path, rollback_path)?;
    xmatrix_cli_core::config::replace_file_atomically(&restore_path, install_path)?;
    Ok(())
}

#[cfg(not(windows))]
fn terminate_unmanaged_daemon_from_lock() -> error::Result<()> {
    let lock_path = xmatrix_cli_core::config::config_dir().join("daemon.lock");
    let pid = std::fs::read_to_string(lock_path).ok().and_then(|raw| {
        raw.lines()
            .find_map(|line| line.strip_prefix("pid="))
            .and_then(|value| value.parse::<u32>().ok())
    });
    let Some(pid) = pid.filter(|pid| xmatrix_process_tree::process_alive(*pid)) else {
        return Ok(());
    };
    signal_process(pid, libc::SIGTERM)?;
    wait_for_process_exit(pid, std::time::Duration::from_secs(30))
}

#[cfg(not(windows))]
fn wait_for_unix_daemon_health(
    ready_path: &Path,
    expected_version: &str,
    expected_executable: &Path,
    started_at: u64,
    timeout: std::time::Duration,
) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if let Some(ready) = read_unix_daemon_ready_state(ready_path) {
            let updated_at = ready.updated_at.parse::<u64>().unwrap_or(0);
            if updated_at >= started_at
                && ready.version == expected_version
                && paths_equal_relaxed(Path::new(&ready.executable_path), expected_executable)
                && xmatrix_process_tree::process_alive(ready.pid)
            {
                return true;
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    false
}

#[cfg(not(windows))]
fn read_unix_daemon_ready_state(path: &Path) -> Option<UnixDaemonReadyState> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

#[cfg(not(windows))]
fn signal_process(pid: u32, signal: libc::c_int) -> error::Result<()> {
    if unsafe { libc::kill(pid as libc::pid_t, signal) } == 0 {
        Ok(())
    } else {
        Err(CliError::Io(std::io::Error::last_os_error()))
    }
}

#[cfg(not(windows))]
fn wait_for_process_exit(pid: u32, timeout: std::time::Duration) -> error::Result<()> {
    let deadline = std::time::Instant::now() + timeout;
    while xmatrix_process_tree::process_alive(pid) {
        if std::time::Instant::now() >= deadline {
            return Err(CliError::Launch(format!(
                "Timed out waiting for process {pid} to exit"
            )));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_executable_permissions_like(path: &Path, source: &Path) -> error::Result<()> {
    let permissions = std::fs::metadata(source)?.permissions();
    std::fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(not(windows))]
fn set_private_dir_permissions(path: &Path) -> error::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(windows))]
fn write_private_marker(path: &Path) -> error::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    Ok(())
}

#[cfg(not(windows))]
fn write_unix_update_receipt(
    path: &Path,
    status: &str,
    version: &str,
    install_path: &Path,
    error: Option<&str>,
) -> error::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt;
    let value = serde_json::json!({
        "status": status,
        "version": version,
        "installPath": install_path,
        "updatedAt": xmatrix_cli_core::config::unix_now_secs().to_string(),
        "error": error,
    });
    let temporary_path = xmatrix_cli_core::config::unique_temporary_path(path);
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary_path)?
        .write_all(&serde_json::to_vec_pretty(&value)?)?;
    xmatrix_cli_core::config::replace_file_atomically(&temporary_path, path)?;
    Ok(())
}

#[cfg(not(windows))]
fn append_unix_update_log(path: &Path, message: &str) {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
    {
        let _ = writeln!(
            file,
            "{} {message}",
            xmatrix_cli_core::config::unix_now_secs()
        );
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
const WINDOWS_ATOMIC_UPDATE_HELPERS_PS: &str = r#"
function Move-ReplacingLockedFile([string]$sourcePath, [string]$destinationPath, [string]$backupPath) {
  if (Test-Path -LiteralPath $backupPath) { Remove-Item -LiteralPath $backupPath -Force }
  [System.IO.File]::Move($destinationPath, $backupPath)
  try {
    [System.IO.File]::Move($sourcePath, $destinationPath)
  } catch {
    [System.IO.File]::Move($backupPath, $destinationPath)
    throw
  }
}
function Install-StagedBinary([string]$sourcePath, [string]$destinationPath, [string]$backupPath) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destinationPath) | Out-Null
  if (Test-Path -LiteralPath $destinationPath) {
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
    try {
      [System.IO.File]::Replace($sourcePath, $destinationPath, $backupPath, $true)
    } catch {
      Move-ReplacingLockedFile $sourcePath $destinationPath $backupPath
    }
    return $true
  }
  [System.IO.File]::Move($sourcePath, $destinationPath)
  return $false
}
function Restore-PreviousBinary([string]$destinationPath, [string]$backupPath, [bool]$hadPrevious) {
  if ($hadPrevious) {
    if (-not (Test-Path -LiteralPath $backupPath)) { throw "rollback binary is missing: $backupPath" }
    if (Test-Path -LiteralPath $destinationPath) {
      $failedPath = $destinationPath + '.failed-' + [System.Guid]::NewGuid().ToString('N')
      try {
        [System.IO.File]::Replace($backupPath, $destinationPath, $failedPath, $true)
        Remove-Item -LiteralPath $failedPath -Force -ErrorAction SilentlyContinue
      } catch {
        Move-ReplacingLockedFile $backupPath $destinationPath $failedPath
        Remove-Item -LiteralPath $failedPath -Force -ErrorAction SilentlyContinue
      }
    } else {
      [System.IO.File]::Move($backupPath, $destinationPath)
    }
  } elseif (Test-Path -LiteralPath $destinationPath) {
    Remove-Item -LiteralPath $destinationPath -Force
  }
}
function Get-DaemonCommandProcesses {
  return @(Get-CimInstance Win32_Process -Filter "Name = 'xmatrix.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '^(?:"[^"]*xmatrix\.exe"|\S*xmatrix\.exe)\s+daemon(?:\s|$)' })
}
function Stop-DaemonCommandProcesses {
  @(Get-DaemonCommandProcesses) | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $stopDeadline = [DateTime]::UtcNow.AddSeconds(10)
  while ([DateTime]::UtcNow -lt $stopDeadline -and @(Get-DaemonCommandProcesses).Count -gt 0) {
    Start-Sleep -Milliseconds 100
  }
  if (@(Get-DaemonCommandProcesses).Count -gt 0) {
    throw 'existing daemon process did not stop before binary replacement'
  }
}
function Test-ManagedLauncherTask($taskAction) {
  if (-not $taskAction) { return $false }
  $daemonRoot = Join-Path (Split-Path -Parent $installPath) 'xmatrix-daemon'
  $launcherPath = Join-Path $daemonRoot 'launch-hidden.vbs'
  $expectedWscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $taskArguments = [string]$taskAction.Arguments
  $launcherArgumentPattern = '^//B\s+//NoLogo\s+"' + [regex]::Escape($launcherPath) + '"\s+"(?<daemon>[^"]+)"\s+"machine"\s+"supervisor"\s+"start-daemon"\s*$'
  try {
    return ([System.IO.Path]::GetFullPath($taskAction.Execute) -ieq [System.IO.Path]::GetFullPath($expectedWscript)) -and ($taskArguments -match $launcherArgumentPattern)
  } catch {
    return $false
  }
}
function Wait-UpdatedDaemonHealthy([string]$expectedPath, [string]$expectedVersion, [datetime]$startedAtUtc, [int]$timeoutSeconds) {
  $readyStatePath = Join-Path (Split-Path -Parent $daemonUpdateLog) 'daemon-ready.json'
  $healthDeadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)
  while ([DateTime]::UtcNow -lt $healthDeadline) {
    $readyFresh = (Test-Path -LiteralPath $readyStatePath) -and ((Get-Item -LiteralPath $readyStatePath).LastWriteTimeUtc -gt $startedAtUtc)
    if ($readyFresh) {
      try {
        $ready = Get-Content -Raw -LiteralPath $readyStatePath | ConvertFrom-Json
        $pathMatches = [System.IO.Path]::GetFullPath($ready.executablePath) -ieq [System.IO.Path]::GetFullPath($expectedPath)
        $versionMatches = $ready.version -eq $expectedVersion
        $pidAlive = $false
        if ($ready.pid) {
          try { $pidAlive = [bool](Get-Process -Id $ready.pid -ErrorAction Stop) } catch { $pidAlive = $false }
        }
        if ($pathMatches -and $versionMatches -and $pidAlive) { return $true }
      } catch {}
    }
    Start-Sleep -Seconds 1
  }
  return $false
}
function Write-AtomicTextFile([string]$destinationPath, [string]$value, [string]$backupPath) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destinationPath) | Out-Null
  $temporaryPath = $destinationPath + '.tmp-' + [System.Guid]::NewGuid().ToString('N')
  [System.IO.File]::WriteAllText(
    $temporaryPath,
    $value,
    (New-Object System.Text.UTF8Encoding($false))
  )
  if (Test-Path -LiteralPath $destinationPath) {
    if (-not $backupPath) { $backupPath = $destinationPath + '.bak-' + [System.Guid]::NewGuid().ToString('N') }
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
    [System.IO.File]::Replace($temporaryPath, $destinationPath, $backupPath, $true)
    if ($backupPath -like '*.bak-*') { Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue }
    return $true
  }
  [System.IO.File]::Move($temporaryPath, $destinationPath)
  return $false
}
function Write-DaemonUpdateReceipt([string]$status, [string]$version, [string]$executablePath, [string]$errorMessage) {
  $receipt = [ordered]@{
    status = $status
    version = $version
    executablePath = $executablePath
    updatedAt = [DateTime]::UtcNow.ToString('o')
  }
  if ($errorMessage) { $receipt.error = $errorMessage }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $daemonUpdateReceipt) | Out-Null
  $receiptTemporary = $daemonUpdateReceipt + '.tmp-' + [System.Guid]::NewGuid().ToString('N')
  $receiptBackup = $daemonUpdateReceipt + '.bak-' + [System.Guid]::NewGuid().ToString('N')
  [System.IO.File]::WriteAllText(
    $receiptTemporary,
    ($receipt | ConvertTo-Json -Compress),
    (New-Object System.Text.UTF8Encoding($false))
  )
  if (Test-Path -LiteralPath $daemonUpdateReceipt) {
    [System.IO.File]::Replace($receiptTemporary, $daemonUpdateReceipt, $receiptBackup, $true)
    Remove-Item -LiteralPath $receiptBackup -Force -ErrorAction SilentlyContinue
  } else {
    [System.IO.File]::Move($receiptTemporary, $daemonUpdateReceipt)
  }
}
function Get-ExactDaemonGenerationProcesses([string]$executablePath) {
  if (-not $executablePath) { return @() }
  $expectedPath = [System.IO.Path]::GetFullPath($executablePath)
  return @(Get-DaemonCommandProcesses |
    Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $expectedPath) })
}
function Stop-ExactDaemonGeneration([string]$executablePath) {
  if (-not $executablePath) { return }
  @(Get-ExactDaemonGenerationProcesses $executablePath) |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $stopDeadline = [DateTime]::UtcNow.AddSeconds(10)
  while ([DateTime]::UtcNow -lt $stopDeadline -and @(Get-ExactDaemonGenerationProcesses $executablePath).Count -gt 0) {
    Start-Sleep -Milliseconds 100
  }
  if (@(Get-ExactDaemonGenerationProcesses $executablePath).Count -gt 0) {
    throw "candidate daemon generation did not stop during rollback: $executablePath"
  }
}
"#;

#[cfg_attr(not(windows), allow(dead_code))]
struct WindowsUpdateHandoff {
    extra_wait_ms: u64,
    // Self-update owns a restart even if the parent exits before the helper runs.
    restart_daemon: bool,
    hub_url: Option<String>,
    token_assignment: String,
    wait_log: String,
    commit_log: String,
    failure_log: String,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn windows_update_handoff_script(
    temp_path: &Path,
    install_path: &Path,
    latest_version: &str,
    current_pid: u32,
    handoff_task_name: &str,
    handoff: WindowsUpdateHandoff,
) -> String {
    let extra_wait = if handoff.extra_wait_ms == 0 {
        String::new()
    } else {
        format!(
            "           Start-Sleep -Milliseconds {}\n",
            handoff.extra_wait_ms
        )
    };
    let unmanaged_start = if handoff.restart_daemon {
        let hub_url = powershell_single_quoted(handoff.hub_url.as_deref().unwrap_or(""));
        format!(
            "             $env:XMATRIX_HUB_URL = {hub_url}\n\
             {token}\
             Start-Process -FilePath $installPath -ArgumentList @('daemon') -WindowStyle Hidden\n\
             Write-DaemonUpdateLog \"started daemon process from $installPath\"\n",
            hub_url = hub_url,
            token = handoff.token_assignment,
        )
    } else {
        String::new()
    };
    format!(
        "$ErrorActionPreference = 'Stop'\n\
         $handoffTaskName = {handoff_task_name}\n\
         $taskName = 'xmatrix-daemon'\n\
         $installPath = {install_path}\n\
         $daemonUpdateLog = {daemon_update_log}\n\
         $daemonUpdateReceipt = Join-Path (Split-Path -Parent $daemonUpdateLog) 'daemon-update-receipt.json'\n\
         function Write-DaemonUpdateLog([string]$message) {{\n\
           New-Item -ItemType Directory -Force -Path (Split-Path -Parent $daemonUpdateLog) | Out-Null\n\
           Add-Content -LiteralPath $daemonUpdateLog -Value \"$(Get-Date -Format o) $message\"\n\
         }}\n\
         {atomic_update_helpers}\
         $installBackupPath = $installPath + '.rollback-' + [System.Guid]::NewGuid().ToString('N')\n\
         $installHadPrevious = $false\n\
         $installReplaced = $false\n\
         $previousVersion = 'unknown'\n\
         $task = $null\n\
         $taskAction = $null\n\
         $managedLauncher = $false\n\
         $expectedDaemonPath = $installPath\n\
         $previousDaemonPath = $installPath\n\
         $generationPointerPath = $null\n\
         $generationPointerBackupPath = $null\n\
         $generationPointerHadPrevious = $false\n\
         $generationPointerReplaced = $false\n\
         $pendingGenerationPath = $null\n\
         $pendingGenerationWritten = $false\n\
         $taskWasRunning = $false\n\
         $newDaemonHealthy = $false\n\
         $daemonWasRunning = {restart_daemon} -or @(Get-DaemonCommandProcesses).Count -gt 0\n\
         $stoppedForRestart = $false\n\
         try {{\n\
           {wait_log}\
           Wait-Process -Id {current_pid} -ErrorAction SilentlyContinue\n\
{extra_wait}\
           if (Test-Path -LiteralPath $installPath) {{\n\
             $previousVersionOutput = @(& $installPath --version 2>$null) | Select-Object -First 1\n\
             if ($previousVersionOutput -match '(\\d+\\.\\d+\\.\\d+)') {{ $previousVersion = $Matches[1] }}\n\
           }}\n\
           Write-DaemonUpdateReceipt 'staged' {latest_version} $installPath $null\n\
           $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue\n\
           if ($task) {{\n\
             $taskWasRunning = $daemonWasRunning -or $task.State -eq 'Running'\n\
             {task_path_resolution}\
             $previousDaemonPath = $daemonPath\n\
             $managedLauncher = Test-ManagedLauncherTask $taskAction\n\
             if ($managedLauncher) {{\n\
               {launcher_reconciliation}\
             }}\n\
           }}\n\
           Stop-DaemonCommandProcesses\n\
           $stoppedForRestart = $true\n\
           $handoffStartedAtUtc = [DateTime]::UtcNow\n\
           if ($managedLauncher) {{\n\
             $daemonRoot = Join-Path (Split-Path -Parent $installPath) 'xmatrix-daemon'\n\
             $generationName = {latest_version} + '-' + [System.Guid]::NewGuid().ToString('N')\n\
             $nextDaemonPath = Join-Path (Join-Path (Join-Path $daemonRoot 'generations') $generationName) 'xmatrix.exe'\n\
             $installHadPrevious = Install-StagedBinary {temp_path} $installPath $installBackupPath\n\
             $installReplaced = $true\n\
             New-Item -ItemType Directory -Force -Path (Split-Path -Parent $nextDaemonPath) | Out-Null\n\
             Copy-Item -Force -LiteralPath $installPath -Destination $nextDaemonPath\n\
             {generation_activation}\n\
           }} else {{\n\
             $installHadPrevious = Install-StagedBinary {temp_path} $installPath $installBackupPath\n\
             $installReplaced = $true\n\
             $expectedDaemonPath = $installPath\n\
             Write-DaemonUpdateLog \"replaced stable CLI at $installPath without generation pointer activation\"\n\
           }}\n\
           if ($task -and ($taskWasRunning -or $daemonWasRunning)) {{\n\
             Start-ScheduledTask -TaskName $taskName\n\
           }} elseif (-not $task) {{\n\
{unmanaged_start}\
           }}\n\
           if ($taskWasRunning -or $daemonWasRunning) {{\n\
             $newDaemonHealthy = Wait-UpdatedDaemonHealthy $expectedDaemonPath {latest_version} $handoffStartedAtUtc 60\n\
             if (-not $newDaemonHealthy) {{ throw 'new daemon did not become healthy within 60 seconds' }}\n\
             Write-DaemonUpdateLog ({commit_log})\n\
           }}\n\
           if ($pendingGenerationPath -and (Test-Path -LiteralPath $pendingGenerationPath)) {{ Remove-Item -LiteralPath $pendingGenerationPath -Force -ErrorAction Stop }}\n\
           Write-DaemonUpdateReceipt 'committed' {latest_version} $installPath $null\n\
           Remove-Item -LiteralPath $installBackupPath -Force -ErrorAction SilentlyContinue\n\
           if ($generationPointerBackupPath) {{ Remove-Item -LiteralPath $generationPointerBackupPath -Force -ErrorAction SilentlyContinue }}\n\
           $stoppedForRestart = $false\n\
         }} catch {{\n\
           $failureMessage = $_.Exception.Message\n\
           $rollbackFailureMessage = $null\n\
           $generationPointerRollbackSafe = -not $generationPointerReplaced\n\
           Write-DaemonUpdateLog ({failure_log})\n\
           try {{ Stop-DaemonCommandProcesses }} catch {{}}\n\
           if ($expectedDaemonPath) {{\n\
             try {{ Stop-ExactDaemonGeneration $expectedDaemonPath }} catch {{}}\n\
           }}\n\
           if ($generationPointerReplaced) {{\n\
             try {{\n\
               Restore-PreviousBinary $generationPointerPath $generationPointerBackupPath $generationPointerHadPrevious\n\
               $generationPointerRollbackSafe = $true\n\
               Write-DaemonUpdateLog \"restored previous daemon generation pointer after update failure\"\n\
             }} catch {{\n\
               $rollbackFailureMessage = $_.Exception.Message\n\
               Write-DaemonUpdateLog \"previous daemon generation pointer restore failed: $($_.Exception.Message)\"\n\
             }}\n\
           }}\n\
           if ($pendingGenerationWritten -and $pendingGenerationPath -and $generationPointerRollbackSafe) {{ Remove-Item -LiteralPath $pendingGenerationPath -Force -ErrorAction SilentlyContinue }}\n\
           if ($installReplaced) {{\n\
             try {{\n\
               Restore-PreviousBinary $installPath $installBackupPath $installHadPrevious\n\
               Write-DaemonUpdateLog \"restored previous stable CLI after update handoff failure\"\n\
             }} catch {{\n\
               $rollbackFailureMessage = $_.Exception.Message\n\
               Write-DaemonUpdateLog \"previous stable CLI restore failed: $($_.Exception.Message)\"\n\
             }}\n\
           }}\n\
           if ($stoppedForRestart -and -not $rollbackFailureMessage -and ($taskWasRunning -or $daemonWasRunning)) {{\n\
             try {{\n\
               $rollbackStartedAtUtc = [DateTime]::UtcNow\n\
               if ($task) {{\n\
                 Start-ScheduledTask -TaskName $taskName\n\
               }} else {{\n\
{unmanaged_start}\
               }}\n\
               if (-not (Wait-UpdatedDaemonHealthy $previousDaemonPath $previousVersion $rollbackStartedAtUtc 60)) {{\n\
                 throw 'previous daemon did not become healthy after rollback within 60 seconds'\n\
               }}\n\
               Write-DaemonUpdateLog \"restarted and verified previous daemon after update handoff failure\"\n\
             }} catch {{\n\
               $rollbackFailureMessage = $_.Exception.Message\n\
               Write-DaemonUpdateLog \"previous scheduled daemon task restart failed: $($_.Exception.Message)\"\n\
             }}\n\
           }}\n\
           if ($rollbackFailureMessage) {{\n\
             Write-DaemonUpdateReceipt 'failed' {latest_version} $installPath ($failureMessage + '; rollback failed: ' + $rollbackFailureMessage)\n\
           }} else {{\n\
             Write-DaemonUpdateReceipt 'rolled-back' $previousVersion $installPath $failureMessage\n\
           }}\n\
           throw\n\
         }} finally {{\n\
           Unregister-ScheduledTask -TaskName $handoffTaskName -Confirm:$false -ErrorAction SilentlyContinue\n\
           Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue\n\
         }}\n",
        restart_daemon = if handoff.restart_daemon {
            "$true"
        } else {
            "$false"
        },
        handoff_task_name = powershell_single_quoted(handoff_task_name),
        temp_path = powershell_single_quoted(&temp_path.display().to_string()),
        install_path = powershell_single_quoted(&install_path.display().to_string()),
        daemon_update_log =
            powershell_single_quoted(&windows_daemon_update_log_path().display().to_string()),
        latest_version = powershell_single_quoted(latest_version),
        current_pid = current_pid,
        extra_wait = extra_wait,
        wait_log = handoff.wait_log,
        commit_log = handoff.commit_log,
        failure_log = handoff.failure_log,
        unmanaged_start = unmanaged_start,
        atomic_update_helpers = WINDOWS_ATOMIC_UPDATE_HELPERS_PS,
        task_path_resolution = WINDOWS_DAEMON_TASK_PATH_RESOLUTION_PS,
        launcher_reconciliation = windows_daemon_launcher_reconciliation_ps(),
        generation_activation = WINDOWS_DAEMON_GENERATION_ACTIVATION_PS,
    )
}

#[cfg(windows)]
fn install_downloaded_update_windows(
    temp_path: &Path,
    install_path: &Path,
    latest_version: &str,
) -> error::Result<()> {
    let script_path = temp_path.with_extension("ps1");
    let current_pid = std::process::id();
    let handoff_task_name = windows_update_handoff_task_name();
    let script = windows_update_handoff_script(
        temp_path,
        install_path,
        latest_version,
        current_pid,
        &handoff_task_name,
        WindowsUpdateHandoff {
            extra_wait_ms: 3000,
            restart_daemon: false,
            hub_url: None,
            token_assignment: String::new(),
            wait_log: String::new(),
            commit_log: "\"committed Windows CLI update at $expectedDaemonPath\"".to_string(),
            failure_log: "\"Windows CLI update daemon handoff failed: $failureMessage\""
                .to_string(),
        },
    );
    std::fs::write(&script_path, script)?;
    spawn_windows_update_handoff(
        &script_path,
        &handoff_task_name,
        "Windows CLI update handoff",
    )?;
    println!(
        "{} Update staged; daemon handoff will continue after this command exits",
        "•".cyan().bold()
    );
    Ok(())
}

#[cfg(windows)]
fn schedule_windows_daemon_restart_after_update(
    temp_path: &Path,
    install_path: &Path,
    latest_version: &str,
    hub_url: &str,
    token_override: Option<&str>,
) -> error::Result<()> {
    let script_path = temp_path.with_extension("daemon-restart.ps1");
    let current_pid = std::process::id();
    let handoff_task_name = windows_update_handoff_task_name();
    let token_assignment = token_override
        .map(|token| format!("$env:XMATRIX_TOKEN = {}\n", powershell_single_quoted(token)))
        .unwrap_or_default();
    let script = windows_update_handoff_script(
        temp_path,
        install_path,
        latest_version,
        current_pid,
        &handoff_task_name,
        WindowsUpdateHandoff {
            extra_wait_ms: 0,
            restart_daemon: true,
            hub_url: Some(hub_url.to_string()),
            token_assignment,
            wait_log: format!(
                "           Write-DaemonUpdateLog \"staged daemon update; waiting for pid {current_pid}\"\n"
            ),
            commit_log: "\"committed daemon self-update at $expectedDaemonPath\"".to_string(),
            failure_log: "\"daemon restart after update failed: $failureMessage\"".to_string(),
        },
    );
    std::fs::write(&script_path, script)?;
    spawn_windows_update_handoff(
        &script_path,
        &handoff_task_name,
        "Windows daemon restart handoff",
    )?;
    Ok(())
}

#[cfg_attr(not(windows), allow(dead_code))]
fn powershell_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn configure_background_command(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        command.creation_flags(WINDOWS_CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    let _ = command;
}

#[cfg_attr(not(windows), allow(dead_code))]
const WINDOWS_CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg_attr(not(windows), allow(dead_code))]
const WINDOWS_CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

#[cfg_attr(not(windows), allow(dead_code))]
fn windows_update_handoff_creation_flags() -> u32 {
    WINDOWS_CREATE_NO_WINDOW | WINDOWS_CREATE_BREAKAWAY_FROM_JOB
}

#[cfg_attr(not(windows), allow(dead_code))]
fn windows_update_handoff_task_name() -> String {
    format!(
        "xmatrix-update-handoff-{}-{}",
        std::process::id(),
        xmatrix_cli_core::config::unix_now_secs()
    )
}

#[cfg_attr(not(windows), allow(dead_code))]
fn windows_update_handoff_schedule_ps(script_path: &Path, task_name: &str) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'\n\
         $taskName = {task_name}\n\
         $scriptPath = {script_path}\n\
         try {{\n\
           Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue\n\
           $powerShell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'\n\
           $arguments = '-NoProfile -ExecutionPolicy Bypass -File \"' + $scriptPath + '\"'\n\
           $action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments\n\
           $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(5))\n\
           $trigger.EndBoundary = (Get-Date).AddMinutes(10).ToString('s')\n\
           $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -DeleteExpiredTaskAfter (New-TimeSpan -Minutes 1)\n\
           Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'xMatrix one-shot update handoff' -Force | Out-Null\n\
           Start-ScheduledTask -TaskName $taskName\n\
           $deadline = [DateTime]::UtcNow.AddSeconds(5)\n\
           do {{\n\
             $state = (Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).State\n\
             if ($state -eq 'Running') {{ break }}\n\
             Start-Sleep -Milliseconds 100\n\
           }} while ([DateTime]::UtcNow -lt $deadline)\n\
           if ($state -ne 'Running') {{ throw \"scheduled update handoff did not start (state=$state)\" }}\n\
         }} catch {{\n\
           Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue\n\
           throw\n\
         }}\n",
        task_name = powershell_single_quoted(task_name),
        script_path = powershell_single_quoted(&script_path.display().to_string()),
    )
}

#[cfg(windows)]
fn configure_update_handoff_command(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;

    // Windows OpenSSH and other remote launchers keep the whole session in
    // a kill-on-close Job Object. A detached-stdio helper still belongs to
    // that job and is terminated when the SSH connection closes, before it
    // can replace the parent executable. Break away at process creation
    // while retaining the no-console boundary required by daemon helpers.
    command.creation_flags(windows_update_handoff_creation_flags());
}

#[cfg(windows)]
fn spawn_windows_update_handoff(
    script_path: &Path,
    task_name: &str,
    description: &str,
) -> error::Result<()> {
    let mut command = std::process::Command::new("powershell");
    configure_update_handoff_command(&mut command);
    command
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script_path.display().to_string(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    match command.spawn() {
        Ok(child) => observe_update_handoff_child(child, description),
        Err(err) if err.raw_os_error() == Some(5) => {
            // Daemon-owned request processes can live in a non-breakaway Job
            // Object. Keep that process-tree boundary intact: register the
            // already-written trusted updater as a one-shot per-user task so
            // Task Scheduler, rather than the agent process, owns its lifetime.
            schedule_windows_update_handoff(script_path, task_name, description)
        }
        Err(err) => Err(CliError::Launch(format!(
            "Failed to start {description}: {err}"
        ))),
    }
}

#[cfg(windows)]
fn schedule_windows_update_handoff(
    script_path: &Path,
    task_name: &str,
    description: &str,
) -> error::Result<()> {
    let schedule_script = windows_update_handoff_schedule_ps(script_path, task_name);
    let mut command = std::process::Command::new("powershell");
    configure_background_command(&mut command);
    let output = command
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &schedule_script,
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|err| {
            CliError::Launch(format!(
                "Failed to schedule {description} after Windows denied process breakaway: {err}"
            ))
        })?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(CliError::Launch(format!(
        "Failed to schedule {description} after Windows denied process breakaway ({}): {}",
        output.status,
        if stderr.is_empty() {
            "PowerShell returned no error details"
        } else {
            stderr.as_str()
        }
    )))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn observe_update_handoff_child(
    mut child: std::process::Child,
    description: &str,
) -> error::Result<()> {
    // A handoff helper must outlive the CLI/daemon that owns the executable it
    // will replace. Detect immediate PowerShell startup or policy failures
    // before the parent exits and releases its daemon lock; otherwise a failed
    // helper turns a recoverable update failure into an offline machine.
    std::thread::sleep(std::time::Duration::from_millis(150));
    if let Some(status) = child
        .try_wait()
        .map_err(|err| CliError::Launch(format!("Could not inspect {description}: {err}")))?
        && !status.success()
    {
        return Err(CliError::Launch(format!(
            "{description} exited before taking ownership of the update ({status})"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn staged_windows_probe_is_gated_by_current_publisher() {
        // This cross-platform wiring regression complements native signature
        // verification: a candidate must never authorize its own first execution.
        let source = include_str!("lib.rs");
        let staging = source
            .split("pub async fn stage_windows_daemon_candidate(")
            .nth(1)
            .unwrap()
            .split("pub enum CliUpdateCheck")
            .next()
            .unwrap();
        assert!(staging.contains("verify_authenticode_publisher(&current)"));
        assert!(staging.contains("Some(&trusted_publisher_sha256)"));
        assert!(!staging.contains("Some(&publisher_sha256)"));
        let verification = staging.find("verify_signed_artifact(").unwrap();
        let probe = staging.find("validate_downloaded_binary(").unwrap();
        assert!(verification < probe);
        assert!(staging[verification..probe].contains("?;"));
    }
    use super::{
        CliReleaseManifest, UpdateHintTarget, WINDOWS_ATOMIC_UPDATE_HELPERS_PS,
        WINDOWS_DAEMON_LAUNCHER, WINDOWS_DAEMON_TASK_PATH_RESOLUTION_PS, WindowsUpdateHandoff,
        is_safe_windows_daemon_generation_name, latest_release_manifest_version,
        observe_update_handoff_child, reconcile_windows_daemon_generations,
        reconcile_windows_daemon_launcher_if_installed, release_version_cmp,
        release_version_is_newer, update_hint_lines, windows_cli_ping_path, windows_cli_pong_path,
        windows_daemon_generation_path, windows_daemon_launcher_matches,
        windows_daemon_launcher_path, windows_daemon_launcher_reconciliation_ps,
        windows_daemon_ping_path, windows_daemon_pong_path, windows_host_cli_path,
        windows_host_cli_path_with_default, windows_next_cli_slot_path,
        windows_next_daemon_slot_path, windows_update_handoff_creation_flags,
        windows_update_handoff_schedule_ps, windows_update_handoff_script,
    };
    use std::path::PathBuf;

    #[cfg(not(windows))]
    use super::wait_for_unix_daemon_health;

    #[cfg(windows)]
    use super::{WINDOWS_DAEMON_GENERATION_ACTIVATION_PS, powershell_single_quoted};

    #[cfg(windows)]
    fn windows_generation_paths(
        slug: &str,
    ) -> (
        std::path::PathBuf,
        std::path::PathBuf,
        std::path::PathBuf,
        std::path::PathBuf,
    ) {
        let root = std::env::temp_dir().join(format!("{slug}-{}", std::process::id()));
        let install_path = root.join("bin").join("xmatrix.exe");
        let daemon_root = root.join("bin").join("xmatrix-daemon");
        let daemon_path = daemon_root.join("ping").join("xmatrix.exe");
        let next_daemon_path = daemon_root
            .join("generations")
            .join("0.15.35-test")
            .join("xmatrix.exe");
        (root, install_path, daemon_path, next_daemon_path)
    }

    #[test]
    fn update_hint_lines_include_commands() {
        assert_eq!(
            update_hint_lines(UpdateHintTarget::Cli, "0.9.9", "0.9.10"),
            vec![
                "xMatrix CLI update available: 0.9.9 -> 0.9.10".to_string(),
                "Update CLI: xmatrix update".to_string(),
            ]
        );
        assert_eq!(
            update_hint_lines(UpdateHintTarget::Daemon, "0.9.9", "0.9.10"),
            vec![
                "xMatrix daemon update available: 0.9.9 -> 0.9.10".to_string(),
                "Update daemon: xmatrix update".to_string(),
                "Restart daemon: xmatrix daemon".to_string(),
            ]
        );
    }

    #[test]
    fn update_handoff_rejects_a_helper_that_exited_before_ownership() {
        #[cfg(windows)]
        let mut command = {
            let mut command = std::process::Command::new("cmd");
            command.args(["/C", "exit", "23"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "exit 23"]);
            command
        };

        let mut child = command.spawn().expect("start failing fixture");
        // Process startup can exceed the production observation window on a
        // busy Windows builder. Establish the failed-child precondition rather
        // than relying on the fixture winning a 150 ms scheduling race.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if child.try_wait().expect("inspect fixture").is_some() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("failing fixture did not exit within five seconds");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let err = observe_update_handoff_child(child, "test handoff")
            .expect_err("a failed updater must fail closed before taking ownership");
        assert!(err.to_string().contains("before taking ownership"));
    }

    #[test]
    fn windows_update_handoff_escapes_kill_on_close_jobs_without_allocating_a_console() {
        assert_eq!(windows_update_handoff_creation_flags(), 0x0900_0000);
    }

    #[cfg(windows)]
    #[test]
    fn windows_launcher_pointer_switches_generations_without_editing_the_task_and_rolls_back() {
        let (root, install_path, daemon_path, next_daemon_path) =
            windows_generation_paths("xmatrix-task-acl-fallback-test");
        std::fs::create_dir_all(daemon_path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(next_daemon_path.parent().unwrap()).unwrap();
        let launcher_path = root
            .join("bin")
            .join("xmatrix-daemon")
            .join("launch-hidden.vbs");
        std::fs::write(&daemon_path, b"old-daemon").unwrap();
        std::fs::write(&next_daemon_path, b"new-daemon").unwrap();
        std::fs::write(&launcher_path, WINDOWS_DAEMON_LAUNCHER).unwrap();

        let script = format!(
            "$ErrorActionPreference = 'Stop'\n\
             function Write-DaemonUpdateLog {{ param($Message) }}\n\
             {}\n\
             $installPath = {}\n\
             $daemonPath = {}\n\
             $nextDaemonPath = {}\n\
             $generationName = '0.15.35-test'\n\
             $taskAction = [pscustomobject]@{{ Execute = (Join-Path $env:SystemRoot 'System32\\wscript.exe'); Arguments = ('//B //NoLogo \"' + {} + '\" \"' + $daemonPath + '\" \"machine\" \"supervisor\" \"start-daemon\"'); WorkingDirectory = (Split-Path -Parent $daemonPath) }}\n\
             $generationPointerPath = $null\n\
             $generationPointerBackupPath = $null\n\
             $generationPointerHadPrevious = $false\n\
             $generationPointerReplaced = $false\n\
             {}\n\
             if (-not $generationPointerReplaced) {{ throw 'generation pointer was not switched' }}\n\
             if ([System.IO.File]::ReadAllText($generationPointerPath) -ne $generationName) {{ throw 'generation pointer did not select the candidate' }}\n\
             if ([System.IO.File]::ReadAllText($pendingGenerationPath) -ne ($generationName + \"`n-\")) {{ throw 'pending transaction did not bind candidate to first-adoption rollback' }}\n\
             if ([System.IO.Path]::GetFullPath($expectedDaemonPath) -ine [System.IO.Path]::GetFullPath($nextDaemonPath)) {{ throw 'health target did not select the immutable generation' }}\n\
             if ([System.IO.File]::ReadAllText($daemonPath) -ne 'old-daemon') {{ throw 'legacy task binary was modified' }}\n\
             Restore-PreviousBinary $generationPointerPath $generationPointerBackupPath $generationPointerHadPrevious\n\
             Remove-Item -LiteralPath $pendingGenerationPath -Force\n\
             if (Test-Path -LiteralPath $generationPointerPath) {{ throw 'first-adoption rollback did not remove the pointer' }}\n\
             [System.IO.File]::WriteAllText($generationPointerPath, '0.15.34-previous')\n\
             $generationPointerReplaced = $false\n\
             $generationPointerBackupPath = $null\n\
             $generationPointerHadPrevious = $false\n\
             $pendingGenerationWritten = $false\n\
             {}\n\
             if ([System.IO.File]::ReadAllText($pendingGenerationPath) -ne ($generationName + \"`n0.15.34-previous\")) {{ throw 'pending transaction did not bind the previous committed generation' }}\n\
             Restore-PreviousBinary $generationPointerPath $generationPointerBackupPath $generationPointerHadPrevious\n\
             Remove-Item -LiteralPath $pendingGenerationPath -Force\n\
             if ([System.IO.File]::ReadAllText($generationPointerPath) -ne '0.15.34-previous') {{ throw 'existing pointer rollback did not restore the previous generation' }}\n",
            WINDOWS_ATOMIC_UPDATE_HELPERS_PS,
            powershell_single_quoted(&install_path.display().to_string()),
            powershell_single_quoted(&daemon_path.display().to_string()),
            powershell_single_quoted(&next_daemon_path.display().to_string()),
            powershell_single_quoted(&launcher_path.display().to_string()),
            WINDOWS_DAEMON_GENERATION_ACTIVATION_PS,
            WINDOWS_DAEMON_GENERATION_ACTIVATION_PS,
        );
        let output = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .output()
            .expect("run PowerShell fallback fixture");
        assert!(
            output.status.success(),
            "PowerShell pointer activation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(std::fs::read(&daemon_path).unwrap(), b"old-daemon");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_launcher_pointer_rejects_an_unmanaged_task_action() {
        let (root, install_path, daemon_path, next_daemon_path) =
            windows_generation_paths("xmatrix-unmanaged-task-test");
        std::fs::create_dir_all(daemon_path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(next_daemon_path.parent().unwrap()).unwrap();

        let script = format!(
            "$ErrorActionPreference = 'Stop'\n\
             function Write-DaemonUpdateLog {{ param($Message) }}\n\
             {}\n\
             $installPath = {}\n\
             $daemonPath = {}\n\
             $nextDaemonPath = {}\n\
             $generationName = '0.15.35-test'\n\
             $taskAction = [pscustomobject]@{{ Execute = (Join-Path $env:SystemRoot 'System32\\notepad.exe'); Arguments = ''; WorkingDirectory = (Split-Path -Parent $daemonPath) }}\n\
             $generationPointerReplaced = $false\n\
             $rejected = $false\n\
             try {{ {} }} catch {{ if ($_.Exception.Message -like 'refusing pointer activation*') {{ $rejected = $true }} else {{ throw }} }}\n\
             if (-not $rejected) {{ throw 'unmanaged task action was accepted' }}\n\
             if (Test-Path -LiteralPath (Join-Path (Join-Path (Split-Path -Parent $installPath) 'xmatrix-daemon') 'active-generation')) {{ throw 'unmanaged task wrote an activation pointer' }}\n",
            WINDOWS_ATOMIC_UPDATE_HELPERS_PS,
            powershell_single_quoted(&install_path.display().to_string()),
            powershell_single_quoted(&daemon_path.display().to_string()),
            powershell_single_quoted(&next_daemon_path.display().to_string()),
            WINDOWS_DAEMON_GENERATION_ACTIVATION_PS,
        );
        let output = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .output()
            .expect("run unmanaged PowerShell fixture");
        assert!(
            output.status.success(),
            "unmanaged task fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_launcher_uses_fresh_candidate_then_stale_legacy_fallback() {
        let root = std::env::temp_dir().join(format!(
            "xmatrix-launcher-transaction-test-{}",
            std::process::id()
        ));
        let daemon_root = root.join("xmatrix-daemon");
        let generation = daemon_root.join("generations").join("0.15.35-test");
        let launcher = daemon_root.join("launch-hidden.vbs");
        let legacy = daemon_root.join("ping").join("xmatrix.exe");
        std::fs::create_dir_all(&generation).unwrap();
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&launcher, WINDOWS_DAEMON_LAUNCHER).unwrap();
        let system_root = std::env::var_os("SystemRoot").expect("SystemRoot");
        std::fs::copy(
            PathBuf::from(&system_root)
                .join("System32")
                .join("whoami.exe"),
            generation.join("xmatrix.exe"),
        )
        .unwrap();
        std::fs::copy(
            PathBuf::from(&system_root)
                .join("System32")
                .join("where.exe"),
            &legacy,
        )
        .unwrap();
        std::fs::write(daemon_root.join("active-generation"), "0.15.35-test").unwrap();
        let pending = daemon_root.join("pending-generation");
        std::fs::write(&pending, "0.15.35-test\n-").unwrap();

        let launch = || {
            std::process::Command::new("cscript")
                .args([
                    "//B",
                    "//NoLogo",
                    &launcher.display().to_string(),
                    &legacy.display().to_string(),
                ])
                .status()
                .expect("run stable daemon launcher")
                .code()
        };
        assert_eq!(launch(), Some(0));

        let age_script = format!(
            "(Get-Item -LiteralPath {}).LastWriteTime = [DateTime]::Now.AddMinutes(-10)",
            powershell_single_quoted(&pending.display().to_string())
        );
        assert!(
            std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &age_script])
                .status()
                .expect("age pending transaction")
                .success()
        );
        assert_ne!(launch(), Some(0));

        std::fs::write(daemon_root.join("active-generation"), "..").unwrap();
        assert_eq!(launch(), Some(3));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn windows_update_handoff_scheduler_fallback_is_one_shot_and_self_cleaning() {
        let script = windows_update_handoff_schedule_ps(
            &PathBuf::from("C:/Users/Daniel/AppData/Local/Temp/xmatrix update.ps1"),
            "xmatrix-update-handoff-42-123",
        );
        assert!(script.contains("Register-ScheduledTask"));
        assert!(script.contains("Start-ScheduledTask"));
        assert!(script.contains("DeleteExpiredTaskAfter"));
        assert!(script.contains("Unregister-ScheduledTask"));
        assert!(script.contains("xmatrix update.ps1"));
        assert!(!script.contains("CREATE_BREAKAWAY_FROM_JOB"));
    }

    #[test]
    fn windows_host_update_escapes_running_cli_and_daemon_slots() {
        let stable = PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix.exe");
        let daemon = PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix-daemon/ping/xmatrix.exe");
        let live_cli = PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix-cli/pong/xmatrix.exe");

        assert_eq!(windows_host_cli_path(&stable), stable);
        assert_eq!(
            windows_host_cli_path(&daemon),
            PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix.exe")
        );
        assert_eq!(
            windows_host_cli_path(&live_cli),
            PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix.exe")
        );
    }

    #[test]
    fn windows_signed_bootstrap_updates_the_existing_default_host_cli() {
        let bootstrap =
            PathBuf::from("C:/Users/Daniel/AppData/Local/xMatrix/bootstrap-0.15.34-42/xmatrix.exe");
        let stable = PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix.exe");

        assert_eq!(
            windows_host_cli_path_with_default(&bootstrap, Some(&stable)),
            stable
        );
        assert_eq!(
            windows_host_cli_path_with_default(&bootstrap, None),
            bootstrap
        );
        let portable = PathBuf::from("D:/tools/xmatrix.exe");
        assert_eq!(
            windows_host_cli_path_with_default(&portable, Some(&stable)),
            portable
        );
    }

    #[test]
    fn windows_host_update_commits_a_health_checked_generation_before_releasing_the_old_one() {
        let source = include_str!("lib.rs");
        assert!(source.contains("Join-Path $daemonRoot 'generations'"));
        assert!(
            source.contains(
                "Copy-Item -Force -LiteralPath $installPath -Destination $nextDaemonPath"
            )
        );
        let task_action_edit = ["Set-Scheduled", "Task -TaskName $taskName -Action"].concat();
        assert!(!source.contains(&task_action_edit));
        assert!(source.contains("active-generation"));
        assert!(source.contains("pending-generation"));
        assert!(source.contains("pendingAge > 300 Or pendingAge < -300"));
        assert!(source.contains("without editing the scheduled task"));
        assert!(source.contains(
            "refusing pointer activation because the existing task is not the managed xMatrix launcher"
        ));
        assert!(source.contains(
            "Restore-PreviousBinary $generationPointerPath $generationPointerBackupPath $generationPointerHadPrevious"
        ));
        assert!(source.contains("[System.StringComparison]::OrdinalIgnoreCase"));
        assert!(source.contains("$expectedDaemonPath"));
        assert!(source.contains("new daemon did not become healthy within 60 seconds"));
        assert!(source.contains("daemon-ready.json"));
        assert!(source.contains("function Wait-UpdatedDaemonHealthy"));
        assert!(source.contains("function Get-ExactDaemonGenerationProcesses"));
        assert!(source.contains("function Stop-ExactDaemonGeneration"));
        assert!(source.contains("function Stop-DaemonCommandProcesses"));
        let stop_candidate_generation =
            ["Stop-ExactDaemonGeneration ", "$expectedDaemonPath"].concat();
        assert_eq!(source.matches(&stop_candidate_generation).count(), 1);
        let task_state_gate = ["$taskState -eq 'Running'", " -and $generationProcess"].concat();
        assert!(!source.contains(&task_state_gate));
        let normalized_source = source.replace("\r\n", "\n");
        let implementation = normalized_source
            .split("#[cfg(test)]\nmod tests")
            .next()
            .unwrap();
        assert!(
            !implementation.contains("Stop-ScheduledTask"),
            "Windows update handoff must not stop the login task Job"
        );
        let committed_receipts = implementation
            .match_indices("Write-DaemonUpdateReceipt 'committed'")
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        assert_eq!(committed_receipts.len(), 1);
        for committed_receipt in committed_receipts {
            let committed_tail = &implementation[committed_receipt..];
            let restart_obligation_released = committed_tail
                .find("$stoppedForRestart = $false")
                .expect("successful transaction releases rollback restart obligation");
            let catch = committed_tail
                .find("}} catch {{")
                .expect("update transaction retains rollback handler");
            assert!(restart_obligation_released < catch);
        }
        assert!(source.contains("Windows CLI update handoff"));
        assert!(source.contains("[System.IO.File]::Replace"));
        assert!(source.contains("Restore-PreviousBinary"));
        assert!(source.contains("Write-DaemonUpdateReceipt 'committed'"));
        assert!(source.contains("Write-DaemonUpdateReceipt 'rolled-back'"));
        assert!(source.contains("Write-DaemonUpdateReceipt 'failed'"));
        assert!(WINDOWS_DAEMON_LAUNCHER.contains("active-generation"));
        assert!(WINDOWS_DAEMON_LAUNCHER.contains("pending-generation"));
        assert!(WINDOWS_DAEMON_LAUNCHER.contains("IsSafeGenerationName"));
        let unsafe_staged_move = ["Move-Item -Force -LiteralPath ", "{temp_path}"].concat();
        assert!(!source.contains(&unsafe_staged_move));
    }

    #[cfg(windows)]
    #[test]
    fn windows_atomic_update_helper_overwrites_and_restores_the_stable_binary() {
        let root = std::env::temp_dir().join(format!(
            "xmatrix-atomic-update-test-{}-{}",
            std::process::id(),
            xmatrix_cli_core::config::unix_now_secs()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("staged.exe");
        let destination = root.join("xmatrix.exe");
        let backup = root.join("xmatrix.rollback");
        let script = root.join("verify.ps1");
        std::fs::write(&source, b"new-generation").unwrap();
        std::fs::write(&destination, b"old-generation").unwrap();
        std::fs::write(
            &script,
            format!(
                "$ErrorActionPreference = 'Stop'\n{}\n\
                 $hadPrevious = Install-StagedBinary {} {} {}\n\
                 if (-not $hadPrevious) {{ throw 'existing destination was not detected' }}\n\
                 if ((Get-Content -Raw -LiteralPath {}) -ne 'new-generation') {{ throw 'replacement did not commit' }}\n\
                 Restore-PreviousBinary {} {} $hadPrevious\n\
                 if ((Get-Content -Raw -LiteralPath {}) -ne 'old-generation') {{ throw 'rollback did not restore' }}\n",
                WINDOWS_ATOMIC_UPDATE_HELPERS_PS,
                powershell_single_quoted(&source.display().to_string()),
                powershell_single_quoted(&destination.display().to_string()),
                powershell_single_quoted(&backup.display().to_string()),
                powershell_single_quoted(&destination.display().to_string()),
                powershell_single_quoted(&destination.display().to_string()),
                powershell_single_quoted(&backup.display().to_string()),
                powershell_single_quoted(&destination.display().to_string()),
            ),
        )
        .unwrap();

        let status = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &script.display().to_string(),
            ])
            .status()
            .unwrap();
        assert!(status.success());
        assert!(!source.exists());
        assert!(!backup.exists());
        assert_eq!(std::fs::read(&destination).unwrap(), b"old-generation");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_host_update_requires_a_fresh_exact_daemon_ready_receipt() {
        let root = std::env::temp_dir().join(format!(
            "xmatrix-unix-update-health-{}-{}",
            std::process::id(),
            xmatrix_cli_core::config::unix_now_secs()
        ));
        std::fs::create_dir_all(&root).expect("create Unix update test root");
        let ready_path = root.join("daemon-ready.json");
        let executable_path = root.join("xmatrix");
        let now = xmatrix_cli_core::config::unix_now_secs();
        std::fs::write(
            &ready_path,
            serde_json::to_vec(&serde_json::json!({
                "version": "0.15.31",
                "pid": std::process::id(),
                "executablePath": executable_path,
                "updatedAt": now.to_string(),
            }))
            .expect("serialize ready state"),
        )
        .expect("write ready state");

        assert!(wait_for_unix_daemon_health(
            &ready_path,
            "0.15.31",
            &executable_path,
            now,
            std::time::Duration::from_millis(50),
        ));
        assert!(!wait_for_unix_daemon_health(
            &ready_path,
            "0.15.32",
            &executable_path,
            0,
            std::time::Duration::from_millis(50),
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn unix_update_source_keeps_agents_alive_and_rolls_back_failed_daemons() {
        let source = include_str!("lib.rs");
        assert!(source.contains("KillMode=process"));
        assert!(source.contains("daemon-update-receipt.json"));
        assert!(source.contains("rolled-back"));
        assert!(source.contains("wait_for_unix_daemon_health"));
        assert!(source.contains("process_group(0)"));
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_update_stops_signed_processes_before_replacing_their_executable() {
        let source = include_str!("lib.rs");
        let handoff = source
            .split_once("fn run_unix_update_handoff()")
            .expect("Unix update handoff")
            .1
            .split_once("fn required_update_handoff_value")
            .expect("end of Unix update handoff")
            .0;
        let owner_exit = handoff
            .find("wait_for_process_exit(parent_pid")
            .expect("wait for the invoking CLI to exit");
        let daemon_stop = handoff
            .find("stop_unix_daemon_for_update(manager")
            .expect("stop the old daemon");
        let replacement = handoff
            .find("replace_downloaded_binary(&current_exe, &install_path)")
            .expect("replace the signed executable");

        assert!(owner_exit < daemon_stop);
        assert!(daemon_stop < replacement);

        let stop_helper = source
            .split_once("fn stop_unix_daemon_for_update(")
            .expect("Unix daemon stop helper")
            .1
            .split_once("fn restart_unix_daemon(")
            .expect("end of Unix daemon stop helper")
            .0;
        assert!(stop_helper.contains("wait_for_process_exit(ready.pid"));
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_rollback_stops_the_replacement_before_restoring_signed_bytes() {
        let source = include_str!("lib.rs");
        let rollback = source
            .split_once("fn rollback_unix_update(")
            .expect("Unix rollback")
            .1
            .split_once("fn restore_unix_update_binary(")
            .expect("end of Unix rollback")
            .0;
        let replacement_stop = rollback
            .find("stop_unix_daemon_for_update(manager, None)")
            .expect("stop the replacement daemon");
        let restore = rollback
            .find("restore_unix_update_binary(rollback_path, install_path)")
            .expect("restore the prior signed executable");

        assert!(replacement_stop < restore);
    }

    #[test]
    fn windows_daemon_generation_paths_are_immutable_and_sanitized() {
        let stable = PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix.exe");
        assert_eq!(
            windows_daemon_generation_path(&stable, "0.15.31", "request:42"),
            PathBuf::from(
                "C:/Users/Daniel/.local/bin/xmatrix-daemon/generations/0.15.31-request-42/xmatrix.exe"
            )
        );
        assert_eq!(
            windows_daemon_generation_path(&stable, "..", ".."),
            PathBuf::from(
                "C:/Users/Daniel/.local/bin/xmatrix-daemon/generations/unknown-unknown/xmatrix.exe"
            )
        );
        assert!(!is_safe_windows_daemon_generation_name("."));
        assert!(!is_safe_windows_daemon_generation_name(".."));
        assert!(!is_safe_windows_daemon_generation_name(&"a".repeat(129)));
        assert!(is_safe_windows_daemon_generation_name(
            "0.15.35-0123456789abcdef"
        ));
    }

    #[test]
    fn windows_daemon_generation_reconciliation_keeps_current_and_previous() {
        let root = std::env::temp_dir().join(format!(
            "xmatrix-daemon-generations-test-{}",
            std::process::id()
        ));
        let generations = root.join("xmatrix-daemon").join("generations");
        let anchor = generations.join("0.15.28-task-anchor");
        let oldest = generations.join("0.15.29-oldest");
        let previous = generations.join("0.15.30-previous");
        let current = generations.join("0.15.31-current");
        for path in [&anchor, &oldest, &previous, &current] {
            std::fs::create_dir_all(path).unwrap();
            std::fs::write(path.join("xmatrix.exe"), b"fixture").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        std::fs::write(
            root.join("xmatrix-daemon").join("task-anchor-generation"),
            "0.15.28-task-anchor",
        )
        .unwrap();

        assert_eq!(
            reconcile_windows_daemon_generations(&current.join("xmatrix.exe")).unwrap(),
            1
        );
        assert!(!oldest.exists());
        assert!(anchor.exists());
        assert!(previous.exists());
        assert!(current.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installed_update_records_the_target_path() {
        let install_path = PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix.exe");
        let installed = super::InstalledCliUpdate {
            previous_version: "0.10.2".to_string(),
            latest_version: "0.10.3".to_string(),
            install_path: install_path.clone(),
        };

        assert_eq!(installed.install_path, install_path);
    }

    #[test]
    fn windows_daemon_slots_live_under_shared_install_dir() {
        let install_path = PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix.exe");

        assert_eq!(
            windows_daemon_ping_path(&install_path),
            PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix-daemon/ping/xmatrix.exe")
        );
        assert_eq!(
            windows_daemon_pong_path(&install_path),
            PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix-daemon/pong/xmatrix.exe")
        );
    }

    #[test]
    fn windows_daemon_update_alternates_ping_pong_slots() {
        let shared = PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix.exe");
        let ping = PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix-daemon/ping/xmatrix.exe");
        let pong = PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix-daemon/pong/xmatrix.exe");

        assert_eq!(windows_next_daemon_slot_path(&shared), ping);
        assert_eq!(windows_next_daemon_slot_path(&ping), pong);
        assert_eq!(windows_next_daemon_slot_path(&pong), ping);
    }

    #[test]
    fn windows_daemon_update_recovers_from_version_slot_paths() {
        let versioned =
            PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix-daemon/versions/0.11.14/xmatrix.exe");
        let nested = PathBuf::from(
            "C:/Users/Daniel/.local/bin/xmatrix-daemon/ping/xmatrix-daemon/versions/0.11.5/xmatrix.exe",
        );
        let ping = PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix-daemon/ping/xmatrix.exe");
        let pong = PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix-daemon/pong/xmatrix.exe");

        assert_eq!(windows_daemon_ping_path(&versioned), ping);
        assert_eq!(windows_daemon_pong_path(&versioned), pong);
        assert_eq!(windows_next_daemon_slot_path(&versioned), ping);
        assert_eq!(windows_daemon_ping_path(&nested), ping);
        assert_eq!(windows_daemon_pong_path(&nested), pong);
        assert_eq!(windows_next_daemon_slot_path(&nested), ping);
    }

    #[test]
    fn windows_daemon_task_path_resolution_supports_hidden_launcher() {
        assert!(WINDOWS_DAEMON_TASK_PATH_RESOLUTION_PS.contains("WorkingDirectory"));
        assert!(WINDOWS_DAEMON_TASK_PATH_RESOLUTION_PS.contains("wscript.exe"));
        assert!(WINDOWS_DAEMON_TASK_PATH_RESOLUTION_PS.contains("xmatrix.exe"));
        let reconciliation = windows_daemon_launcher_reconciliation_ps();
        assert!(reconciliation.contains("launch-hidden.vbs"));
        assert!(reconciliation.contains("[System.IO.File]::Replace"));
        assert!(!reconciliation.contains("Move-Item -Force"));
        assert!(reconciliation.contains("Option Explicit"));
        assert!(reconciliation.contains("wscript.exe"));
    }

    #[test]
    fn windows_daemon_launcher_reconciliation_restores_and_is_idempotent() {
        let root = std::env::temp_dir().join(format!(
            "xmatrix-daemon-launcher-test-{}",
            std::process::id()
        ));
        let stable_install_path = root.join("not-installed").join("xmatrix.exe");
        assert_eq!(
            reconcile_windows_daemon_launcher_if_installed(&stable_install_path).unwrap(),
            None
        );
        assert!(!root.join("not-installed").join("xmatrix-daemon").exists());

        let install_path = root.join("xmatrix-daemon").join("ping").join("xmatrix.exe");
        std::fs::create_dir_all(install_path.parent().unwrap()).unwrap();
        let launcher_path = windows_daemon_launcher_path(&install_path);

        assert_eq!(
            reconcile_windows_daemon_launcher_if_installed(&install_path).unwrap(),
            Some(launcher_path.clone())
        );
        assert_eq!(
            std::fs::read_to_string(&launcher_path).unwrap(),
            WINDOWS_DAEMON_LAUNCHER
        );
        assert_eq!(
            reconcile_windows_daemon_launcher_if_installed(&install_path).unwrap(),
            None
        );

        std::fs::write(&launcher_path, "broken").unwrap();
        assert_eq!(
            reconcile_windows_daemon_launcher_if_installed(&install_path).unwrap(),
            Some(launcher_path.clone())
        );
        assert_eq!(
            std::fs::read_to_string(&launcher_path).unwrap(),
            WINDOWS_DAEMON_LAUNCHER
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_daemon_launcher_accepts_installer_line_endings() {
        let crlf = format!("{}\r\n", WINDOWS_DAEMON_LAUNCHER.replace('\n', "\r\n"));
        assert!(windows_daemon_launcher_matches(crlf.as_bytes()));
        assert!(!windows_daemon_launcher_matches(b"broken"));
    }

    #[test]
    fn windows_installer_delegates_daemon_task_registration_to_the_binary() {
        let installer =
            include_str!("../../../../../apps/web/public/install.ps1").replace("\r\n", "\n");
        assert!(installer.contains("setup daemon --binary $InstallPath"));
        assert!(!installer.contains("New-ScheduledTaskAction"));
        assert!(!installer.contains("Register-ScheduledTask"));
        for retired in [
            "wscript",
            "launch-hidden",
            "active-generation",
            "pending-generation",
            "machine supervisor",
        ] {
            assert!(!installer.to_ascii_lowercase().contains(retired));
        }
    }

    #[test]
    fn windows_update_helpers_rename_a_locked_stable_cli() {
        assert!(WINDOWS_ATOMIC_UPDATE_HELPERS_PS.contains("function Move-ReplacingLockedFile"));
        assert!(WINDOWS_ATOMIC_UPDATE_HELPERS_PS.contains("function Stop-DaemonCommandProcesses"));
        assert!(WINDOWS_ATOMIC_UPDATE_HELPERS_PS.contains("function Test-ManagedLauncherTask"));
        assert!(WINDOWS_ATOMIC_UPDATE_HELPERS_PS.contains("function Wait-UpdatedDaemonHealthy"));
        assert!(
            WINDOWS_ATOMIC_UPDATE_HELPERS_PS
                .contains("Move-ReplacingLockedFile $sourcePath $destinationPath $backupPath")
        );
    }

    #[test]
    fn windows_direct_task_update_keeps_the_scheduled_task_and_skips_pointer_activation() {
        let staged = PathBuf::from("C:/tmp/xmatrix.0.16.181.new");
        let install = PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix.exe");
        let script = windows_update_handoff_script(
            &staged,
            &install,
            "0.16.181",
            45064,
            "xmatrix-update-handoff-test",
            WindowsUpdateHandoff {
                extra_wait_ms: 0,
                restart_daemon: true,
                hub_url: Some("https://xmatrix-hub.xmatrix.sh".to_string()),
                token_assignment: String::new(),
                wait_log: String::new(),
                commit_log: "\"committed\"".to_string(),
                failure_log: "\"failed\"".to_string(),
            },
        );
        assert!(script.contains("Stop-DaemonCommandProcesses"));
        assert!(script.contains("Test-ManagedLauncherTask"));
        assert!(
            script.contains(
                "replaced stable CLI at $installPath without generation pointer activation"
            )
        );
        assert!(
            !script.contains("Stop-ScheduledTask"),
            "direct-task update must not stop the login task Job"
        );
        assert!(script.contains("Start-ScheduledTask -TaskName $taskName"));
        assert!(script.contains("if ($managedLauncher)"));
        assert!(script.contains("Move-ReplacingLockedFile"));
    }

    #[test]
    fn windows_live_cli_update_alternates_ping_pong_slots() {
        let shared = PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix.exe");
        let ping = PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix-cli/ping/xmatrix.exe");
        let pong = PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix-cli/pong/xmatrix.exe");

        assert_eq!(windows_cli_ping_path(&shared), ping);
        assert_eq!(windows_cli_pong_path(&shared), pong);
        assert_eq!(windows_next_cli_slot_path(&shared), ping);
        assert_eq!(windows_next_cli_slot_path(&ping), pong);
        assert_eq!(windows_next_cli_slot_path(&pong), ping);
    }

    #[test]
    fn windows_live_cli_update_recovers_from_nested_slot_paths() {
        let versioned =
            PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix-cli/versions/0.11.14/xmatrix.exe");
        let nested = PathBuf::from(
            "C:/Users/Daniel/.local/bin/xmatrix-cli/ping/xmatrix-cli/versions/0.11.5/xmatrix.exe",
        );
        let ping = PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix-cli/ping/xmatrix.exe");
        let pong = PathBuf::from("C:/Users/Daniel/.local/bin/xmatrix-cli/pong/xmatrix.exe");

        assert_eq!(windows_cli_ping_path(&versioned), ping);
        assert_eq!(windows_cli_pong_path(&versioned), pong);
        assert_eq!(windows_next_cli_slot_path(&versioned), ping);
        assert_eq!(windows_cli_ping_path(&nested), ping);
        assert_eq!(windows_cli_pong_path(&nested), pong);
        assert_eq!(windows_next_cli_slot_path(&nested), ping);
    }

    #[test]
    fn release_version_compare_prevents_daemon_downgrades() {
        assert!(release_version_is_newer("0.9.10", "0.9.9"));
        assert!(!release_version_is_newer("0.9.8", "0.9.9"));
        assert!(!release_version_is_newer("0.9.9", "0.9.9"));
        assert_eq!(
            release_version_cmp("1.2", "1.2.0"),
            Some(std::cmp::Ordering::Equal)
        );
    }

    #[test]
    fn cli_update_prefers_manifest_version_over_release_tag() {
        let manifest = CliReleaseManifest {
            tag_name: "cli-v0.9.20".to_string(),
            version: Some("0.9.21".to_string()),
            release_version: Some("0.9.20".to_string()),
            assets: vec![],
            provenance: None,
        };

        assert_eq!(latest_release_manifest_version(&manifest), "0.9.21");
    }
}

#[cfg(all(test, windows))]
mod windows_handoff_tests;

#[cfg(target_os = "macos")]
fn retry_launchctl_bootstrap(
    label: &str,
    mut start: impl FnMut() -> std::io::Result<std::process::ExitStatus>,
) -> error::Result<()> {
    let mut last_status = None;
    for _ in 0..20 {
        let status = start()?;
        if status.success() {
            return Ok(());
        }
        last_status = Some(status);
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err(CliError::Launch(format!(
        "{label} failed with {}",
        last_status
            .map(|status| status.to_string())
            .unwrap_or_else(|| "no status".to_string())
    )))
}
