async fn inject_remote_submission(
    pty_writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    downstream_kkp_flags: &Arc<AtomicU32>,
    text: &str,
) {
    let debug_injection = std::env::var("XMATRIX_DEBUG_INJECTION")
        .map(|v| v == "1")
        .unwrap_or(false);

    let flags = downstream_kkp_flags.load(Ordering::Relaxed);
    let enter = encode_submission_enter(flags);
    let plain_submission = env_flag("XMATRIX_PLAIN_SUBMISSION");

    if debug_injection {
        eprintln!(
            "[xmatrix-debug] inject_remote_submission bytes={} kkp_flags={} enter={:?} preview={:?}",
            text.len(),
            flags,
            enter,
            text.chars().take(80).collect::<String>()
        );
    }

    if plain_submission {
        if let Ok(mut w) = pty_writer.lock() {
            let _ = w.write_all(text.as_bytes());
            let _ = w.write_all(enter);
            let _ = w.flush();
        }
        return;
    }

    // Use bracketed paste mode so the target application receives the entire
    // text as a single paste event instead of interpreting each \n as Enter.
    // TUI apps like Claude Code collect the paste into a "[Pasted text]" chip
    // and require a SEPARATE Enter keypress (outside the paste block) to
    // actually submit. Sending Enter inside or immediately after \x1b[201~
    // gets swallowed as part of the paste handler, so we release the lock,
    // sleep briefly, then send Enter as its own keystroke event. On Unix-like
    // PTYs, Codex requests KKP and expects Enter as \x1b[13u. On Windows
    // ConPTY, the same KKP-encoded Enter is not accepted by Codex as submit,
    // so encode_submission_enter keeps remote submission on raw CR there.
    if let Ok(mut w) = pty_writer.lock() {
        let _ = w.write_all(b"\x1b[200~");
        let _ = w.write_all(text.as_bytes());
        let _ = w.write_all(b"\x1b[201~");
        let _ = w.flush();
    }

    tokio::time::sleep(std::time::Duration::from_millis(120)).await;

    if let Ok(mut w) = pty_writer.lock() {
        let _ = w.write_all(enter);
        let _ = w.flush();
    }
}

#[cfg(test)]
fn format_incoming_channel_message(
    channel_label: &str,
    from: &protocol::MessageSender,
    body: &str,
    attachments: Option<&[protocol::ChannelAttachment]>,
) -> String {
    format_incoming_channel_message_delivered_at(
        None,
        IncomingChannelMessage {
            channel_label,
            message_id: None,
            reply_to_message_id: None,
            reply_to: None,
            reply_to_current_agent: false,
            from,
            metadata: None,
            body,
            attachments,
            local_files: None,
        },
    )
}

#[cfg(test)]
fn format_incoming_channel_message_with_local_paths(
    channel_label: &str,
    from: &protocol::MessageSender,
    body: &str,
    attachments: Option<&[protocol::ChannelAttachment]>,
    local_image_paths: Option<&[PathBuf]>,
) -> String {
    let mut files = LocalImageFiles::empty();
    if let (Some(attachments), Some(paths)) = (attachments, local_image_paths) {
        for (attachment, path) in attachments.iter().zip(paths.iter()) {
            files.by_id.insert(attachment.id.clone(), path.clone());
        }
    }
    format_incoming_channel_message_delivered_at(
        None,
        IncomingChannelMessage {
            channel_label,
            message_id: None,
            reply_to_message_id: None,
            reply_to: None,
            reply_to_current_agent: false,
            from,
            metadata: None,
            body,
            attachments,
            local_files: Some(&files),
        },
    )
}

fn format_incoming_channel_message_with_context(
    channel_label: &str,
    message_id: Option<&str>,
    reply_to_message_id: Option<&str>,
    reply_to: Option<&protocol::ChannelReplyContext>,
    reply_to_current_agent: bool,
    from: &protocol::MessageSender,
    metadata: Option<&serde_json::Value>,
    body: &str,
    attachments: Option<&[protocol::ChannelAttachment]>,
    local_files: Option<&LocalImageFiles>,
) -> String {
    format_incoming_channel_message_delivered_at(
        xmatrix_cli_core::instant::now_utc_rfc3339().as_deref(),
        IncomingChannelMessage {
            channel_label,
            message_id,
            reply_to_message_id,
            reply_to,
            reply_to_current_agent,
            from,
            metadata,
            body,
            attachments,
            local_files,
        },
    )
}

struct IncomingChannelMessage<'a> {
    channel_label: &'a str,
    message_id: Option<&'a str>,
    reply_to_message_id: Option<&'a str>,
    reply_to: Option<&'a protocol::ChannelReplyContext>,
    reply_to_current_agent: bool,
    from: &'a protocol::MessageSender,
    metadata: Option<&'a serde_json::Value>,
    body: &'a str,
    attachments: Option<&'a [protocol::ChannelAttachment]>,
    local_files: Option<&'a LocalImageFiles>,
}

fn format_incoming_channel_message_delivered_at(
    delivered_at: Option<&str>,
    message: IncomingChannelMessage<'_>,
) -> String {
    let IncomingChannelMessage {
        channel_label,
        message_id,
        reply_to_message_id,
        reply_to,
        reply_to_current_agent,
        from,
        metadata,
        body,
        attachments,
        local_files,
    } = message;
    let relayed = protocol::cross_channel_reply_source(metadata);
    let mut rendered_body = redact_data_urls(body.trim());
    if let Some(attachments) = attachments.filter(|items| !items.is_empty()) {
        if !rendered_body.is_empty() {
            rendered_body.push_str("\n\n");
        }
        rendered_body.push_str("Attachments:\n");
        for attachment in attachments {
            rendered_body.push_str(&format_attachment_prompt_line(
                attachment,
                local_files.and_then(|files| files.path_for(&attachment.id)),
            ));
        }
    }

    let message_context = match (message_id, reply_to_message_id) {
        (Some(message_id), Some(reply_to_message_id)) => {
            format!(" messageId={message_id} replyToMessageId={reply_to_message_id}")
        }
        (Some(message_id), None) => format!(" messageId={message_id}"),
        (None, Some(reply_to_message_id)) => format!(" replyToMessageId={reply_to_message_id}"),
        (None, None) => String::new(),
    };
    let delivery_context = delivered_at
        .map(|value| format!(" deliveredAt={value}"))
        .unwrap_or_default();
    let reply_context = reply_to
        .map(|reply| {
            let relation = if reply_to_current_agent {
                "replied to your message"
            } else {
                "replied to"
            };
            format!(
                "\nReply context: {} {} [{}] messageId={} preview=\"{}\"\n",
                from.label,
                relation,
                reply.from.label,
                reply.message_id,
                redact_data_urls(reply.body_preview.trim())
            )
        })
        .unwrap_or_default();

    format!(
        "xMatrix channel {}{}{} from {} [{}]{}:{}{}\
\n\n{}",
        channel_label,
        message_context,
        delivery_context,
        from.label,
        relayed
            .as_ref()
            .and_then(|source| source.replier_kind.as_deref())
            .unwrap_or(&from.kind),
        relayed
            .as_ref()
            .map(protocol::CrossChannelReplySource::header_context)
            .unwrap_or_else(|| linked_sender_context(from)),
        reply_context,
        rendered_body.trim(),
        bootstrap::channel_collaboration_policy(channel_label),
    )
}

/// An Agent writing from another Channel is addressed by its ordinal there, so
/// the header says which Channel that ordinal belongs to.
fn linked_sender_context(from: &protocol::MessageSender) -> String {
    from.origin_channel_id
        .as_deref()
        .map(str::trim)
        .filter(|channel| !channel.is_empty())
        .map(|channel| format!(" via Channel {channel}"))
        .unwrap_or_default()
}

fn codex_channel_developer_instructions(channel_id: Option<&str>) -> Option<String> {
    channel_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(bootstrap::channel_collaboration_policy)
}

/// xMatrix's own local slash commands, which must never be forwarded to the
/// underlying agent.
const XMATRIX_LOCAL_SLASH_COMMANDS: &[&str] = &["agent", "channel", "channels"];

fn strip_current_agent_instance_mention_prefix<'a>(
    body: &'a str,
    agent: &protocol::SerializedAgent,
) -> Option<&'a str> {
    let trimmed = body.trim();
    let (mention, rest) = trimmed.split_once(char::is_whitespace)?;
    let mention_body = mention.strip_prefix('@')?;
    let (agent_name, suffix) = mention_body.rsplit_once(':')?;
    if agent_name.is_empty()
        || suffix.is_empty()
        || !agent_name.eq_ignore_ascii_case(agent.name.as_str())
    {
        return None;
    }
    let command = rest.trim_start();
    if command.is_empty() {
        None
    } else {
        Some(command)
    }
}

/// When an inbound channel message is an instance-targeted slash command (e.g.
/// `@codex:1 /goal <condition>`, `@claude:2 /compact`, `@codex:new /model ...`),
/// return the slash command verbatim so it can be passed straight through to the
/// underlying agent (Claude Code, Codex, ...) instead of being wrapped in
/// xMatrix channel context.
///
/// The downstream agents only recognize a slash command when it is the
/// leading token of the prompt, so the channel-context preamble would
/// otherwise reduce it to plain text. Returns `None` for bare slash commands,
/// ordinary prose, xMatrix's own local commands, and anything that does not
/// look like a clean instance-addressed slash command (so bare `@agent`
/// mentions, absolute paths like `/usr/bin`, comments like `/* ... */`, and
/// bare slashes keep their normal channel context).
fn slash_command_passthrough<'a>(
    body: &'a str,
    agent: &protocol::SerializedAgent,
) -> Option<&'a str> {
    let trimmed = strip_current_agent_instance_mention_prefix(body, agent)?;
    let rest = trimmed.strip_prefix('/')?;
    // The first character after '/' must start a command name.
    if !rest.chars().next()?.is_ascii_alphabetic() {
        return None;
    }
    let name = rest.split(char::is_whitespace).next().unwrap_or("");
    // A command name never contains a path separator; this keeps absolute
    // paths such as "/usr/local/bin" from being treated as commands.
    if name.is_empty() || name.contains('/') {
        return None;
    }
    if XMATRIX_LOCAL_SLASH_COMMANDS.contains(&name) {
        return None;
    }
    Some(trimmed)
}

/// True when an inbound message is an attachment-free instance-directed
/// slash command, i.e. it would fire [`slash_command_passthrough`] if it
/// were delivered as the sole message of its batch. Used both by
/// [`single_message_slash_passthrough`] and by the inbound drain, which
/// keeps such messages out of multi-message batches so the passthrough
/// condition actually holds (#569).
fn is_instance_slash_passthrough_message(
    message: &InboundChannelMessage,
    agent: &protocol::SerializedAgent,
) -> bool {
    if message
        .attachments
        .as_deref()
        .is_some_and(|items| !items.is_empty())
    {
        return false;
    }
    slash_command_passthrough(&message.body, agent).is_some()
}

/// Returns the verbatim slash command when a delivered batch consists of
/// exactly one attachment-free message that is a bare slash command (see
/// [`slash_command_passthrough`]). Batched or attachment-bearing messages
/// keep their normal channel context so nothing is lost.
fn single_message_slash_passthrough(
    messages: &[InboundChannelMessage],
    agent: &protocol::SerializedAgent,
) -> Option<String> {
    let [single] = messages else {
        return None;
    };
    if !is_instance_slash_passthrough_message(single, agent) {
        return None;
    }
    slash_command_passthrough(&single.body, agent).map(str::to_string)
}

/// All native adapters share the attachment-free, instance-addressed boundary.
pub(crate) fn single_message_parameter_control(
    messages: &[InboundChannelMessage],
    agent: &protocol::SerializedAgent,
) -> Option<crate::harness_parameters::ParameterCommand> {
    crate::harness_parameters::command(&single_message_slash_passthrough(messages, agent)?)
}

fn reply_to_current_agent(
    reply_to: Option<&protocol::ChannelReplyContext>,
    agent: &protocol::SerializedAgent,
) -> bool {
    let Some(reply_to) = reply_to else {
        return false;
    };
    if reply_to.from.kind != "agent" {
        return false;
    }
    reply_to.from.identity_id.as_deref() == Some(agent.id.as_str())
        || agent
            .instance_id
            .as_deref()
            .is_some_and(|instance_id| reply_to.from.instance_id.as_deref() == Some(instance_id))
}

struct DaemonRunRequestScope {
    url: String,
    capability: String,
    run_id: String,
    execution_key: String,
}

fn own_daemon_run_request_scope() -> error::Result<DaemonRunRequestScope> {
    let (url, capability) = local_daemon_request_agent_env().ok_or_else(|| {
        CliError::Launch("daemon request broker environment is not available".into())
    })?;
    let run_id = std::env::var("XMATRIX_RUN_ID")
        .map_err(|_| CliError::Launch("XMATRIX_RUN_ID is not set".into()))?;
    let execution_key = std::env::var("XMATRIX_EXECUTION_KEY")
        .map_err(|_| CliError::Launch("XMATRIX_EXECUTION_KEY is not set".into()))?;
    Ok(DaemonRunRequestScope {
        url,
        capability,
        run_id,
        execution_key,
    })
}

/// Tells the local daemon that this run continues under the replacement
/// wrapper pid, keeping the run registered (and its auth/request capabilities
/// valid) across the live-update handoff. Authenticated with the run's own
/// request capability. The channel handoff fails closed if this is unavailable;
/// the local Unix self-update path can still warn and roll back to its old pid.
async fn rebind_own_daemon_run(new_pid: u32) -> error::Result<()> {
    let DaemonRunRequestScope {
        url,
        capability,
        run_id,
        execution_key,
    } = own_daemon_run_request_scope()?;
    let _: Value = request_local_daemon_request_json_with_rediscovery(
        &url,
        &capability,
        "POST",
        "/request/rebind-run",
        Some(serde_json::json!({
            "runId": run_id,
            "executionKey": execution_key,
            "newPid": new_pid,
        })),
    )
    .await?;
    Ok(())
}

/// The replacement a version handoff waits on. On Unix it is this command's
/// own child; on Windows the daemon starts it, so only its pid is known here.
struct HandoffReplacement {
    pid: u32,
    child: Option<std::process::Child>,
}

impl HandoffReplacement {
    fn exited(&mut self) -> Option<String> {
        match self.child.as_mut() {
            Some(child) => child
                .try_wait()
                .ok()
                .flatten()
                .map(|status| format!("it exited with {status}")),
            None => (!process_tree::process_alive(self.pid)).then(|| "it exited".to_string()),
        }
    }

    fn stop(&mut self) {
        let _ = process_tree::terminate_single_process(self.pid);
        if let Some(child) = self.child.as_mut() {
            let _ = child.try_wait();
        }
    }
}

/// The run's original assignment, which a handoff replacement must not run a
/// second time.
const HANDOFF_REPLACEMENT_REMOVED_ENV: [&str; 4] = [
    "XMATRIX_INITIAL_MESSAGE",
    "XMATRIX_INITIAL_MESSAGE_ID",
    "XMATRIX_INITIAL_MESSAGE_ATTACHMENTS_FILE",
    "XMATRIX_INITIAL_MESSAGE_ATTACHMENTS_JSON",
];

/// Starts the replacement wrapper from this CLI. It resumes the provider
/// session under the inherited resume key without replaying the original
/// assignment. The runtime supplies a recovery turn to reconcile unfinished
/// work; completed work does not produce an unsolicited channel reply.
#[cfg(not(windows))]
async fn spawn_handoff_replacement(
    wrapper_args: &[String],
    channel_id: &str,
    sidecar: Option<&PersistedDaemonRun>,
    handoff_log_path: &Option<PathBuf>,
) -> error::Result<HandoffReplacement> {
    let spawn_exe = installed_wrapper_path(std::env::current_exe().map_err(|err| {
        CliError::Launch(format!(
            "Could not locate the xMatrix CLI executable: {err}"
        ))
    })?);
    let mut command = std::process::Command::new(&spawn_exe);
    command
        .args(wrapper_args)
        .env("XMATRIX_AUTO_JOIN_CHANNEL_ID", channel_id)
        .env("XMATRIX_RESUME_REQUESTED", "1")
        .stdin(Stdio::null());
    for key in HANDOFF_REPLACEMENT_REMOVED_ENV {
        command.env_remove(key);
    }
    // A replacement that dies during startup used to leave nothing behind
    // to diagnose, because both streams went to /dev/null. Keep them.
    match update_self_handoff_log(handoff_log_path) {
        Some((out, err)) => {
            command.stdout(out).stderr(err);
        }
        None => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    if let Some(cwd) = sidecar.and_then(|run| run.cwd.clone()) {
        command.current_dir(cwd);
    }
    if let Some(instance_id) = sidecar.and_then(|run| run.instance_id.clone()) {
        command.env("XMATRIX_RESUME_INSTANCE_ID", instance_id);
    }
    // The old wrapper tears down its child process tree (which includes this
    // command) on shutdown; a fresh session keeps the replacement out of that
    // blast radius.
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|err| {
        CliError::Launch(format!(
            "Failed to start replacement wrapper from {}: {err}",
            spawn_exe.display()
        ))
    })?;
    let pid = child.id();
    // Rebind before waiting: the status file is owned by whichever pid the
    // sidecar records, so the replacement cannot stamp its own readiness until
    // the registration points at it. This also carries run-scoped CLI
    // authority (`xmatrix send` / `request`) across the handoff.
    if let Err(err) = rebind_own_daemon_run(pid).await {
        let _ = process_tree::terminate_single_process(pid);
        let _ = child.try_wait();
        return Err(CliError::Launch(format!(
            "Replacement started but the daemon run could not be rebound: {err}"
        )));
    }
    Ok(HandoffReplacement {
        pid,
        child: Some(child),
    })
}

/// A Windows wrapper and everything it starts share its kill-on-close Job, so
/// a replacement it started would die with it; and a wrapper serves only once
/// the daemon has admitted it through the adoption handshake. So the daemon
/// starts the replacement: this CLI, with the wrapper's arguments and
/// environment, admitted and rebound to the run before the daemon answers.
#[cfg(windows)]
async fn spawn_handoff_replacement(
    wrapper_args: &[String],
    channel_id: &str,
    _sidecar: Option<&PersistedDaemonRun>,
    _handoff_log_path: &Option<PathBuf>,
) -> error::Result<HandoffReplacement> {
    let DaemonRunRequestScope {
        url,
        capability,
        run_id,
        execution_key,
    } = own_daemon_run_request_scope()?;
    let mut env = std::env::vars()
        .filter(|(key, _)| !HANDOFF_REPLACEMENT_REMOVED_ENV.contains(&key.as_str()))
        .collect::<BTreeMap<_, _>>();
    env.insert(
        "XMATRIX_AUTO_JOIN_CHANNEL_ID".to_string(),
        channel_id.to_string(),
    );
    let response: Value = request_local_daemon_request_json_with_rediscovery(
        &url,
        &capability,
        "POST",
        "/request/handoff-run",
        Some(serde_json::json!({
            "runId": run_id,
            "executionKey": execution_key,
            "args": wrapper_args,
            "env": env,
        })),
    )
    .await?;
    let pid = response
        .get("newPid")
        .and_then(Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok())
        .ok_or_else(|| CliError::Launch("daemon handoff returned no replacement pid".into()))?;
    Ok(HandoffReplacement { pid, child: None })
}

/// Internal: a daemon-managed wrapper runs this when its daemon asks it to move
/// to the daemon's CLI version (`spawn_daemon_handoff_request_watch`). It hands
/// the run to the CLI this command runs as: the replacement resumes the
/// provider session with nothing prompted, the daemon registration moves to
/// it, and the old wrapper is retired only once the replacement serves its
/// channel. Any failure leaves the old wrapper serving. A busy run is refused;
/// the daemon asks again once the run is idle.
async fn cmd_update_self() -> error::Result<()> {
    if !xmatrix_cli_channel::running_inside_agent_execution_context() {
        return Err(CliError::Launch(
            "`xmatrix update-self` only runs inside a daemon-managed agent run; the daemon \
             starts it when the run is due for a version handoff."
                .into(),
        ));
    }
    let status_path = std::env::var_os("XMATRIX_RUN_STATUS_FILE")
        .map(PathBuf::from)
        .ok_or_else(|| {
            CliError::Launch(
                "XMATRIX_RUN_STATUS_FILE is not set; this shell does not belong to a managed \
                 agent run."
                    .into(),
            )
        })?;
    let marker = read_daemon_run_status_marker(Some(&status_path)).ok_or_else(|| {
        CliError::Launch("The agent run status file is missing or unreadable.".into())
    })?;
    let (Some(wrapper_args), Some(wrapper_version)) =
        (marker.wrapper_args.clone(), marker.wrapper_version.clone())
    else {
        return Err(CliError::Launch(
            "This wrapper has not recorded its respawn recipe.".into(),
        ));
    };
    // Self-scope guarantee: the recorded wrapper must be this process's own
    // managed ancestor — a run may hand off itself and nothing else.
    let ancestor_pid = xmatrix_cli_channel::persisted_daemon_agent_run_ancestor_pid();
    if ancestor_pid != Some(marker.pid) {
        return Err(CliError::Launch(format!(
            "Refusing to hand off: the run status file records wrapper pid {} but this \
             process's managed wrapper ancestor is {}.",
            marker.pid,
            ancestor_pid
                .map(|pid| pid.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        )));
    }
    if !process_tree::process_alive(marker.pid) {
        return Err(CliError::Launch(format!(
            "Refusing to hand off: recorded wrapper pid {} is not alive.",
            marker.pid
        )));
    }
    if !IDLE_RUN_PHASES.contains(&marker.phase.as_str()) {
        return Err(CliError::Launch(format!(
            "Refusing to hand off while the run is in {}; the daemon asks again once it is idle.",
            marker.phase
        )));
    }
    let target_version = xmatrix_cli_core::version::current();
    if wrapper_version == target_version {
        println!(
            "{} The wrapper already runs {}; nothing to hand off.",
            "✓".green().bold(),
            wrapper_version
        );
        return Ok(());
    }
    let channel_id = non_empty_env("XMATRIX_AUTO_JOIN_CHANNEL_ID").ok_or_else(|| {
        CliError::Launch(
            "XMATRIX_AUTO_JOIN_CHANNEL_ID is not set; the replacement wrapper would have no \
                 channel to rejoin."
                .into(),
        )
    })?;
    let sidecar = daemon_run_sidecar_path_for_status(&status_path).and_then(|path| {
        let raw = std::fs::read_to_string(path).ok()?;
        serde_json::from_str::<PersistedDaemonRun>(&raw).ok()
    });

    println!(
        "{} Handing wrapper {} -> {} for channel {}",
        "○".cyan().bold(),
        wrapper_version,
        target_version,
        channel_id
    );
    // Anchors the readiness check to this handoff so a stale stamp left by the
    // wrapper being replaced cannot be mistaken for the new one's.
    let handoff_started_millis = unix_millis_now();
    let handoff_log_path = update_self_handoff_log_path(marker.pid);
    let mut replacement = spawn_handoff_replacement(
        &wrapper_args,
        &channel_id,
        sidecar.as_ref(),
        &handoff_log_path,
    )
    .await?;

    // Wait for the replacement to prove it is serving — registered with the
    // Hub and back in its channel — before retiring a wrapper that works.
    // "Has not exited yet" is not proof: the failure this guards against is a
    // replacement that dies *after* the old wrapper is already gone, which
    // leaves the agent alive but with no way to reach its channel.
    let ready = await_replacement_wrapper_ready(
        &status_path,
        &mut replacement,
        target_version,
        handoff_started_millis,
    )
    .await;
    if let Err(reason) = ready {
        // Fail closed: put the registration back on the wrapper that is still
        // serving, stop the replacement, and keep this run alive.
        if let Err(err) = rebind_own_daemon_run(marker.pid).await {
            eprintln!(
                "{} Failed to restore daemon registration to wrapper pid {}: {err}",
                "⚠".yellow().bold(),
                marker.pid
            );
        }
        replacement.stop();
        return Err(CliError::Launch(format!(
            "Replacement wrapper never became ready ({reason}); left wrapper pid {} running. \
             Startup output: {}",
            marker.pid,
            handoff_log_path
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "not captured".to_string()),
        )));
    }
    // The old wrapper's shutdown takes this command's own process tree down
    // with it, so nothing after this signal is guaranteed to run.
    process_tree::terminate_single_process(marker.pid).map_err(|err| {
        CliError::Launch(format!(
            "Replacement started, but stopping wrapper pid {} failed: {err}",
            marker.pid
        ))
    })?;
    Ok(())
}

fn render_initial_message_attachment_lines(
    attachments: Option<&[protocol::ChannelAttachment]>,
    local_files: &LocalImageFiles,
) -> String {
    let Some(attachments) = attachments.filter(|items| !items.is_empty()) else {
        return String::new();
    };
    let mut out = String::from("\nAttachments from xMatrix chat:\n");
    for attachment in attachments {
        out.push_str(&format_attachment_prompt_line(
            attachment,
            local_files.path_for(&attachment.id),
        ));
    }
    out
}

fn append_local_attachment_prompt_lines(
    text: &str,
    attachments: Option<&[protocol::ChannelAttachment]>,
    local_files: &LocalImageFiles,
) -> String {
    let Some(attachments) = attachments.filter(|items| !items.is_empty()) else {
        return text.to_string();
    };
    if local_files.paths().is_empty() {
        return text.to_string();
    }
    let mut extra = String::new();
    for attachment in attachments {
        if local_files.path_for(&attachment.id).is_none() {
            continue;
        }
        extra.push_str(&format_attachment_prompt_line(
            attachment,
            local_files.path_for(&attachment.id),
        ));
    }
    if extra.is_empty() {
        return text.to_string();
    }
    if text.contains("Attachments:") {
        return text.to_string();
    }
    format!("{text}\n\nAttachments:\n{extra}")
}

fn format_attachment_prompt_line(
    attachment: &protocol::ChannelAttachment,
    local_path: Option<&Path>,
) -> String {
    let kind = if attachment.kind.trim().is_empty() {
        "file"
    } else {
        attachment.kind.as_str()
    };
    let hint = if attachment.kind == "image" {
        " — read this file to view the image"
    } else {
        " — read this file"
    };
    if let Some(path) = local_path {
        format!(
            "- {kind} {} at {} ({} bytes, {}){hint}\n",
            attachment.name,
            path.display(),
            attachment.size,
            attachment.mime_type
        )
    } else if let Some(url) = attachment.url.as_deref().filter(|value| !value.is_empty()) {
        format!(
            "- {kind} {} at {} ({} bytes, {})\n",
            attachment.name, url, attachment.size, attachment.mime_type
        )
    } else {
        format!(
            "- {kind} {} ({} bytes, {})\n",
            attachment.name, attachment.size, attachment.mime_type
        )
    }
}

/// The path a wrapper was installed at. A running wrapper records
/// `current_exe()`, which on Linux reads `/path/xmatrix (deleted)` once an
/// update has atomically replaced the file it started from; that path never
/// exists, so the replacement could not be spawned. The installed file is the
/// same path without the suffix. When even that is gone, this command's own
/// executable is the installed CLI it was just run as.
#[cfg(not(windows))]
pub(crate) fn installed_wrapper_path(recorded: std::path::PathBuf) -> std::path::PathBuf {
    if recorded.exists() {
        return recorded;
    }
    let text = recorded.to_string_lossy();
    if let Some(original) = text.strip_suffix(" (deleted)") {
        let original = std::path::PathBuf::from(original);
        if original.exists() {
            return original;
        }
    }
    std::env::current_exe().unwrap_or(recorded)
}

#[cfg(all(test, not(windows)))]
mod installed_wrapper_path_tests {
    use super::installed_wrapper_path;

    #[test]
    fn a_replaced_wrapper_respawns_from_its_installed_path() {
        let dir = std::env::temp_dir().join(format!("xmatrix-wrapper-path-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let installed = dir.join("xmatrix");
        std::fs::write(&installed, b"new").unwrap();
        let recorded = std::path::PathBuf::from(format!("{} (deleted)", installed.display()));
        assert_eq!(installed_wrapper_path(recorded), installed);
        assert_eq!(installed_wrapper_path(installed.clone()), installed);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_vanished_wrapper_respawns_from_this_cli() {
        let recorded = std::path::PathBuf::from("/nonexistent/xmatrix (deleted)");
        assert_eq!(
            installed_wrapper_path(recorded),
            std::env::current_exe().unwrap()
        );
    }
}
