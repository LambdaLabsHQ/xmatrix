//! Owner-approved work on one harness (`machine_harness_action`, and the local
//! `xmatrix harness` CLI). A request names only a preset and an action; the
//! argv always comes from the registry compiled into this binary.
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use xmatrix_cli_agent::management::{
    AutoUpdateBehavior, AutoUpdateControl, HarnessCommand, HarnessManagement,
};
use xmatrix_cli_agent::{AgentPreset, agent_preset_by_id, agent_presets};
use xmatrix_cli_core::error::{CliError, Result};
use xmatrix_cli_core::machine_daemon_connection::{
    HarnessAction, HarnessActionResult, HarnessActionStatus,
};

use crate::runtime_daemon_harness_inventory::{
    harness_command, inventory, probe, read_latest_version, report_inventory, resolve_launcher,
    resolve_recipe_program,
};
use crate::runtime_daemon_harness_policy::{
    HarnessPolicy, daemon_runs_updates, schedules_updates, set_json_control,
};

/// Mirrors `HARNESS_ACTION_TIMEOUT_MS` in the protocol package.
const ACTION_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// A native settings command only flips one switch.
const CONTROL_TIMEOUT: Duration = Duration::from_secs(2 * 60);
/// Output still draining after the process exited belongs to a detached
/// descendant; wait this long for it, then stop reading.
const OUTPUT_DRAIN_GRACE: Duration = Duration::from_secs(2);
/// Combined output retained while running; only its sanitized tail is reported.
const OUTPUT_KEEP: usize = 16 * 1024;
/// Mirrors `OUTPUT_TAIL_MAX`; bytes also bound the protocol's UTF-16 length.
const OUTPUT_TAIL_MAX: usize = 4 * 1024;
const BUSY_MESSAGE: &str = "another action on this harness is running";

/// The connect-metadata platform name; omitted on any other target.
pub(crate) fn daemon_platform() -> Option<&'static str> {
    if cfg!(target_os = "linux") {
        Some("linux")
    } else if cfg!(target_os = "macos") {
        Some("macos")
    } else if cfg!(windows) {
        Some("windows")
    } else {
        None
    }
}

/// Last bytes of combined output with control characters (except newline and
/// tab) removed, cut on a character boundary.
pub(crate) fn output_tail(bytes: &[u8]) -> String {
    let cleaned: String = String::from_utf8_lossy(bytes)
        .chars()
        .filter(|c| matches!(c, '\n' | '\t') || !c.is_control())
        .collect();
    let mut start = cleaned.len().saturating_sub(OUTPUT_TAIL_MAX);
    while !cleaned.is_char_boundary(start) {
        start += 1;
    }
    cleaned[start..].to_string()
}

struct TailBuffer(Vec<u8>);

impl TailBuffer {
    fn push(&mut self, chunk: &[u8]) {
        self.0.extend_from_slice(chunk);
        if self.0.len() > 2 * OUTPUT_KEEP {
            let excess = self.0.len() - OUTPUT_KEEP;
            self.0.drain(..excess);
        }
    }

    fn tail(&self) -> &[u8] {
        &self.0[self.0.len().saturating_sub(OUTPUT_KEEP)..]
    }
}

async fn pump(mut reader: impl AsyncRead + Unpin, buffer: Arc<Mutex<TailBuffer>>) {
    let mut chunk = [0u8; 4096];
    while let Ok(read) = reader.read(&mut chunk).await {
        if read == 0 {
            return;
        }
        if let Ok(mut buffer) = buffer.lock() {
            buffer.push(&chunk[..read]);
        }
    }
}

#[derive(Debug)]
struct RunOutcome {
    exit_code: Option<i32>,
    timed_out: bool,
    output: Vec<u8>,
}

/// Run one registry argv: bounded output, a hard deadline that ends the whole
/// process tree, and nothing read from stdin.
async fn run_bounded(
    preset_id: &str,
    recipe: &HarnessCommand,
    timeout: Duration,
) -> std::result::Result<RunOutcome, String> {
    let program = resolve_recipe_program(preset_id, &recipe.command).ok_or_else(|| {
        format!(
            "harness command not found or identity is ambiguous: {}",
            recipe.command
        )
    })?;
    let mut child = harness_command(&program, &recipe.args)
        .spawn()
        .map_err(|error| format!("could not start {}: {error}", recipe.command))?;
    let mut tree = crate::process_tree::ProcessTreeGuard::bind_tokio_child(&child)
        .map_err(|error| format!("could not guard {}: {error}", recipe.command))?;
    let buffer = Arc::new(Mutex::new(TailBuffer(Vec::new())));
    let mut pumps = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        pumps.push(tokio::spawn(pump(stdout, buffer.clone())));
    }
    if let Some(stderr) = child.stderr.take() {
        pumps.push(tokio::spawn(pump(stderr, buffer.clone())));
    }
    let waited = tokio::time::timeout(timeout, child.wait()).await;
    let (exit_code, timed_out) = match waited {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(_)) => (None, false),
        Err(_) => {
            let _ = tree.terminate();
            let _ = child.kill().await;
            (None, true)
        }
    };
    let drain = futures_util::future::join_all(pumps.iter_mut());
    if tokio::time::timeout(OUTPUT_DRAIN_GRACE, drain)
        .await
        .is_err()
    {
        pumps.iter().for_each(tokio::task::JoinHandle::abort);
    }
    let output = buffer
        .lock()
        .map(|buffer| buffer.tail().to_vec())
        .unwrap_or_default();
    Ok(RunOutcome {
        exit_code,
        timed_out,
        output,
    })
}

pub(crate) fn result(
    preset_id: &str,
    action: HarnessAction,
    status: HarnessActionStatus,
) -> HarnessActionResult {
    HarnessActionResult {
        preset_id: preset_id.to_string(),
        action,
        status,
        exit_code: None,
        output_tail: None,
        item: None,
        inventory: None,
        login: None,
    }
}

pub(crate) fn with_tail(mut result: HarnessActionResult, text: &str) -> HarnessActionResult {
    let tail = output_tail(text.as_bytes());
    result.output_tail = (!tail.is_empty()).then_some(tail);
    result
}

async fn run_recipe(
    preset_id: &str,
    action: HarnessAction,
    recipe: &HarnessCommand,
    timeout: Duration,
) -> HarnessActionResult {
    match run_bounded(preset_id, recipe, timeout).await {
        Err(error) => with_tail(
            result(preset_id, action, HarnessActionStatus::Failed),
            &error,
        ),
        Ok(outcome) => {
            let status = if outcome.exit_code == Some(0) && !outcome.timed_out {
                HarnessActionStatus::Succeeded
            } else {
                HarnessActionStatus::Failed
            };
            let mut output = outcome.output;
            if outcome.timed_out {
                output.extend_from_slice(
                    format!("\n[stopped after {} seconds]", timeout.as_secs()).as_bytes(),
                );
            }
            let mut result = result(preset_id, action, status);
            result.exit_code = outcome.exit_code.map(i64::from);
            let tail = output_tail(&output);
            result.output_tail = (!tail.is_empty()).then_some(tail);
            result
        }
    }
}

/// Process-local busy set; a cross-process file lock covers the daemon and a
/// local CLI acting on the same harness.
static BUSY_PRESETS: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
static RUNNING_REQUESTS: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

struct Claim {
    set: &'static Mutex<BTreeSet<String>>,
    key: String,
    _file: Option<std::fs::File>,
}

impl Drop for Claim {
    fn drop(&mut self) {
        if let Ok(mut set) = self.set.lock() {
            set.remove(&self.key);
        }
    }
}

fn claim(set: &'static Mutex<BTreeSet<String>>, key: &str) -> Option<Claim> {
    set.lock().ok()?.insert(key.to_string()).then(|| Claim {
        set,
        key: key.to_string(),
        _file: None,
    })
}

fn try_lock_preset(preset_id: &str) -> Option<Claim> {
    use fs2::FileExt as _;
    let mut claim = claim(&BUSY_PRESETS, preset_id)?;
    let directory = xmatrix_cli_core::config::config_dir().join("harness-locks");
    let file = std::fs::create_dir_all(&directory).and_then(|()| {
        std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(directory.join(format!("{preset_id}.lock")))
    });
    // Cross-process exclusion is required; do not execute if it cannot be held.
    let file = file.ok()?;
    file.try_lock_exclusive().ok()?;
    claim._file = Some(file);
    Some(claim)
}

/// One running execution per Hub request id; a redelivery that arrives while
/// it runs is ignored instead of starting the recipe again.
pub(crate) struct RequestClaim(#[allow(dead_code)] Claim);

pub(crate) fn claim_request(request_id: &str) -> Option<RequestClaim> {
    claim(&RUNNING_REQUESTS, request_id).map(RequestClaim)
}

/// Persist a start fence before a mutating recipe. A daemon crash must not
/// turn a redelivery into a second installation with an unknown first outcome.
pub(crate) fn begin_request_once(request_id: &str) -> std::result::Result<(), String> {
    begin_request_in(
        &xmatrix_cli_core::config::config_dir().join("harness-action-starts"),
        request_id,
        1024,
    )
}

fn begin_request_in(
    directory: &std::path::Path,
    request_id: &str,
    limit: usize,
) -> std::result::Result<(), String> {
    use fs2::FileExt;
    use sha2::{Digest, Sha256};
    use std::io::Write;
    std::fs::create_dir_all(directory).map_err(|_| "cannot persist harness execution fence")?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(directory.join("guard.lock"))
        .map_err(|_| "cannot hold harness execution fence")?;
    lock.try_lock_exclusive()
        .map_err(|_| "cannot hold harness execution fence")?;
    // Explicitly unlock even if a concurrently forked child briefly inherits the
    // open descriptor before exec. Closing our descriptor alone can retain flock.
    struct FenceLock(std::fs::File);
    impl Drop for FenceLock {
        fn drop(&mut self) {
            let _ = fs2::FileExt::unlock(&self.0);
        }
    }
    let _lock = FenceLock(lock);
    let digest = crate::lowercase_hex(&Sha256::digest(request_id.as_bytes()));
    let path = directory.join(format!("{digest}.json"));
    let mut retained = 0;
    for (scanned, entry) in std::fs::read_dir(directory)
        .map_err(|_| "cannot read harness execution fences")?
        .enumerate()
    {
        if scanned >= 2048 {
            return Err("harness execution fence scan capacity reached".into());
        }
        let entry = entry.map_err(|_| "cannot read harness execution fences")?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        if stem.len() != 64 || !stem.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|_| "cannot inspect harness execution fence")?;
        if metadata
            .modified()
            .ok()
            .and_then(|time| time.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(30 * 24 * 3600))
        {
            std::fs::remove_file(entry.path())
                .map_err(|_| "cannot expire harness execution fence")?;
        } else {
            retained += 1;
            if retained > limit {
                return Err("harness execution fence capacity reached".into());
            }
        }
    }
    if path.exists() {
        return Err("A prior attempt may be running or interrupted; inspect the harness before issuing a new request".into());
    }
    if retained >= limit {
        return Err("harness execution fence capacity reached".into());
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "cannot persist harness execution fence")?;
    file.write_all(b"{\"started\":true}\n")
        .and_then(|()| file.sync_all())
        .map_err(|_| "cannot persist harness execution fence".to_string())
}

pub(crate) fn refused_request(
    preset_id: &str,
    action: HarnessAction,
    reason: &str,
) -> HarnessActionResult {
    with_tail(
        result(preset_id, action, HarnessActionStatus::Failed),
        reason,
    )
}

pub(crate) fn registry_preset(preset_id: &str) -> Option<&'static AgentPreset> {
    agent_preset_by_id(preset_id).filter(|preset| preset.id == preset_id)
}

async fn set_auto_update(preset: &AgentPreset, enabled: bool) -> HarnessActionResult {
    let action = if enabled {
        HarnessAction::AutoUpdateOn
    } else {
        HarnessAction::AutoUpdateOff
    };
    let Some(management) = preset
        .management
        .as_ref()
        .filter(|m| m.auto_update.behavior != AutoUpdateBehavior::Unsupported)
    else {
        return result(&preset.id, action, HarnessActionStatus::Unsupported);
    };
    // The daemon's own schedule is a mechanism; so are launch-time switches.
    let mut applied = schedules_updates(management);
    let mut notes = Vec::new();
    let mut failed = false;
    let mut exit_code = None;
    let home = dirs::home_dir();
    for control in &management.auto_update.controls {
        match control {
            AutoUpdateControl::Env { key, .. } => {
                applied = true;
                notes.push(format!("{key} is applied when xMatrix starts this harness"));
            }
            AutoUpdateControl::Flag { disabled } => {
                applied = true;
                notes.push(format!(
                    "{disabled} is applied when xMatrix starts this harness"
                ));
            }
            AutoUpdateControl::Json(file) => {
                match home
                    .as_deref()
                    .ok_or_else(|| "home directory is unavailable".to_string())
                    .and_then(|home| set_json_control(file, enabled, home))
                {
                    Ok(path) => {
                        applied = true;
                        notes.push(format!("set {} in {}", file.key, path.display()));
                    }
                    Err(error) => {
                        failed = true;
                        notes.push(error);
                    }
                }
            }
            AutoUpdateControl::Toml(file) => {
                notes.push(format!(
                    "{} (TOML) is not supported by this daemon",
                    file.path
                ));
            }
            AutoUpdateControl::Command { enable, disable } => {
                let recipe = if enabled { enable } else { disable };
                let outcome = run_recipe(&preset.id, action, recipe, CONTROL_TIMEOUT).await;
                exit_code = outcome.exit_code;
                if outcome.status == HarnessActionStatus::Succeeded {
                    applied = true;
                } else {
                    failed = true;
                }
                notes.extend(outcome.output_tail);
            }
        }
    }
    let status = if failed {
        HarnessActionStatus::Failed
    } else if !applied {
        HarnessActionStatus::Unsupported
    } else {
        match HarnessPolicy::record(&HarnessPolicy::path(), &preset.id, enabled) {
            Ok(()) => HarnessActionStatus::Succeeded,
            Err(error) => {
                notes.push(error);
                HarnessActionStatus::Failed
            }
        }
    };
    let mut result = with_tail(result(&preset.id, action, status), &notes.join("\n"));
    result.exit_code = exit_code;
    result
}

/// An install that exits 0 is only a success if xMatrix can now find the
/// launcher. npm puts global binaries in its own prefix, which a node install
/// under the home directory (or a service-manager PATH) does not cover; link
/// the launcher into `~/.local/bin`, which both inventory and Runs search,
/// and otherwise say where it went instead of reporting success.
async fn verify_launcher(
    preset: &AgentPreset,
    recipe: &HarnessCommand,
    mut outcome: HarnessActionResult,
) -> HarnessActionResult {
    if outcome.status != HarnessActionStatus::Succeeded || resolve_launcher(preset).is_some() {
        return outcome;
    }
    let mut note = format!(
        "{} finished, but xMatrix cannot find {} on this machine's PATH.",
        recipe.command, preset.display_name
    );
    let global_bin = if xmatrix_cli_agent::launcher_stem(&recipe.command) == "npm" {
        npm_global_bin(&preset.id, recipe).await
    } else {
        None
    };
    match (&global_bin, dirs::home_dir()) {
        (Some(bin), Some(home)) => {
            match link_launcher(preset, bin, &home.join(".local").join("bin")) {
                Ok(Some(link)) => {
                    note = format!("Linked {} to {}.", link.display(), bin.display());
                }
                Ok(None) => {
                    note.push_str(&format!(
                        " npm installs global commands in {}.",
                        bin.display()
                    ));
                }
                Err(error) => note.push_str(&format!(" {error}")),
            }
        }
        (Some(bin), None) => {
            note.push_str(&format!(
                " npm installs global commands in {}.",
                bin.display()
            ));
        }
        _ => {}
    }
    if resolve_launcher(preset).is_none() {
        outcome.status = HarnessActionStatus::Failed;
        note.push_str(" Add that directory to PATH, then refresh.");
    }
    let mut tail = outcome.output_tail.take().unwrap_or_default();
    if !tail.is_empty() {
        tail.push('\n');
    }
    tail.push_str(&note);
    with_tail(outcome, &tail)
}

/// npm's global command directory: `<prefix>/bin` on Unix, the prefix itself
/// on Windows.
async fn npm_global_bin(preset_id: &str, recipe: &HarnessCommand) -> Option<std::path::PathBuf> {
    let npm = resolve_recipe_program(preset_id, &recipe.command)?;
    let output = tokio::time::timeout(
        CONTROL_TIMEOUT,
        harness_command(&npm, &["prefix", "-g"]).output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let prefix = std::str::from_utf8(&output.stdout).ok()?.trim();
    if prefix.is_empty() || prefix.lines().count() != 1 {
        return None;
    }
    let prefix = std::path::PathBuf::from(prefix);
    if !prefix.is_absolute() {
        return None;
    }
    Some(if cfg!(windows) {
        prefix
    } else {
        prefix.join("bin")
    })
}

/// Link the preset's first launcher found in `source` into `target`. Never
/// replaces an existing entry; `Ok(None)` when there is nothing to link.
fn link_launcher(
    preset: &AgentPreset,
    source: &std::path::Path,
    target: &std::path::Path,
) -> std::result::Result<Option<std::path::PathBuf>, String> {
    #[cfg(unix)]
    {
        for name in preset
            .launcher_names
            .iter()
            .filter(|name| !name.contains('.'))
        {
            let binary = source.join(name);
            if !binary.is_file() {
                continue;
            }
            let link = target.join(name);
            if link.symlink_metadata().is_ok() {
                return Ok(None);
            }
            std::fs::create_dir_all(target)
                .and_then(|()| std::os::unix::fs::symlink(&binary, &link))
                .map_err(|error| format!("Could not link {}: {error}.", link.display()))?;
            return Ok(Some(link));
        }
        Ok(None)
    }
    #[cfg(not(unix))]
    {
        let _ = (preset, source, target);
        Ok(None)
    }
}

pub(crate) async fn probed_item(preset: &AgentPreset) -> Option<serde_json::Value> {
    serde_json::to_value(probe(preset, &HarnessPolicy::load()).await).ok()
}

/// The shared executor: unknown presets and missing platform recipes are
/// `unsupported`; every completed action re-probes its preset.
pub(crate) async fn execute(preset_id: &str, action: HarnessAction) -> HarnessActionResult {
    if matches!(
        action,
        HarnessAction::LoginStart | HarnessAction::LoginFinish | HarnessAction::LoginCancel
    ) {
        return crate::runtime_daemon_harness_login::execute(preset_id, action, None).await;
    }
    let preset = registry_preset(preset_id);
    if action == HarnessAction::Release {
        return match preset {
            Some(preset) => release(preset).await,
            None => result(preset_id, action, HarnessActionStatus::Unsupported),
        };
    }
    if action == HarnessAction::Refresh {
        for preset in agent_presets() {
            read_latest_version(preset).await;
        }
        let inventory = inventory().await;
        let mut result = result(preset_id, action, HarnessActionStatus::Succeeded);
        result.item = preset.and_then(|preset| {
            inventory["items"]
                .as_array()?
                .iter()
                .find(|item| item["id"] == preset.id.as_str())
                .cloned()
        });
        result.inventory = Some(inventory);
        return result;
    }
    let Some((preset, management)) =
        preset.and_then(|preset| Some((preset, preset.management.as_ref()?)))
    else {
        return result(preset_id, action, HarnessActionStatus::Unsupported);
    };
    let recipe = match action {
        HarnessAction::Install => management.install.current(),
        HarnessAction::Update => management.update.current(),
        HarnessAction::Uninstall => management.uninstall.current(),
        _ => None,
    };
    let supported = match action {
        HarnessAction::Install | HarnessAction::Update | HarnessAction::Uninstall => {
            recipe.is_some()
        }
        _ => management.auto_update.behavior != AutoUpdateBehavior::Unsupported,
    };
    let mut result = if !supported {
        result(preset_id, action, HarnessActionStatus::Unsupported)
    } else if let Some(_lock) = try_lock_preset(&preset.id) {
        match (action, recipe) {
            (HarnessAction::Install | HarnessAction::Update, Some(recipe)) => {
                let outcome = run_recipe(preset_id, action, recipe, ACTION_TIMEOUT).await;
                verify_launcher(preset, recipe, outcome).await
            }
            (_, Some(recipe)) => run_recipe(preset_id, action, recipe, ACTION_TIMEOUT).await,
            (HarnessAction::AutoUpdateOn, _) => set_auto_update(preset, true).await,
            (HarnessAction::AutoUpdateOff, _) => set_auto_update(preset, false).await,
            _ => result(preset_id, action, HarnessActionStatus::Unsupported),
        }
    } else {
        with_tail(
            result(preset_id, action, HarnessActionStatus::Failed),
            BUSY_MESSAGE,
        )
    };
    result.item = probed_item(preset).await;
    result
}

/// `HarnessInventory` JSON from a local probe; no Hub involved.
pub async fn local_inventory() -> Result<serde_json::Value> {
    Ok(inventory().await)
}

/// `HarnessActionResult` JSON through the shared executor, without a Hub lease.
pub async fn apply_local(preset_id: &str, action: &str) -> Result<serde_json::Value> {
    let action = HarnessAction::parse(action)
        .ok_or_else(|| CliError::Launch(format!("Unknown harness action `{action}`")))?;
    Ok(serde_json::to_value(execute(preset_id, action).await)?)
}

/// Presets with a newer published version whose update waits for this daemon
/// to have no live Run.
static WAITING_FOR_IDLE: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
/// `(preset, version)` updates this daemon has already started or queued, so
/// a version the update recipe does not actually install is never retried in a
/// loop.
static ATTEMPTED: Mutex<BTreeSet<(String, String)>> = Mutex::new(BTreeSet::new());

/// Hub saw the preset's registry publish a version this daemon has not seen.
/// The daemon reads the registry itself (Hub never names a version) and, if it
/// owns this harness's updates and the installed version differs, updates: a
/// harness whose own updater would run beside live sessions at once, any other
/// once the daemon has no live Run, because a Run's registry row is not tagged
/// with its harness. The re-probed item carries the new latest version.
async fn release(preset: &'static AgentPreset) -> HarnessActionResult {
    let action = HarnessAction::Release;
    let Some(management) = preset.management.as_ref().filter(|m| m.latest.is_some()) else {
        return result(&preset.id, action, HarnessActionStatus::Unsupported);
    };
    let mut outcome = match read_latest_version(preset).await {
        None => with_tail(
            result(&preset.id, action, HarnessActionStatus::Failed),
            "the registry did not answer",
        ),
        Some(latest) => apply_release(preset, management, latest).await,
    };
    outcome.item = probed_item(preset).await;
    outcome
}

async fn apply_release(
    preset: &'static AgentPreset,
    management: &HarnessManagement,
    latest: String,
) -> HarnessActionResult {
    let action = HarnessAction::Release;
    let policy = HarnessPolicy::load();
    let installed = probe(preset, &policy).await.version;
    let owned = daemon_runs_updates(preset, &policy) && resolve_launcher(preset).is_some();
    if !owned || installed.is_none() || installed.as_deref() == Some(latest.as_str()) {
        return result(&preset.id, action, HarnessActionStatus::Succeeded);
    }
    let Some(recipe) = management.update.current() else {
        return result(&preset.id, action, HarnessActionStatus::Succeeded);
    };
    let key = (preset.id.clone(), latest);
    // A poisoned set refuses rather than risk an update loop.
    let seen = ATTEMPTED
        .lock()
        .map(|attempted| attempted.contains(&key))
        .unwrap_or(true);
    if seen {
        return result(&preset.id, action, HarnessActionStatus::Succeeded);
    }
    if !management.auto_update.interactive_only {
        if let (Ok(mut waiting), Ok(mut attempted)) = (WAITING_FOR_IDLE.lock(), ATTEMPTED.lock()) {
            waiting.insert(preset.id.clone());
            attempted.insert(key);
        }
        return with_tail(
            result(&preset.id, action, HarnessActionStatus::Succeeded),
            "update waits until no Run is live on this daemon",
        );
    }
    let Some(_lock) = try_lock_preset(&preset.id) else {
        return with_tail(
            result(&preset.id, action, HarnessActionStatus::Failed),
            BUSY_MESSAGE,
        );
    };
    if let Ok(mut attempted) = ATTEMPTED.lock() {
        attempted.insert(key);
    }
    let update = run_recipe(&preset.id, HarnessAction::Update, recipe, ACTION_TIMEOUT).await;
    HarnessActionResult { action, ..update }
}

/// The daemon's last live Run exited: run the updates that were waiting for it.
pub(crate) fn on_daemon_idle(
    relay: &Arc<xmatrix_cli_core::machine_daemon_connection::MachineDaemonConnectionClient>,
) {
    let waiting = WAITING_FOR_IDLE
        .lock()
        .map(|mut waiting| std::mem::take(&mut *waiting))
        .unwrap_or_default();
    if waiting.is_empty() {
        return;
    }
    let relay = relay.clone();
    tokio::spawn(async move {
        for preset in waiting.iter().filter_map(|id| registry_preset(id)) {
            // The owner may have turned it off since the release that queued it.
            if daemon_runs_updates(preset, &HarnessPolicy::load()) {
                update_and_report(preset, &relay).await;
            }
        }
    });
}

async fn update_and_report(
    preset: &'static AgentPreset,
    relay: &xmatrix_cli_core::machine_daemon_connection::MachineDaemonConnectionClient,
) {
    let Some(recipe) = preset.management.as_ref().and_then(|m| m.update.current()) else {
        return;
    };
    // An owner action already running on this harness covers it.
    let Some(_lock) = try_lock_preset(&preset.id) else {
        return;
    };
    let outcome = run_recipe(&preset.id, HarnessAction::Update, recipe, ACTION_TIMEOUT).await;
    eprintln!(
        "Automatic {} update {:?} (exit {:?})",
        preset.id, outcome.status, outcome.exit_code
    );
    report_inventory(relay).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(unix)]
    fn npm_launcher_is_linked_once_and_never_replaces_an_existing_entry() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("xmatrix-npm-link-{}", uuid::Uuid::new_v4()));
        let global = root.join("opt").join("node").join("bin");
        let local = root.join(".local").join("bin");
        std::fs::create_dir_all(&global).unwrap();
        let preset = agent_presets().iter().find(|p| p.id == "codex").unwrap();
        assert_eq!(link_launcher(preset, &global, &local), Ok(None));
        let binary = global.join("codex");
        std::fs::write(&binary, b"fixture").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let link = local.join("codex");
        assert_eq!(
            link_launcher(preset, &global, &local),
            Ok(Some(link.clone()))
        );
        assert_eq!(std::fs::read_link(&link).unwrap(), binary);
        // A second install, or a launcher the person placed there, is left alone.
        assert_eq!(link_launcher(preset, &global, &local), Ok(None));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn output_tail_strips_controls_and_keeps_the_last_four_kib() {
        assert_eq!(
            output_tail(b"ok\x1b[31m red\x07\r\n\tnext\x00\x7f"),
            "ok[31m red\n\tnext"
        );
        let long = format!("{}{}", "a".repeat(10_000), "é".repeat(3_000));
        let tail = output_tail(long.as_bytes());
        assert!(tail.len() <= OUTPUT_TAIL_MAX);
        assert!(tail.encode_utf16().count() <= OUTPUT_TAIL_MAX);
        assert!(tail.ends_with('é') && tail.chars().all(|c| c == 'é'));
        assert_eq!(output_tail(&[0xff, b'x']), "\u{fffd}x");
        let mut buffer = TailBuffer(Vec::new());
        for _ in 0..100 {
            buffer.push(&[b'x'; 1000]);
        }
        buffer.push(b"END");
        assert!(buffer.0.len() <= 2 * OUTPUT_KEEP);
        assert_eq!(buffer.tail().len(), OUTPUT_KEEP);
        assert!(buffer.tail().ends_with(b"END"));
    }

    #[tokio::test]
    async fn unknown_presets_and_missing_recipes_are_unsupported() {
        for (preset, action) in [
            ("no-such-harness", HarnessAction::Install),
            ("CODEX", HarnessAction::Update),
            ("zcode", HarnessAction::Install),
            ("custom", HarnessAction::Update),
            ("zcode", HarnessAction::AutoUpdateOff),
            ("grok", HarnessAction::Uninstall),
            // No official registry publishes Cursor: nothing to hear about.
            ("cursor", HarnessAction::Release),
            ("no-such-harness", HarnessAction::Release),
        ] {
            let result = execute(preset, action).await;
            assert_eq!(result.status, HarnessActionStatus::Unsupported, "{preset}");
            assert!(result.exit_code.is_none() && result.output_tail.is_none());
        }
        // Cursor updates itself and documents no switch: nothing to change.
        let cursor = set_auto_update(agent_preset_by_id("cursor").unwrap(), false).await;
        assert_eq!(cursor.status, HarnessActionStatus::Unsupported);
        // The compiled registry has a recipe for this platform where expected.
        let codex = registry_preset("codex")
            .unwrap()
            .management
            .as_ref()
            .unwrap();
        assert_eq!(codex.install.current().unwrap().command, "npm");
        assert!(
            registry_preset("zcode")
                .unwrap()
                .management
                .as_ref()
                .unwrap()
                .install
                .current()
                .is_none()
        );
    }

    #[test]
    fn a_second_action_on_the_same_preset_is_refused_while_one_runs() {
        let id = format!("test-{}", uuid::Uuid::new_v4());
        let first = claim(&BUSY_PRESETS, &id).unwrap();
        assert!(claim(&BUSY_PRESETS, &id).is_none());
        drop(first);
        assert!(claim(&BUSY_PRESETS, &id).is_some());
        let request = claim_request(&id).unwrap();
        assert!(claim_request(&id).is_none());
        drop(request);
        assert!(claim_request(&id).is_some());
    }

    #[tokio::test]
    async fn bounded_runner_reports_exit_output_and_deadline() {
        let shell = if cfg!(windows) { "powershell" } else { "sh" };
        let recipe = |script: &str| HarnessCommand {
            command: shell.into(),
            args: if cfg!(windows) {
                vec!["-NoProfile".into(), "-Command".into(), script.into()]
            } else {
                vec!["-c".into(), script.into()]
            },
        };
        let ok = run_recipe(
            "t",
            HarnessAction::Update,
            &recipe("echo installed; exit 0"),
            ACTION_TIMEOUT,
        )
        .await;
        assert_eq!(ok.status, HarnessActionStatus::Succeeded);
        assert_eq!(ok.exit_code, Some(0));
        assert!(ok.output_tail.unwrap().contains("installed"));
        let failed = run_recipe(
            "t",
            HarnessAction::Update,
            &recipe(if cfg!(windows) {
                "[Console]::Error.WriteLine('nope'); exit 3"
            } else {
                "echo nope 1>&2; exit 3"
            }),
            ACTION_TIMEOUT,
        )
        .await;
        assert_eq!(failed.status, HarnessActionStatus::Failed);
        assert_eq!(failed.exit_code, Some(3));
        assert!(failed.output_tail.unwrap().contains("nope"));
        let slow = run_recipe(
            "t",
            HarnessAction::Update,
            &recipe(if cfg!(windows) {
                "Start-Sleep -Seconds 30"
            } else {
                "sleep 30"
            }),
            Duration::from_millis(300),
        )
        .await;
        assert_eq!(slow.status, HarnessActionStatus::Failed);
        assert!(slow.exit_code.is_none());
        assert!(slow.output_tail.unwrap().contains("stopped after"));
        let missing = run_recipe(
            "t",
            HarnessAction::Install,
            &HarnessCommand {
                command: "xmatrix-no-such-installer-5c1e".into(),
                args: vec![],
            },
            ACTION_TIMEOUT,
        )
        .await;
        assert_eq!(missing.status, HarnessActionStatus::Failed);
        assert!(
            missing
                .output_tail
                .unwrap()
                .starts_with("harness command not found")
        );
    }

    #[tokio::test]
    async fn unknown_actions_error() {
        let error = HarnessAction::parse("purge");
        assert!(error.is_none());
        if !xmatrix_cli_channel::running_inside_agent_execution_context() {
            assert!(apply_local("codex", "purge").await.is_err());
        }
    }

    #[test]
    fn start_fence_survives_restart_and_fails_closed_at_capacity() {
        let directory =
            std::env::temp_dir().join(format!("xmatrix-harness-start-{}", uuid::Uuid::new_v4()));
        begin_request_in(&directory, "harness:one", 2).unwrap();
        // No live in-memory claim remains, but the same request cannot execute again.
        assert!(
            begin_request_in(&directory, "harness:one", 2)
                .unwrap_err()
                .contains("prior attempt")
        );
        begin_request_in(&directory, "harness:two", 2).unwrap();
        assert!(
            begin_request_in(&directory, "harness:three", 2)
                .unwrap_err()
                .contains("capacity")
        );
        let blocked = directory.join("not-a-directory");
        std::fs::write(&blocked, b"blocked").unwrap();
        assert!(begin_request_in(&blocked, "harness:four", 2).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn platform_metadata_names_the_compiled_target() {
        let platform = daemon_platform();
        if cfg!(target_os = "linux") {
            assert_eq!(platform, Some("linux"));
        }
        assert!(matches!(
            platform,
            None | Some("linux" | "macos" | "windows")
        ));
    }
}
