//! The owner's remote sign-in to a harness (`login_*` harness actions). The
//! daemon runs the preset's official sign-in command with piped I/O, or in a
//! pseudo-terminal when its prompt refuses a pipe, reads the verification URL
//! and one-time code from its output, and keeps the process waiting until the
//! owner finishes on that page. The argv, the output patterns and the status
//! command come from the compiled registry only.
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use regex::Regex;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::ChildStdin;
use tokio::sync::{oneshot, watch};
use xmatrix_cli_agent::AgentPreset;
use xmatrix_cli_agent::management::{HarnessLogin, LoginFlow};
use xmatrix_cli_core::machine_daemon_connection::{
    HarnessAction, HarnessActionResult, HarnessActionStatus, HarnessLoginProgress,
    HarnessLoginState,
};

use crate::runtime_daemon_harness_action::{probed_item, registry_preset, result, with_tail};
use crate::runtime_daemon_harness_inventory::{
    harness_command, resolve_launcher, resolve_recipe_program,
};

/// How long a sign-in command may take to print its URL and code.
const START_TIMEOUT: Duration = Duration::from_secs(45);
/// Device codes expire after about 15 minutes; a sign-in left waiting longer
/// is ended so no process outlives its code.
const SESSION_TTL: Duration = Duration::from_secs(15 * 60);
/// After a pasted code, the harness only exchanges it for a token.
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
const OUTPUT_KEEP: usize = 16 * 1024;
const URL_MAX: usize = 2048;
const USER_CODE_MAX: usize = 64;
const POLL: Duration = Duration::from_millis(200);
/// Wide enough that a sign-in link is never wrapped by the terminal size.
const TERMINAL_COLS: u16 = 1000;
const TERMINAL_ROWS: u16 = 50;

/// Where a pasted code goes: the sign-in's stdin pipe, or its terminal.
enum Input {
    Pipe(ChildStdin),
    /// Behind a lock so a waiting `Session` can be shared while it waits.
    Terminal(Mutex<Box<dyn Write + Send>>),
}

impl Input {
    async fn send_line(&mut self, code: &str) -> std::io::Result<()> {
        match self {
            Self::Pipe(stdin) => {
                stdin.write_all(format!("{code}\n").as_bytes()).await?;
                stdin.flush().await
            }
            // A terminal submits a line on Enter, which is a carriage return.
            Self::Terminal(writer) => {
                let writer = writer
                    .get_mut()
                    .map_err(|_| std::io::Error::other("the sign-in terminal is unavailable"))?;
                writer.write_all(format!("{code}\r").as_bytes())?;
                writer.flush()
            }
        }
    }
}

/// One waiting sign-in per preset; starting again replaces it.
struct Session {
    flow: LoginFlow,
    /// The URL and code it printed, offered again after a refused code.
    prompt: (String, Option<String>),
    input: Option<Input>,
    output: Arc<Mutex<Vec<u8>>>,
    /// `Some(exit code)` once the process ended.
    exited: watch::Receiver<Option<Option<i32>>>,
    stop: Option<oneshot::Sender<()>>,
}

impl Session {
    fn end(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

static SESSIONS: LazyLock<Mutex<BTreeMap<String, Session>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

/// ANSI escape sequences, then every control character except newline and tab.
pub(crate) fn plain_output(bytes: &[u8]) -> String {
    static ANSI: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]")
            .expect("ANSI pattern")
    });
    ANSI.replace_all(&String::from_utf8_lossy(bytes), "")
        .chars()
        .filter(|c| matches!(c, '\n' | '\t') || !c.is_control())
        .collect()
}

fn capture(pattern: &str, text: &str) -> Option<String> {
    let found = Regex::new(pattern)
        .ok()?
        .captures(text)?
        .get(1)?
        .as_str()
        .trim()
        .to_string();
    (!found.is_empty()).then_some(found)
}

/// The verification URL and code a sign-in printed, once both are complete.
pub(crate) fn prompt(login: &HarnessLogin, text: &str) -> Option<(String, Option<String>)> {
    let url = capture(&login.url_regex, text)
        .filter(|url| url.len() <= URL_MAX && url.starts_with("https://"))
        .filter(|url| !url.chars().any(char::is_whitespace))?;
    let code = match &login.code_regex {
        Some(pattern) => Some(capture(pattern, text).filter(|code| code.len() <= USER_CODE_MAX)?),
        None => None,
    };
    Some((url, code))
}

fn progress(state: HarnessLoginState, flow: LoginFlow) -> HarnessLoginProgress {
    HarnessLoginProgress {
        state,
        flow: Some(flow.as_str().to_string()),
        verification_uri: None,
        user_code: None,
    }
}

fn answer(
    preset_id: &str,
    action: HarnessAction,
    status: HarnessActionStatus,
    login: Option<HarnessLoginProgress>,
) -> HarnessActionResult {
    let mut answer = result(preset_id, action, status);
    answer.login = login;
    answer
}

async fn pump(mut reader: impl AsyncRead + Unpin, output: Arc<Mutex<Vec<u8>>>) {
    let mut chunk = [0u8; 4096];
    while let Ok(read) = reader.read(&mut chunk).await {
        if read == 0 {
            return;
        }
        if let Ok(mut output) = output.lock() {
            output.extend_from_slice(&chunk[..read]);
            if output.len() > 2 * OUTPUT_KEEP {
                let excess = output.len() - OUTPUT_KEEP;
                output.drain(..excess);
            }
        }
    }
}

/// `pump` for a terminal's blocking reader; it ends when the terminal closes.
fn pump_blocking(mut reader: Box<dyn Read + Send>, output: Arc<Mutex<Vec<u8>>>) {
    let mut chunk = [0u8; 4096];
    while let Ok(read) = reader.read(&mut chunk) {
        if read == 0 {
            return;
        }
        if let Ok(mut output) = output.lock() {
            output.extend_from_slice(&chunk[..read]);
            if output.len() > 2 * OUTPUT_KEEP {
                let excess = output.len() - OUTPUT_KEEP;
                output.drain(..excess);
            }
        }
    }
}

fn snapshot(output: &Mutex<Vec<u8>>) -> Vec<u8> {
    output
        .lock()
        .map(|output| output.clone())
        .unwrap_or_default()
}

/// The harness's own launcher binds the same binary inventory reports.
fn program(preset: &AgentPreset, command: &str) -> Option<std::path::PathBuf> {
    if command == preset.runtime || preset.launcher_names.iter().any(|name| name == command) {
        resolve_launcher(preset)
    } else {
        resolve_recipe_program(&preset.id, command)
    }
}

fn take_session(preset_id: &str) -> Option<Session> {
    SESSIONS.lock().ok()?.remove(preset_id)
}

/// Remove the preset's session only if it is still the one this caller holds.
fn take_same_session(preset_id: &str, output: &Arc<Mutex<Vec<u8>>>) -> Option<Session> {
    let mut sessions = SESSIONS.lock().ok()?;
    let same = sessions
        .get(preset_id)
        .is_some_and(|session| Arc::ptr_eq(&session.output, output));
    same.then(|| sessions.remove(preset_id)).flatten()
}

/// Owner-requested sign-in work on one preset.
pub(crate) async fn execute(
    preset_id: &str,
    action: HarnessAction,
    code: Option<&str>,
) -> HarnessActionResult {
    let Some((preset, login)) = registry_preset(preset_id)
        .and_then(|preset| Some((preset, preset.management.as_ref()?.login.as_ref()?)))
    else {
        return result(preset_id, action, HarnessActionStatus::Unsupported);
    };
    let mut outcome = match action {
        HarnessAction::LoginStart => start(preset, login).await,
        HarnessAction::LoginFinish => finish(preset, login, code).await,
        HarnessAction::LoginCancel => {
            if let Some(mut session) = take_session(&preset.id) {
                session.end();
            }
            answer(
                &preset.id,
                action,
                HarnessActionStatus::Succeeded,
                Some(progress(HarnessLoginState::Cancelled, login.flow)),
            )
        }
        _ => result(preset_id, action, HarnessActionStatus::Unsupported),
    };
    if action != HarnessAction::LoginStart {
        outcome.item = probed_item(preset).await;
    }
    outcome
}

fn sign_in_failed(
    preset: &AgentPreset,
    action: HarnessAction,
    login: &HarnessLogin,
    text: &str,
) -> HarnessActionResult {
    let mut failed = with_tail(
        result(&preset.id, action, HarnessActionStatus::Failed),
        text,
    );
    failed.login = Some(progress(HarnessLoginState::Failed, login.flow));
    failed
}

async fn start(preset: &AgentPreset, login: &HarnessLogin) -> HarnessActionResult {
    let failed = |text: &str| sign_in_failed(preset, HarnessAction::LoginStart, login, text);
    let action = HarnessAction::LoginStart;
    if let Some(mut previous) = take_session(&preset.id) {
        previous.end();
    }
    let Some(program) = program(preset, &login.start.command) else {
        return failed(&format!(
            "harness command not found or identity is ambiguous: {}",
            login.start.command
        ));
    };
    let output = Arc::new(Mutex::new(Vec::new()));
    let (exit_tx, exited) = watch::channel(None);
    let (stop, stopped) = oneshot::channel::<()>();
    let spawned = if login.terminal {
        spawn_in_terminal(&program, login, output.clone(), exit_tx, stopped)
    } else {
        spawn_piped(&program, login, output.clone(), exit_tx, stopped)
    };
    let input = match spawned {
        Ok(input) => input,
        Err(error) => return failed(&error),
    };
    let mut session = Session {
        flow: login.flow,
        prompt: (String::new(), None),
        input: Some(input),
        output: output.clone(),
        exited: exited.clone(),
        stop: Some(stop),
    };
    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    loop {
        let text = plain_output(&snapshot(&output));
        if let Some((url, code)) = prompt(login, &text) {
            session.prompt = (url.clone(), code.clone());
            if let Ok(mut sessions) = SESSIONS.lock() {
                sessions.insert(preset.id.clone(), session);
            }
            return answer(
                &preset.id,
                action,
                HarnessActionStatus::Succeeded,
                Some(HarnessLoginProgress {
                    state: HarnessLoginState::AwaitingUser,
                    flow: Some(login.flow.as_str().to_string()),
                    verification_uri: Some(url),
                    user_code: code,
                }),
            );
        }
        if exited.borrow().is_some() {
            // Already signed in, or the sign-in refused to run headless.
            return failed(&text);
        }
        if tokio::time::Instant::now() >= deadline {
            session.end();
            return failed(&format!(
                "{text}\n[no sign-in link after {} seconds]",
                START_TIMEOUT.as_secs()
            ));
        }
        tokio::time::sleep(POLL).await;
    }
}

/// Start the sign-in with piped I/O. Its supervisor owns the process: it ends
/// with the process, on a cancel, or when the code would have expired.
fn spawn_piped(
    program: &std::path::Path,
    login: &HarnessLogin,
    output: Arc<Mutex<Vec<u8>>>,
    exit_tx: watch::Sender<Option<Option<i32>>>,
    mut stopped: oneshot::Receiver<()>,
) -> Result<Input, String> {
    let name = &login.start.command;
    let mut command = harness_command(program, &login.start.args);
    command.stdin(Stdio::piped()).envs(&login.start.env);
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start {name}: {error}"))?;
    let mut tree = match crate::process_tree::ProcessTreeGuard::bind_tokio_child(&child) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.start_kill();
            return Err(format!("could not guard {name}: {error}"));
        }
    };
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(pump(stdout, output.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(pump(stderr, output));
    }
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| format!("{name} has no stdin"))?;
    tokio::spawn(async move {
        let code = tokio::select! {
            status = child.wait() => status.ok().and_then(|status| status.code()),
            _ = &mut stopped => None,
            () = tokio::time::sleep(SESSION_TTL) => None,
        };
        let _ = tree.terminate();
        let _ = child.kill().await;
        let _ = exit_tx.send(Some(code));
    });
    Ok(Input::Pipe(stdin))
}

/// Start the sign-in in a pseudo-terminal, for prompts that refuse a pipe.
/// The supervisor ends it exactly as `spawn_piped` does.
fn spawn_in_terminal(
    program: &std::path::Path,
    login: &HarnessLogin,
    output: Arc<Mutex<Vec<u8>>>,
    exit_tx: watch::Sender<Option<Option<i32>>>,
    mut stopped: oneshot::Receiver<()>,
) -> Result<Input, String> {
    let name = &login.start.command;
    let home = dirs::home_dir().map(|home| home.to_string_lossy().into_owned());
    let env: Vec<(String, String)> = login
        .start
        .env
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let program = program.to_string_lossy().into_owned();
    let args = login.start.args.clone();
    let name_owned = name.clone();
    // The terminal's slave end is not `Send` and must outlive the process
    // (on Windows it is the pseudo-console), so one thread owns the terminal
    // from spawn to exit and hands back only what the supervisor needs.
    let (ready_tx, ready) = std::sync::mpsc::channel();
    let (wait_tx, waited) = oneshot::channel();
    std::thread::spawn(move || {
        let terminal = match xmatrix_cli_terminal::pty::PtyWrapper::spawn(
            &program,
            &args,
            home.as_deref(),
            &env,
            TERMINAL_COLS,
            TERMINAL_ROWS,
        ) {
            Ok(terminal) => terminal,
            Err(error) => {
                let _ = ready_tx.send(Err(format!(
                    "could not start {name_owned} in a terminal: {error}"
                )));
                return;
            }
        };
        let (reader, writer, master, mut child, slave) = terminal.take_reader();
        let tree = match crate::process_tree::guard_portable_pty_child(child.as_mut()) {
            Ok(tree) => tree,
            Err(error) => {
                let _ = ready_tx.send(Err(format!("could not guard {name_owned}: {error}")));
                return;
            }
        };
        let killer = child.clone_killer();
        std::thread::spawn(move || pump_blocking(reader, output));
        if ready_tx.send(Ok((writer, killer, tree))).is_err() {
            let _ = child.kill();
            return;
        }
        let code = child
            .wait()
            .ok()
            .and_then(|status| i32::try_from(status.exit_code()).ok());
        // The terminal closes only after its process is gone.
        drop((master, slave));
        let _ = wait_tx.send(code);
    });
    let (writer, mut killer, mut tree) = ready
        .recv()
        .map_err(|_| format!("could not start {name} in a terminal"))??;
    tokio::spawn(async move {
        let code = tokio::select! {
            code = waited => code.ok().flatten(),
            _ = &mut stopped => None,
            () = tokio::time::sleep(SESSION_TTL) => None,
        };
        let _ = tree.terminate();
        let _ = killer.kill();
        let _ = exit_tx.send(Some(code));
    });
    Ok(Input::Terminal(Mutex::new(writer)))
}

async fn finish(
    preset: &AgentPreset,
    login: &HarnessLogin,
    code: Option<&str>,
) -> HarnessActionResult {
    let failed = |text: &str| sign_in_failed(preset, HarnessAction::LoginFinish, login, text);
    let action = HarnessAction::LoginFinish;
    let Some(mut session) = take_session(&preset.id) else {
        return failed("no sign-in is waiting on this machine; start it again");
    };
    if session.flow == LoginFlow::UrlPasteCode {
        let Some(code) = code.map(str::trim).filter(|code| !code.is_empty()) else {
            // Put it back: the owner can still paste the code.
            if let Ok(mut sessions) = SESSIONS.lock() {
                sessions.entry(preset.id.clone()).or_insert(session);
            }
            return failed("paste the code the sign-in page showed");
        };
        let mark = snapshot(&session.output).len();
        let written = match session.input.as_mut() {
            Some(input) => input.send_line(code).await,
            None => Err(std::io::Error::other("the sign-in no longer reads input")),
        };
        if let Err(error) = written {
            session.end();
            return failed(&format!("could not hand the code to the sign-in: {error}"));
        }
        if let Some(refusal) = refused(login, &session, mark).await {
            // The same sign-in still waits: offer its link again for another code.
            let mut answer = failed(&refusal);
            answer.login = Some(HarnessLoginProgress {
                state: HarnessLoginState::AwaitingUser,
                flow: Some(login.flow.as_str().to_string()),
                verification_uri: Some(session.prompt.0.clone()),
                user_code: session.prompt.1.clone(),
            });
            if let Ok(mut sessions) = SESSIONS.lock() {
                sessions.entry(preset.id.clone()).or_insert(session);
            }
            return answer;
        }
    }
    let wait = match session.flow {
        LoginFlow::UrlPasteCode => EXCHANGE_TIMEOUT,
        LoginFlow::DeviceCode => SESSION_TTL,
    };
    let output = session.output.clone();
    let mut exited = session.exited.clone();
    // Stay registered while waiting, so the owner's cancel can still end it.
    if let Ok(mut sessions) = SESSIONS.lock() {
        sessions.insert(preset.id.clone(), session);
    }
    let ended = tokio::time::timeout(wait, exited.wait_for(Option::is_some))
        .await
        .ok()
        .and_then(|value| value.ok().map(|value| *value));
    let current = take_same_session(&preset.id, &output);
    let exit_code = match ended {
        Some(value) => value,
        None => {
            if let Some(mut session) = current {
                session.end();
            }
            return failed("the sign-in did not finish in time");
        }
    };
    let text = plain_output(&snapshot(&output));
    let signed_in = match login.status {
        Some(_) => status(preset).await == Some(true),
        None => exit_code == Some(Some(0)),
    };
    if !signed_in {
        let mut failed = failed(&text);
        failed.exit_code = exit_code.flatten().map(i64::from);
        return failed;
    }
    answer(
        &preset.id,
        action,
        HarnessActionStatus::Succeeded,
        Some(progress(HarnessLoginState::SignedIn, login.flow)),
    )
}

/// The harness's refusal of a pasted code, read from output after `mark`
/// until the harness exits or the exchange would have finished.
async fn refused(login: &HarnessLogin, session: &Session, mark: usize) -> Option<String> {
    let pattern = Regex::new(login.rejected_regex.as_deref()?).ok()?;
    let deadline = tokio::time::Instant::now() + EXCHANGE_TIMEOUT;
    while tokio::time::Instant::now() < deadline && session.exited.borrow().is_none() {
        let output = snapshot(&session.output);
        let text = plain_output(output.get(mark.min(output.len())..).unwrap_or_default());
        if let Some(found) = pattern.find(&text) {
            let line = text[found.start()..]
                .lines()
                .next()
                .unwrap_or_default()
                .trim();
            return Some(line.to_string());
        }
        tokio::time::sleep(POLL).await;
    }
    None
}

/// The harness's own answer to whether it is signed in; `None` when it has
/// no status command or did not answer.
pub(crate) async fn status(preset: &AgentPreset) -> Option<bool> {
    let recipe = preset
        .management
        .as_ref()?
        .login
        .as_ref()?
        .status
        .as_ref()?;
    let program = program(preset, &recipe.command)?;
    let mut child = harness_command(&program, &recipe.args).spawn().ok()?;
    let mut tree = crate::process_tree::ProcessTreeGuard::bind_tokio_child(&child).ok()?;
    let output = Arc::new(Mutex::new(Vec::new()));
    let mut pumps = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        pumps.push(tokio::spawn(pump(stdout, output.clone())));
    }
    if let Some(stderr) = child.stderr.take() {
        pumps.push(tokio::spawn(pump(stderr, output.clone())));
    }
    let waited = tokio::time::timeout(STATUS_TIMEOUT, child.wait()).await;
    let Ok(Ok(exit)) = waited else {
        let _ = tree.terminate();
        let _ = child.kill().await;
        return None;
    };
    let _ = tokio::time::timeout(
        Duration::from_secs(1),
        futures_util::future::join_all(pumps.iter_mut()),
    )
    .await;
    pumps.iter().for_each(tokio::task::JoinHandle::abort);
    let text = plain_output(&snapshot(&output));
    Some(
        exit.success()
            && recipe
                .signed_in_regex
                .as_deref()
                .is_none_or(|pattern| Regex::new(pattern).is_ok_and(|re| re.is_match(&text))),
    )
}

/// The inventory's sign-in observation for an installed preset.
pub(crate) async fn inventory_state(preset: &AgentPreset) -> Option<&'static str> {
    preset
        .management
        .as_ref()?
        .login
        .as_ref()?
        .status
        .as_ref()?;
    Some(match status(preset).await {
        Some(true) => "signed_in",
        Some(false) => "signed_out",
        None => "unknown",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use xmatrix_cli_agent::agent_preset_by_id;

    fn login(id: &str) -> &'static HarnessLogin {
        agent_preset_by_id(id)
            .and_then(|preset| preset.management.as_ref()?.login.as_ref())
            .unwrap_or_else(|| panic!("{id} has a sign-in"))
    }

    #[test]
    fn codex_device_code_is_read_through_ansi_colors() {
        let output = b"Follow these steps to sign in with ChatGPT using device code authorization:\n\n\
1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n\
2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mI3YY-8QZ91\x1b[0m\n";
        let text = plain_output(output);
        assert_eq!(
            prompt(login("codex"), &text),
            Some((
                "https://auth.openai.com/codex/device".to_string(),
                Some("I3YY-8QZ91".to_string())
            ))
        );
        // Half the output is not a prompt yet.
        let partial = plain_output(&output[..output.len() / 2]);
        assert_eq!(prompt(login("codex"), &partial), None);
    }

    #[test]
    fn claude_paste_code_url_is_read_without_a_code() {
        let text = plain_output(
            "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=U8\nPaste code here if prompted > ".as_bytes(),
        );
        let (url, code) = prompt(login("claude"), &text).unwrap();
        assert_eq!(
            url,
            "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=U8"
        );
        assert_eq!(code, None);
        assert_eq!(login("claude").flow, LoginFlow::UrlPasteCode);
    }

    #[test]
    fn acp_harness_device_sign_ins_are_read_from_their_real_output() {
        // Captured from each CLI's sign-in with no terminal and no browser.
        for (id, output, url, code) in [
            (
                "qoder",
                "Starting browser login...\n\nPlease open the following URL in your browser to sign in:\n\n  https://qoder.com/device/selectAccounts?challenge=ySHQ&challenge_method=S256\n\nWaiting for browser authorization...\n",
                "https://qoder.com/device/selectAccounts?challenge=ySHQ&challenge_method=S256",
                None,
            ),
            (
                "cline",
                "[auth] Enter this code in your browser: VXJH-ZKMH\n[auth] https://authkit.cline.bot/device?user_code=VXJH-ZKMH\n[auth] Could not open browser automatically; open the URL above manually.\n",
                "https://authkit.cline.bot/device?user_code=VXJH-ZKMH",
                Some("VXJH-ZKMH"),
            ),
            (
                "kilo",
                "\u{250c}  Add credential\n\u{2502}\n\u{25cf}  Go to: https://app.kilo.ai/device-auth?code=V2YJ-KXLA\n\u{2502}\n\u{25cf}  Open https://app.kilo.ai/device-auth?code=V2YJ-KXLA and enter code: V2YJ-KXLA\n\u{25d2}  Waiting for authorization",
                "https://app.kilo.ai/device-auth?code=V2YJ-KXLA",
                Some("V2YJ-KXLA"),
            ),
            (
                "jcode",
                "Jcode Account Login\n  Opening the secure account approval page:\n  https://jcode.sh/account?flow=c6578cb7-4fc5-4dff-aa1b-095c2818c5d1\n  Waiting for browser approval. Press Ctrl-C to cancel...\n",
                "https://jcode.sh/account?flow=c6578cb7-4fc5-4dff-aa1b-095c2818c5d1",
                None,
            ),
        ] {
            let text = plain_output(output.as_bytes());
            assert_eq!(
                prompt(login(id), &text),
                Some((url.to_string(), code.map(str::to_string))),
                "{id}"
            );
            assert_eq!(login(id).flow, LoginFlow::DeviceCode, "{id}");
        }
    }

    #[test]
    fn paste_code_sign_ins_are_read_from_their_real_output() {
        // Devin's prompt reads only from a terminal; omp reads the code or the
        // full redirect URL from stdin.
        let devin = plain_output(
            "Visit https://app.devin.ai/auth/cli/continue?state=ef17&code_challenge=VHQS to sign in, then copy the code and paste it below.\n\nCode:\n\u{276d} Paste the code from the sign-in page\n".as_bytes(),
        );
        assert_eq!(
            prompt(login("devin"), &devin),
            Some((
                "https://app.devin.ai/auth/cli/continue?state=ef17&code_challenge=VHQS".to_string(),
                None
            ))
        );
        assert!(login("devin").terminal);
        let omp = plain_output(
            "Open this URL in your browser:\nhttps://auth.openai.com/oauth/authorize?client_id=app_E&response_type=code\nLocal shortcut (this machine only): http://localhost:1455/launch\nPaste the authorization code (or full redirect URL): ".as_bytes(),
        );
        assert_eq!(
            prompt(login("omp"), &omp),
            Some((
                "https://auth.openai.com/oauth/authorize?client_id=app_E&response_type=code"
                    .to_string(),
                None
            ))
        );
        assert!(!login("omp").terminal);
        for id in ["devin", "omp"] {
            assert_eq!(login(id).flow, LoginFlow::UrlPasteCode, "{id}");
        }
    }

    /// A sign-in whose prompt refuses a pipe runs in a terminal: it sees one,
    /// prints its link, and reads the pasted code as a typed line.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_terminal_sign_in_reads_the_pasted_code_as_a_typed_line() {
        let login: HarnessLogin = serde_json::from_value(serde_json::json!({
            "flow": "url_paste_code",
            "terminal": true,
            "start": { "command": "sh", "args": [
                "-c",
                "test -t 0 || exit 3; echo 'Visit https://sign.example/in to sign in'; read code; echo \"got:$code\"; exit 0"
            ] },
            "urlRegex": "Visit (https://\\S+)"
        }))
        .unwrap();
        let output = Arc::new(Mutex::new(Vec::new()));
        let (exit_tx, mut exited) = watch::channel(None);
        let (_stop, stopped) = oneshot::channel::<()>();
        let mut input = spawn_in_terminal(
            std::path::Path::new("/bin/sh"),
            &login,
            output.clone(),
            exit_tx,
            stopped,
        )
        .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while prompt(&login, &plain_output(&snapshot(&output))).is_none() {
            assert!(tokio::time::Instant::now() < deadline, "no link printed");
            tokio::time::sleep(POLL).await;
        }
        input.send_line("abc-123").await.unwrap();
        let code = tokio::time::timeout(Duration::from_secs(10), exited.wait_for(Option::is_some))
            .await
            .unwrap()
            .map(|value| *value)
            .unwrap();
        assert_eq!(code, Some(Some(0)));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !plain_output(&snapshot(&output)).contains("got:abc-123") {
            assert!(tokio::time::Instant::now() < deadline, "code not read");
            tokio::time::sleep(POLL).await;
        }
    }

    #[test]
    fn only_https_urls_are_offered() {
        let mut login = login("claude").clone();
        login.url_regex = r"visit: (\S+)".into();
        assert_eq!(prompt(&login, "visit: http://evil.example/"), None);
        assert_eq!(prompt(&login, "visit: javascript:alert(1)"), None);
    }

    #[tokio::test]
    async fn presets_without_a_sign_in_are_unsupported() {
        for id in ["custom", "no-such-harness"] {
            let answer = execute(id, HarnessAction::LoginStart, None).await;
            assert_eq!(answer.status, HarnessActionStatus::Unsupported, "{id}");
            assert!(answer.login.is_none());
        }
    }

    /// Runs the installed harness's real sign-in up to its prompt. Point its
    /// config at a throwaway directory first (CODEX_HOME, CLAUDE_CONFIG_DIR).
    #[tokio::test]
    #[ignore = "runs an installed harness"]
    async fn live_sign_in_reaches_its_prompt_and_cancels() {
        let id = std::env::var("XMATRIX_LIVE_LOGIN_PRESET").unwrap_or_else(|_| "codex".into());
        let started = execute(&id, HarnessAction::LoginStart, None).await;
        eprintln!("{started:#?}");
        let login = started.login.expect("progress");
        assert_eq!(login.state, HarnessLoginState::AwaitingUser);
        assert!(login.verification_uri.unwrap().starts_with("https://"));
        if login.flow.as_deref() == Some("url_paste_code") {
            // A wrong code ends the sign-in as failed instead of hanging.
            let wrong = execute(&id, HarnessAction::LoginFinish, Some("not-a-real-code")).await;
            eprintln!("{wrong:#?}");
            assert_eq!(wrong.status, HarnessActionStatus::Failed);
            // A harness that reports the refusal keeps its sign-in waiting;
            // one that exits on it (devin, omp) ends it as failed.
            let state = wrong.login.unwrap().state;
            if state == HarnessLoginState::AwaitingUser {
                let cancelled = execute(&id, HarnessAction::LoginCancel, None).await;
                assert_eq!(cancelled.login.unwrap().state, HarnessLoginState::Cancelled);
            } else {
                assert_eq!(state, HarnessLoginState::Failed);
            }
            return;
        }
        let cancelled = execute(&id, HarnessAction::LoginCancel, None).await;
        assert_eq!(cancelled.login.unwrap().state, HarnessLoginState::Cancelled);
    }

    #[test]
    fn every_registry_sign_in_compiles() {
        for preset in xmatrix_cli_agent::agent_presets() {
            let Some(login) = preset.management.as_ref().and_then(|m| m.login.as_ref()) else {
                continue;
            };
            Regex::new(&login.url_regex).unwrap_or_else(|_| panic!("{} url", preset.id));
            if let Some(code) = &login.code_regex {
                Regex::new(code).unwrap_or_else(|_| panic!("{} code", preset.id));
            }
            // A paste flow reads its code from the owner; a device flow may
            // carry its code inside the URL instead of printing it.
            assert!(
                login.flow == LoginFlow::DeviceCode || login.code_regex.is_none(),
                "{}",
                preset.id
            );
            assert!(
                login.start.command == preset.runtime
                    || preset.launcher_names.contains(&login.start.command),
                "{}: a sign-in runs the harness's own launcher",
                preset.id
            );
            if let Some(pattern) = login
                .status
                .as_ref()
                .and_then(|s| s.signed_in_regex.as_ref())
            {
                Regex::new(pattern).unwrap_or_else(|_| panic!("{} status", preset.id));
            }
        }
    }
}
