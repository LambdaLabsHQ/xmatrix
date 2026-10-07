#![deny(warnings)]

mod cross_space_access;
pub use cross_space_access::cmd_access;
mod invocation_diagnostics;
pub use invocation_diagnostics::{cmd_decision_evidence, cmd_diagnose};
mod message_receipt;
pub use message_receipt::cmd_message_receipt;

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use colored::Colorize;
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use xmatrix_cli_args::{ChannelCommand, ChannelVisibilityState, SpaceCommand, WorktreeState};
use xmatrix_cli_core::channel_read_context::{OpenedChannelThread, thread_root_marker};
use xmatrix_cli_core::error::{self, CliError};
use xmatrix_cli_core::hex::sha256_hex;
use xmatrix_cli_core::human_connection::{HumanConnectionClient, HumanConnectionEvent};
use xmatrix_cli_core::protocol::{self, HubRoutes, with_route};
use xmatrix_cli_core::route_key;
use xmatrix_cli_core::text_input::{self, TextRoutes, TextSource};
use xmatrix_cli_core::wire_compat;
use xmatrix_cli_core::{config, http};

mod read_context;
pub use read_context::{ChannelReadContext, load_channel_read_context};

const CHANNEL_FILE_ATTACHMENT_LIMIT: usize = 4;
const CHANNEL_FILE_ATTACHMENT_MAX_BYTES: u64 = 25 * 1024 * 1024;
// Relay authority bounds one channel-history query to 200 enriched rows (older
// Hubs clamp to 50, and any Hub may return fewer under its page byte budget).
// Fetching history is still unbounded from the CLI's perspective, but it must
// advance through this bounded Authority window using its sequence cursor.
const CHANNEL_HISTORY_PAGE_SIZE: usize = 200;
const MAX_AGENT_NAME_LEN: usize = 64;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelHistoryResponse {
    /// Rows stay raw so one row this CLI is too old to read cannot cost the
    /// caller the whole page. See `wire_compat::decode_rows_tolerant`.
    #[serde(default)]
    messages: Vec<serde_json::Value>,
    #[serde(default)]
    has_more: bool,
    #[serde(default)]
    about_input: Option<serde_json::Value>,
}

pub async fn cmd_channels(
    hub_url: &str,
    token: &str,
    space_id: Option<&str>,
    intake: bool,
) -> error::Result<()> {
    #[derive(Deserialize)]
    struct ChannelsResponse {
        channels: Vec<protocol::SerializedChannel>,
    }

    let url = if let Some(space_id) = space_id {
        with_route(
            hub_url,
            &format!(
                "{}?spaceId={}",
                HubRoutes::CHANNELS,
                urlencoding::encode(space_id)
            ),
        )
    } else {
        with_route(hub_url, HubRoutes::CHANNELS)
    };
    let response: ChannelsResponse = http::request_json(&url, "GET", Some(token), None).await?;
    let mut channels = response.channels;
    if intake {
        channels.retain(is_intake);
    }
    if channels.is_empty() {
        println!("No channels available.");
        return Ok(());
    }
    // Conversations are one list, most recently active first; pages say how work is organized.
    channels.sort_by(|left, right| channel_activity(right).cmp(channel_activity(left)));
    print_channel_table(&channels);
    Ok(())
}

/// A conversation an open project's participant started, for the project's triage.
pub fn is_intake(channel: &protocol::SerializedChannel) -> bool {
    channel
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("intakeOf"))
        .is_some_and(|value| value.is_string())
}

/// The Hub advances `updatedAt` with each message, so it orders by activity.
fn channel_activity(channel: &protocol::SerializedChannel) -> &str {
    channel.updated_at.as_str()
}

fn print_channel_table(channels: &[protocol::SerializedChannel]) {
    println!(
        "{:<24} {:<8} {:<9} {:<24} {}",
        "NAME".bold(),
        "MODE".bold(),
        "MESSAGES".bold(),
        "PRESENCE".bold(),
        "ID".bold()
    );

    for channel in channels {
        let label = channel_label(channel);
        let presence = channel_presence_labels(channel);
        println!(
            "{:<24} {:<8} {:<9} {:<24} {}",
            label,
            channel.mode,
            channel.message_count.unwrap_or(0),
            presence,
            channel.id.dimmed()
        );
    }
}

fn resolve_channel_selector<'a>(
    channels: &'a [protocol::SerializedChannel],
    selector: &str,
) -> error::Result<&'a protocol::SerializedChannel> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Err(CliError::Launch("channel root cannot be empty".into()));
    }

    let exact_route_id = channel_exact_route_id(selector);
    let route_token = channel_route_token(selector);
    let mut matches = exact_route_id
        .as_deref()
        .map(|channel_id| {
            channels
                .iter()
                .filter(|channel| channel.id == channel_id)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if matches.is_empty() {
        matches = route_token
            .as_deref()
            .map(|token| {
                channels
                    .iter()
                    .filter(|channel| channel_entity_token(&channel.id) == token)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
    }
    if matches.is_empty() {
        let selector_key = route_key::slug(selector);
        matches = channels
            .iter()
            .filter(|channel| {
                channel.id == selector
                    || channel.id.starts_with(selector)
                    || channel
                        .name
                        .as_deref()
                        .is_some_and(|name| name.eq_ignore_ascii_case(selector))
                    || channel.name.as_deref().is_some_and(|name| {
                        let name_key = route_key::slug(name);
                        selector_key == name_key
                            || selector_key.starts_with(&format!("{name_key}-"))
                    })
            })
            .collect();
    }
    matches.sort_by(|left, right| left.id.cmp(&right.id));
    match matches.as_slice() {
        [channel] => Ok(*channel),
        [] => Err(CliError::Launch(format!(
            "channel root not found: {selector}"
        ))),
        _ => Err(CliError::Launch(format!(
            "channel root is ambiguous: {}",
            matches
                .iter()
                .map(|channel| format!("{} ({})", channel_label(channel), channel.id))
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

async fn resolve_channel_reference(
    hub_url: &str,
    token: &str,
    selector: &str,
) -> error::Result<String> {
    if let Some(channel_id) = channel_exact_route_id(selector) {
        return Ok(channel_id);
    }
    if channel_route_token(selector).is_none() {
        return Ok(selector.trim().to_string());
    }

    #[derive(Deserialize)]
    struct ChannelsResponse {
        channels: Vec<protocol::SerializedChannel>,
    }

    let response: ChannelsResponse = http::request_json(
        &with_route(hub_url, HubRoutes::CHANNELS),
        "GET",
        Some(token),
        None,
    )
    .await?;
    Ok(resolve_channel_selector(&response.channels, selector)?
        .id
        .clone())
}

fn channel_exact_route_id(selector: &str) -> Option<String> {
    route_key::last_segment(selector)?
        .split_once("--")
        .map(|(_, channel_id)| channel_id.trim().to_string())
        .filter(|channel_id| !channel_id.is_empty())
}

fn channel_route_token(selector: &str) -> Option<String> {
    route_key::key_token(&route_key::last_segment(selector)?, 'c')
}

fn channel_entity_token(channel_id: &str) -> String {
    route_key::entity_token('c', channel_id)
}

pub async fn cmd_spaces(hub_url: &str, token: &str) -> error::Result<()> {
    #[derive(Deserialize)]
    struct SpacesResponse {
        spaces: Vec<protocol::SerializedSpace>,
    }

    let response: SpacesResponse = http::request_json(
        &with_route(hub_url, HubRoutes::SPACES),
        "GET",
        Some(token),
        None,
    )
    .await?;

    if response.spaces.is_empty() {
        println!("No spaces available.");
        return Ok(());
    }

    println!(
        "{:<24} {:<8} {:<24} {}",
        "NAME".bold(),
        "ROLE".bold(),
        "MEMBERS".bold(),
        "ID".bold()
    );

    let current_user = config::load_session_for_hub(hub_url)
        .await
        .map(|session| session.user.id);
    for space in &response.spaces {
        let role = current_user
            .as_ref()
            .and_then(|user_id| {
                space
                    .members
                    .iter()
                    .find(|member| &member.user_id == user_id)
                    .map(|member| member.role.as_str())
            })
            .unwrap_or("-");
        println!(
            "{:<24} {:<8} {:<24} {}",
            space.name,
            role,
            space.members.len(),
            space.id.dimmed()
        );
    }

    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpaceDeletion {
    space_id: String,
    #[serde(default)]
    space_name: String,
    purge_after: String,
}

/// The Space named, or the Space of the conversation this Run works in.
async fn space_or_run_space(
    hub_url: &str,
    token: &str,
    space_id: Option<String>,
) -> error::Result<String> {
    if let Some(space_id) = space_id.filter(|value| !value.trim().is_empty()) {
        return xmatrix_cli_core::space_ref::resolve_space_ref(hub_url, token, &space_id).await;
    }
    let Some(conversation) = std::env::var("XMATRIX_AUTO_JOIN_CHANNEL_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
    else {
        return Err(CliError::Launch(
            "pass <space-id> (outside a Run there is no conversation to resolve it from)".into(),
        ));
    };
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PageSpace {
        space_id: String,
    }
    let route = format!(
        "/api/channels/{}/page-space",
        urlencoding::encode(&conversation)
    );
    let response: PageSpace =
        http::request_json(&with_route(hub_url, &route), "GET", Some(token), None).await?;
    Ok(response.space_id)
}

pub async fn cmd_space(hub_url: &str, token: &str, command: SpaceCommand) -> error::Result<()> {
    match command {
        SpaceCommand::LaunchTargets { space_id } => {
            let space_id = space_or_run_space(hub_url, token, space_id).await?;
            let route = format!(
                "/api/spaces/{}/launch-targets",
                urlencoding::encode(&space_id)
            );
            let value: serde_json::Value =
                http::request_json(&with_route(hub_url, &route), "GET", Some(token), None).await?;
            println!("{}", serde_json::to_string_pretty(&value)?);
            Ok(())
        }
        SpaceCommand::Create { name } => {
            let space_name = name.join(" ").trim().to_string();
            if space_name.is_empty() {
                return Err(CliError::Launch("Space name cannot be empty".into()));
            }
            #[derive(Deserialize)]
            struct SpaceResponse {
                space: protocol::SerializedSpace,
            }
            let response: SpaceResponse = http::request_json(
                &with_route(hub_url, HubRoutes::SPACES),
                "POST",
                Some(token),
                Some(serde_json::json!({ "name": space_name })),
            )
            .await?;
            println!(
                "{} Created space {} ({})",
                "✓".green().bold(),
                response.space.name,
                response.space.id.dimmed()
            );
            Ok(())
        }
        SpaceCommand::Rename { space_id, name } => {
            let space_name = name.join(" ").trim().to_string();
            if space_name.is_empty() {
                return Err(CliError::Launch("Space name cannot be empty".into()));
            }
            http::request_json::<serde_json::Value>(
                &with_route(
                    hub_url,
                    &format!("/api/spaces/{}", urlencoding::encode(&space_id)),
                ),
                "PATCH",
                Some(token),
                Some(serde_json::json!({ "name": space_name })),
            )
            .await?;
            println!("{} Renamed space {}", "✓".green().bold(), space_id);
            Ok(())
        }
        SpaceCommand::Delete { space_id } => {
            #[derive(Deserialize)]
            struct DeleteResponse {
                deletion: SpaceDeletion,
            }
            let response: DeleteResponse = http::request_json(
                &with_route(
                    hub_url,
                    &format!("/api/spaces/{}", urlencoding::encode(&space_id)),
                ),
                "DELETE",
                Some(token),
                None,
            )
            .await?;
            println!(
                "{} Deleted space {}. It is purged after {}; until then restore it with: xmatrix space restore {}",
                "✓".green().bold(),
                space_id,
                response.deletion.purge_after,
                space_id
            );
            Ok(())
        }
        SpaceCommand::Restore { space_id } => {
            http::request_json::<serde_json::Value>(
                &with_route(
                    hub_url,
                    &format!("/api/spaces/{}/restore", urlencoding::encode(&space_id)),
                ),
                "POST",
                Some(token),
                None,
            )
            .await?;
            println!("{} Restored space {}", "✓".green().bold(), space_id);
            Ok(())
        }
        SpaceCommand::Deletions => {
            #[derive(Deserialize)]
            struct DeletionsResponse {
                deletions: Vec<SpaceDeletion>,
            }
            let response: DeletionsResponse = http::request_json(
                &with_route(hub_url, "/api/space-deletions"),
                "GET",
                Some(token),
                None,
            )
            .await?;
            if response.deletions.is_empty() {
                println!("No deleted spaces can be restored.");
            }
            for deletion in response.deletions {
                println!(
                    "{}  {}  purged after {}",
                    deletion.space_id.dimmed(),
                    deletion.space_name,
                    deletion.purge_after
                );
            }
            Ok(())
        }
        SpaceCommand::AddMember {
            space_id,
            user_id,
            role,
            email,
            name,
        } => {
            let role = role.trim().to_ascii_lowercase();
            if !matches!(role.as_str(), "admin" | "member" | "viewer") {
                return Err(CliError::Launch(
                    "member role must be admin, member, or viewer".into(),
                ));
            }
            http::request_json::<serde_json::Value>(
                &with_route(
                    hub_url,
                    &format!("/api/spaces/{}/members", urlencoding::encode(&space_id)),
                ),
                "POST",
                Some(token),
                Some(serde_json::json!({
                    "userId": user_id,
                    "role": role,
                    "email": email,
                    "name": name,
                })),
            )
            .await?;
            println!("{} Updated space member", "✓".green().bold());
            Ok(())
        }
        SpaceCommand::RemoveMember { space_id, user_id } => {
            http::request_json::<serde_json::Value>(
                &with_route(
                    hub_url,
                    &format!(
                        "/api/spaces/{}/members/{}",
                        urlencoding::encode(&space_id),
                        urlencoding::encode(&user_id)
                    ),
                ),
                "DELETE",
                Some(token),
                None,
            )
            .await?;
            println!("{} Removed space member", "✓".green().bold());
            Ok(())
        }
    }
}

pub async fn cmd_recover_send(
    hub_url: &str,
    token: &str,
    channel: &str,
    message_id: &str,
) -> error::Result<()> {
    message_receipt::validated_message_id(message_id)?;
    let channel = resolve_channel_reference(hub_url, token, channel).await?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Recovered {
        schema_version: u32,
        status: String,
        channel_id: String,
        message_id: String,
        retried: bool,
    }
    let result: Recovered = http::recover_message_send(hub_url, &channel, message_id).await?;
    if result.schema_version != 1
        || result.status != "committed"
        || result.channel_id != channel
        || result.message_id != message_id
    {
        return Err(CliError::Relay(
            "Recovery did not confirm the requested message".into(),
        ));
    }
    println!(
        "{} Message {message_id} publication confirmed",
        "✓".green().bold()
    );
    if !result.retried {
        println!("The existing receipt was recovered.");
    }
    Ok(())
}

pub struct SendOptions<'a> {
    pub message_parts: &'a [String],
    pub attachment_paths: &'a [PathBuf],
    pub read_stdin: bool,
    pub escape_newlines: bool,
    pub message_id: Option<&'a str>,
    pub final_for: Option<&'a str>,
    pub reply_to: Option<&'a str>,
}

pub async fn cmd_send(
    hub_url: &str,
    token: &str,
    channel_id: &str,
    options: SendOptions<'_>,
) -> error::Result<()> {
    let SendOptions {
        message_parts,
        attachment_paths,
        read_stdin,
        escape_newlines,
        message_id,
        final_for,
        reply_to,
    } = options;
    if let Some(id) = final_for
        && uuid::Uuid::parse_str(id)
            .ok()
            .is_none_or(|uuid| uuid.to_string() != id)
    {
        return Err(CliError::Launch(
            "--final-for requires a canonical execution UUID".into(),
        ));
    }
    let client_message_id = match message_id {
        Some(id) => message_receipt::validated_message_id(id)?.to_string(),
        None => uuid::Uuid::new_v4().to_string(),
    };
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PublishedMessage {
        message_id: String,
        channel_id: String,
    }
    #[derive(Deserialize)]
    struct SendOperation {
        #[serde(default, rename = "recoveredFromReceipt")]
        recovered_from_receipt: bool,
    }
    #[derive(Deserialize)]
    struct SendResponse {
        message: PublishedMessage,
        #[serde(default, rename = "sendOperation")]
        send_operation: Option<SendOperation>,
    }

    let message = build_send_message_body(message_parts, read_stdin, escape_newlines).await?;
    let attachments = load_channel_file_attachments(attachment_paths)?;
    if message.is_empty() && attachments.is_empty() {
        return Err(CliError::Launch("Message or --file is required".into()));
    }
    let channel_id = &resolve_channel_reference(hub_url, token, channel_id).await?;

    let sender = AgentSenderIdentity::from_env();
    let has_agent_sender_identity = sender.has_identity();

    // Identity isolation: inside an agent session a send MUST be attributed to the agent. If no
    // agent identity is present, refuse rather than silently posting as the launching user —
    // "I launched you, so you can only send as your own identity."
    let in_agent_session = agent_sender_env_value(&["XMATRIX_AGENT_SESSION"]).is_some();
    let in_daemon_agent_lineage = if has_agent_sender_identity {
        false
    } else {
        process_descends_from_persisted_daemon_agent_run()
    };
    if should_refuse_user_attributed_send_without_agent_identity(
        in_agent_session,
        in_daemon_agent_lineage,
        has_agent_sender_identity,
    ) {
        return Err(CliError::Launch(
            "Agent session: refusing to send as the launching user — no agent identity was \
             available (expected XMATRIX_AGENT_NAME / XMATRIX_RUN_ID / XMATRIX_EXECUTION_KEY)"
                .into(),
        ));
    }
    // Expose the operation identity before any message/attachment network write,
    // including when the later response is lost. Reuse it for receipt lookup.
    if final_for.is_some()
        && (sender.run_id.is_none()
            || sender.execution_key.is_none()
            || sender.instance_id.is_none())
    {
        return Err(CliError::Launch(
            "--final-for requires the authenticated Agent Run session".into(),
        ));
    }
    eprintln!("Sending message {client_message_id}");
    let uploaded = upload_channel_file_attachments(
        hub_url,
        token,
        channel_id,
        &client_message_id,
        attachments,
        has_agent_sender_identity,
    )
    .await?;

    let mut payload = serde_json::Map::new();
    payload.insert("body".into(), serde_json::Value::String(message));
    if let Some(id) = final_for {
        payload.insert(
            "finalReplyExecutionId".into(),
            serde_json::Value::String(id.to_string()),
        );
    }
    if let Some(id) = reply_to {
        payload.insert(
            "replyToMessageId".into(),
            serde_json::Value::String(id.to_string()),
        );
    }
    payload.insert(
        "clientMessageId".into(),
        serde_json::Value::String(client_message_id.clone()),
    );
    for (key, value) in [
        ("senderAgentId", sender.agent_id),
        ("senderAgentName", sender.agent_name),
        ("senderAgentInstanceId", sender.instance_id),
        ("senderRunId", sender.run_id),
        ("senderExecutionKey", sender.execution_key),
    ] {
        if let Some(value) = value {
            payload.insert(key.into(), serde_json::Value::String(value));
        }
    }
    if !uploaded.is_empty() {
        payload.insert(
            "attachments".into(),
            serde_json::Value::Array(uploaded_attachment_bindings(&uploaded)),
        );
    }

    if has_agent_sender_identity {
        xmatrix_cli_core::presentation_barrier::wait_for_current_presentation().await;
    }
    let response: SendResponse = http::request_journaled_message(
        &with_route(
            hub_url,
            &format!("/api/channels/{}/messages", urlencoding::encode(channel_id)),
        ),
        token,
        serde_json::Value::Object(payload),
        has_agent_sender_identity,
    )
    .await?;

    if response.message.message_id != client_message_id
        || response.message.channel_id != *channel_id
    {
        return Err(CliError::Relay(format!(
            "The send response did not confirm message {client_message_id} in the requested Channel"
        )));
    }

    println!(
        "{} Sent to channel {} ({})",
        "✓".green().bold(),
        channel_id,
        response.message.message_id.dimmed()
    );
    if response
        .send_operation
        .as_ref()
        .is_some_and(|operation| operation.recovered_from_receipt)
    {
        println!("The existing receipt was recovered.");
    }

    Ok(())
}

#[derive(Debug)]
pub struct PendingFileAttachment {
    name: String,
    mime_type: String,
    bytes: Vec<u8>,
    content_hash: String,
}

#[derive(Debug)]
struct UploadedMessageAttachment {
    attachment_id: String,
    object_key: String,
    content_hash: String,
    encoded_bytes: u64,
    mime_type: String,
    name: String,
}

impl UploadedMessageAttachment {
    fn binding(&self) -> serde_json::Value {
        serde_json::json!({
            "attachmentId": self.attachment_id,
            "objectKey": self.object_key,
            "contentHash": self.content_hash,
            "encodedBytes": self.encoded_bytes,
            "mimeType": self.mime_type,
            "name": self.name,
        })
    }
}

pub fn load_channel_file_attachments(
    paths: &[PathBuf],
) -> error::Result<Vec<PendingFileAttachment>> {
    if paths.len() > CHANNEL_FILE_ATTACHMENT_LIMIT {
        return Err(CliError::Launch(format!(
            "Send at most {CHANNEL_FILE_ATTACHMENT_LIMIT} files per message"
        )));
    }

    let mut attachments = Vec::with_capacity(paths.len());
    for path in paths {
        let metadata = std::fs::metadata(path)
            .map_err(|err| CliError::Launch(format!("Cannot read {}: {err}", path.display())))?;
        if !metadata.is_file() {
            return Err(CliError::Launch(format!(
                "{} is not a file",
                path.display()
            )));
        }
        let size = metadata.len();
        if size == 0 || size > CHANNEL_FILE_ATTACHMENT_MAX_BYTES {
            return Err(CliError::Launch(format!(
                "{} must be between 1 byte and 25 MiB",
                path.display()
            )));
        }

        let mime_type = channel_file_mime_type(path);
        let bytes = std::fs::read(path)
            .map_err(|err| CliError::Launch(format!("Cannot read {}: {err}", path.display())))?;
        let content_hash = sha256_hex(&bytes);
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("attachment")
            .chars()
            .take(120)
            .collect::<String>();

        attachments.push(PendingFileAttachment {
            name,
            mime_type: mime_type.to_string(),
            bytes,
            content_hash,
        });
    }

    Ok(attachments)
}

#[doc(hidden)]
pub fn load_channel_image_attachments(
    paths: &[PathBuf],
) -> error::Result<Vec<PendingFileAttachment>> {
    load_channel_file_attachments(paths)
}

/// Visibility scope an uploaded attachment object must be registered under.
///
/// Mirrors the Hub's `channelScope`: a closed Channel isolates to
/// `channel:<id>`, an open one rides its Space scope. An unknown mode keeps the
/// old channel-scoped guess so callers that cannot see the Channel at all
/// behave as before.
fn attachment_visibility_scope_id(
    channel_id: &str,
    mode: Option<&str>,
    space_id: Option<&str>,
) -> error::Result<String> {
    match mode {
        Some("closed") | None => Ok(format!("channel:{channel_id}")),
        Some(_) => space_id
            .map(|space_id| format!("space:{space_id}"))
            .ok_or_else(|| CliError::Launch("Channel response omitted its Space identity".into())),
    }
}

fn attachment_upload_final_path(intent_id: &str, visibility_scope_id: &str) -> String {
    format!(
        "/api/relay-v2/private-r2/uploads/{}/scope/{}",
        urlencoding::encode(intent_id),
        urlencoding::encode(visibility_scope_id),
    )
}

async fn upload_channel_file_attachments(
    hub_url: &str,
    token: &str,
    channel_id: &str,
    message_id: &str,
    attachments: Vec<PendingFileAttachment>,
    agent_run: bool,
) -> error::Result<Vec<UploadedMessageAttachment>> {
    #[derive(Deserialize)]
    struct UploadIntentResponse {
        upload: UploadIntentPaths,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct UploadIntentPaths {
        final_path: String,
    }

    #[derive(Deserialize)]
    struct ChannelResponse {
        channel: protocol::SerializedChannel,
    }

    #[derive(Deserialize)]
    struct ChannelsResponse {
        channels: Vec<protocol::SerializedChannel>,
    }

    if attachments.is_empty() {
        return Ok(Vec::new());
    }
    /* The scope has to match what the Hub computes for the message itself
    (relay-authority-domain-commands channelScope), or binding the uploaded object
    fails with "verified canonical attachment ref is unavailable". Agent-run
    principals are not allowed to GET one channel, so they read the same
    mode/Space facts out of the channel list they can GET. */
    let channel = if agent_run {
        let listed: ChannelsResponse = http::request_json(
            &with_route(hub_url, HubRoutes::CHANNELS),
            "GET",
            Some(token),
            None,
        )
        .await?;
        listed
            .channels
            .into_iter()
            .find(|candidate| candidate.id == channel_id)
    } else {
        let response: ChannelResponse = http::request_json(
            &with_route(
                hub_url,
                &format!("/api/channels/{}", urlencoding::encode(channel_id)),
            ),
            "GET",
            Some(token),
            None,
        )
        .await?;
        Some(response.channel)
    };
    let visibility_scope_id = attachment_visibility_scope_id(
        channel_id,
        channel.as_ref().map(|channel| channel.mode.as_str()),
        channel
            .as_ref()
            .and_then(|channel| channel.space_id.as_deref()),
    )?;
    let expires_at = (time::OffsetDateTime::now_utc() + time::Duration::hours(1))
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|error| CliError::Launch(format!("Cannot format upload expiry: {error}")))?;
    let mut uploaded = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        let encoded_bytes = attachment.bytes.len() as u64;
        let intent_id = uuid::Uuid::new_v4().to_string();
        let admitted: UploadIntentResponse = http::request_json(
            &with_route(hub_url, "/api/relay-v2/private-r2/upload-intents"),
            "POST",
            Some(token),
            Some(serde_json::json!({
                "requestId": uuid::Uuid::new_v4().to_string(),
                "intentId": intent_id,
                "visibilityScopeId": visibility_scope_id,
                "contentHash": attachment.content_hash,
                "encodedSize": encoded_bytes,
                "expiresAt": expires_at,
            })),
        )
        .await?;
        let expected_upload_path = attachment_upload_final_path(&intent_id, &visibility_scope_id);
        if admitted.upload.final_path != expected_upload_path {
            return Err(CliError::Launch(
                "Hub returned a noncanonical attachment upload path".into(),
            ));
        }
        http::put_bytes::<serde_json::Value>(
            &with_route(hub_url, &admitted.upload.final_path),
            token,
            &attachment.mime_type,
            &attachment.content_hash,
            attachment.bytes,
        )
        .await?;
        let attachment_id = uuid::Uuid::new_v4().to_string();
        http::request_json::<serde_json::Value>(
            &with_route(hub_url, "/api/relay-v2/private-r2/blob-refs"),
            "POST",
            Some(token),
            Some(serde_json::json!({
                "requestId": uuid::Uuid::new_v4().to_string(),
                "intentId": intent_id,
                "refId": attachment_id,
                "ownerKind": "message_attachment",
                "ownerId": message_id,
                "visibilityScopeId": visibility_scope_id,
            })),
        )
        .await?;
        uploaded.push(UploadedMessageAttachment {
            attachment_id,
            object_key: format!("objects/{}", attachment.content_hash),
            content_hash: attachment.content_hash,
            encoded_bytes,
            mime_type: attachment.mime_type,
            name: attachment.name,
        });
    }
    Ok(uploaded)
}

pub fn channel_image_mime_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("webp") => Some("image/webp"),
        Some("gif") => Some("image/gif"),
        _ => None,
    }
}

pub fn channel_file_mime_type(path: &Path) -> &'static str {
    if let Some(image) = channel_image_mime_type(path) {
        return image;
    }
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("md") | Some("markdown") => "text/markdown",
        Some("txt") | Some("log") => "text/plain",
        Some("json") => "application/json",
        Some("pdf") => "application/pdf",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}

fn uploaded_attachment_bindings(uploaded: &[UploadedMessageAttachment]) -> Vec<serde_json::Value> {
    uploaded
        .iter()
        .map(UploadedMessageAttachment::binding)
        .collect()
}

pub fn agent_sender_env_value(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

struct AgentSenderIdentity {
    agent_name: Option<String>,
    agent_id: Option<String>,
    instance_id: Option<String>,
    run_id: Option<String>,
    execution_key: Option<String>,
}

impl AgentSenderIdentity {
    fn from_env() -> Self {
        Self {
            agent_name: agent_sender_env_value(&[
                "XMATRIX_AGENT_NAME",
                "XMATRIX_AGENT_NAME_OVERRIDE",
            ])
            .filter(|value| value.len() <= MAX_AGENT_NAME_LEN),
            agent_id: agent_sender_env_value(&[
                "XMATRIX_AGENT_ID",
                "XMATRIX_AGENT_IDENTITY_ID_OVERRIDE",
            ]),
            instance_id: agent_sender_env_value(&["XMATRIX_AGENT_INSTANCE_ID"]),
            run_id: agent_sender_env_value(&["XMATRIX_RUN_ID"]),
            execution_key: agent_sender_env_value(&["XMATRIX_EXECUTION_KEY"]),
        }
    }

    fn has_identity(&self) -> bool {
        has_agent_sender_identity(
            self.agent_name.as_deref(),
            self.agent_id.as_deref(),
            self.instance_id.as_deref(),
            self.run_id.as_deref(),
            self.execution_key.as_deref(),
        )
    }
}

fn has_agent_sender_identity(
    sender_agent_name: Option<&str>,
    sender_agent_id: Option<&str>,
    sender_agent_instance_id: Option<&str>,
    sender_run_id: Option<&str>,
    sender_execution_key: Option<&str>,
) -> bool {
    sender_agent_name.is_some()
        || sender_agent_id.is_some()
        || sender_agent_instance_id.is_some()
        || sender_run_id.is_some()
        || sender_execution_key.is_some()
}

fn should_refuse_user_attributed_send_without_agent_identity(
    in_agent_session_env: bool,
    in_daemon_agent_lineage: bool,
    has_agent_sender_identity: bool,
) -> bool {
    !has_agent_sender_identity && (in_agent_session_env || in_daemon_agent_lineage)
}

/// Returns true when the current process is executing inside an xMatrix agent
/// run rather than as an interactive human CLI session.
///
/// This is the credential-isolation gate: an agent shares the launching user's
/// OS account, so any CLI command it runs could otherwise fall back to the
/// user's saved session (`~/.config/xmatrix/config.json`) and act as the human.
/// Detection combines launcher/attribution environment markers with the
/// tamper-resistant daemon-run process lineage, so an agent that deliberately
/// unsets its `XMATRIX_*` environment is still recognized through its parent
/// process chain and cannot silently downgrade to the human credential path.
pub fn running_inside_agent_execution_context() -> bool {
    let in_agent_session = agent_sender_env_value(&["XMATRIX_AGENT_SESSION"]).is_some();
    let has_agent_identity = has_agent_sender_identity(
        agent_sender_env_value(&["XMATRIX_AGENT_NAME", "XMATRIX_AGENT_NAME_OVERRIDE"]).as_deref(),
        agent_sender_env_value(&["XMATRIX_AGENT_ID", "XMATRIX_AGENT_IDENTITY_ID_OVERRIDE"])
            .as_deref(),
        agent_sender_env_value(&["XMATRIX_AGENT_INSTANCE_ID"]).as_deref(),
        agent_sender_env_value(&["XMATRIX_RUN_ID"]).as_deref(),
        agent_sender_env_value(&["XMATRIX_EXECUTION_KEY"]).as_deref(),
    );
    is_agent_execution_context(
        in_agent_session,
        has_agent_identity,
        process_descends_from_persisted_daemon_agent_run(),
    )
}

fn is_agent_execution_context(
    in_agent_session_env: bool,
    has_agent_identity_env: bool,
    in_daemon_agent_lineage: bool,
) -> bool {
    in_agent_session_env || has_agent_identity_env || in_daemon_agent_lineage
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDaemonRunForSendGuard {
    pid: u32,
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    execution_key: Option<String>,
    #[serde(default)]
    status_file_path: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonRunStatusForSendGuard {
    pid: u32,
    updated_at_millis: u64,
}

fn process_descends_from_persisted_daemon_agent_run() -> bool {
    persisted_daemon_agent_run_ancestor_pid().is_some()
}

/// Returns the exact daemon-managed Agent wrapper PID in the current process
/// ancestry. This remains available when a provider strips the inherited
/// `XMATRIX_*` environment from tool subprocesses.
pub fn persisted_daemon_agent_run_ancestor_pid() -> Option<u32> {
    let tracked_pids = persisted_daemon_agent_run_pids();
    if tracked_pids.is_empty() {
        return None;
    }
    #[cfg(windows)]
    {
        let parents = process_parent_ids()?;
        return tracked_ancestor_pid(std::process::id(), &tracked_pids, |pid| {
            parents.get(&pid).copied()
        });
    }
    #[cfg(not(windows))]
    tracked_ancestor_pid(std::process::id(), &tracked_pids, parent_process_id)
}

fn persisted_daemon_agent_run_pids() -> HashSet<u32> {
    let mut runs = read_persisted_daemon_runs_for_send_guard();
    runs.extend(read_persisted_daemon_run_sidecars_for_send_guard());
    runs.into_iter()
        .filter(daemon_run_is_recent_agent_context)
        .map(|run| run.pid)
        .collect()
}

fn read_persisted_daemon_runs_for_send_guard() -> Vec<PersistedDaemonRunForSendGuard> {
    let path = config::profile_state_dir().join("daemon-run-registry.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<PersistedDaemonRunForSendGuard>>(&raw).unwrap_or_default()
}

fn read_persisted_daemon_run_sidecars_for_send_guard() -> Vec<PersistedDaemonRunForSendGuard> {
    let dir = config::daemon_run_log_dir();
    config::daemon_run_sidecar_paths(&dir)
        .filter_map(|path| {
            let raw = std::fs::read_to_string(path).ok()?;
            serde_json::from_str::<PersistedDaemonRunForSendGuard>(&raw).ok()
        })
        .collect()
}

fn daemon_run_is_recent_agent_context(run: &PersistedDaemonRunForSendGuard) -> bool {
    const MAX_DAEMON_RUN_STATUS_AGE_MILLIS: u64 = 7 * 24 * 60 * 60 * 1000;
    if run.run_id.is_none() && run.execution_key.is_none() {
        return false;
    }
    let Some(path) = run.status_file_path.as_deref() else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(marker) = serde_json::from_str::<DaemonRunStatusForSendGuard>(&raw) else {
        return false;
    };
    marker.pid == run.pid
        && unix_millis_now_for_send_guard().saturating_sub(marker.updated_at_millis)
            <= MAX_DAEMON_RUN_STATUS_AGE_MILLIS
}

fn unix_millis_now_for_send_guard() -> u64 {
    config::unix_now_secs().saturating_mul(1000)
}

#[cfg(test)]
fn process_descends_from_tracked_pid(
    current_pid: u32,
    tracked_pids: &HashSet<u32>,
    parent_lookup: impl FnMut(u32) -> Option<u32>,
) -> bool {
    tracked_ancestor_pid(current_pid, tracked_pids, parent_lookup).is_some()
}

fn tracked_ancestor_pid(
    current_pid: u32,
    tracked_pids: &HashSet<u32>,
    mut parent_lookup: impl FnMut(u32) -> Option<u32>,
) -> Option<u32> {
    if tracked_pids.contains(&current_pid) {
        return Some(current_pid);
    }
    let mut seen = HashSet::new();
    let mut pid = current_pid;
    for _ in 0..64 {
        if !seen.insert(pid) {
            return None;
        }
        let parent = parent_lookup(pid)?;
        if parent == 0 || parent == pid {
            return None;
        }
        if tracked_pids.contains(&parent) {
            return Some(parent);
        }
        pid = parent;
    }
    None
}

#[cfg(windows)]
fn process_parent_ids() -> Option<HashMap<u32, u32>> {
    use std::mem::size_of;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };

    let raw_snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if raw_snapshot == INVALID_HANDLE_VALUE {
        return None;
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw_snapshot as RawHandle) };
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    if unsafe { Process32FirstW(snapshot.as_raw_handle() as HANDLE, &mut entry) } == 0 {
        return None;
    }
    let mut parents = HashMap::new();
    loop {
        parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
        if unsafe { Process32NextW(snapshot.as_raw_handle() as HANDLE, &mut entry) } == 0 {
            break;
        }
    }
    Some(parents)
}

#[cfg(unix)]
fn parent_process_id(pid: u32) -> Option<u32> {
    let output = std::process::Command::new("ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<u32>()
        .ok()
}

#[cfg(all(not(unix), not(windows)))]
fn parent_process_id(_pid: u32) -> Option<u32> {
    None
}

pub async fn cmd_channel(hub_url: &str, token: &str, command: ChannelCommand) -> error::Result<()> {
    match command {
        ChannelCommand::Create {
            space,
            mode,
            summary,
            channel_name,
        } => {
            if let Some(summary) = &summary {
                text_input::ensure_text_intact(
                    "channel topic",
                    summary,
                    TextSource::Argument,
                    TextRoutes::default(),
                )?;
            }
            text_input::ensure_text_intact(
                "channel name",
                &channel_name.join(" "),
                TextSource::Argument,
                TextRoutes::default(),
            )?;
            cmd_channel_create(hub_url, token, space, mode, summary, channel_name).await
        }
        ChannelCommand::EditMessage {
            channel_id,
            message_id,
            stdin,
            message,
        } => {
            let body = if stdin {
                text_input::read_stdin_text()?
            } else {
                message.join(" ")
            };
            let source = if stdin {
                TextSource::Stdin
            } else {
                TextSource::Argument
            };
            text_input::ensure_text_intact("message body", &body, source, MESSAGE_TEXT_ROUTES)?;
            let channel_id = resolve_channel_reference(hub_url, token, &channel_id).await?;
            cmd_channel_edit_message(hub_url, token, &channel_id, &message_id, &body).await
        }
        ChannelCommand::React {
            channel_id,
            message_id,
            emoji,
        } => {
            let channel_id = resolve_channel_reference(hub_url, token, &channel_id).await?;
            cmd_channel_react(hub_url, token, &channel_id, &message_id, &emoji).await
        }
        ChannelCommand::DeleteMessage {
            channel_id,
            message_id,
            permanent,
        } => {
            let channel_id = resolve_channel_reference(hub_url, token, &channel_id).await?;
            cmd_channel_delete_message(hub_url, token, &channel_id, &message_id, permanent).await
        }
        ChannelCommand::Join { channel_id, name } => {
            let channel_id = resolve_channel_reference(hub_url, token, &channel_id).await?;
            cmd_channel_join(hub_url, token, &channel_id, name).await
        }
        ChannelCommand::Leave { channel_id } => {
            let channel_id = resolve_channel_reference(hub_url, token, &channel_id).await?;
            cmd_channel_leave(hub_url, token, &channel_id).await
        }
        ChannelCommand::Rename { channel_id, name } => {
            text_input::ensure_text_intact(
                "channel name",
                &name.join(" "),
                TextSource::Argument,
                TextRoutes::default(),
            )?;
            let channel_id = resolve_channel_reference(hub_url, token, &channel_id).await?;
            cmd_channel_rename(hub_url, token, &channel_id, name).await
        }
        ChannelCommand::About {
            channel_id,
            summary,
            summary_file,
            name,
            name_file,
            through,
            expected_revision,
        } => {
            let summary = about_text_input(
                "channel About summary",
                summary,
                summary_file,
                "--summary-file",
            )?
            .unwrap_or_default();
            let name = about_text_input("channel name", name, name_file, "--name-file")?;
            let channel_id = resolve_channel_reference(hub_url, token, &channel_id).await?;
            cmd_channel_about(
                hub_url,
                token,
                &channel_id,
                summary,
                name,
                through,
                expected_revision,
            )
            .await
        }
        ChannelCommand::MetadataHistory {
            channel_id,
            before_revision,
            revision,
            input,
            limit,
        } => {
            let channel_id = resolve_channel_reference(hub_url, token, &channel_id).await?;
            let mut route = format!(
                "/api/channels/{}/metadata-history?limit={limit}",
                urlencoding::encode(&channel_id)
            );
            if let Some(n) = before_revision {
                route.push_str(&format!("&beforeRevision={n}"));
            }
            if let Some(n) = revision {
                route.push_str(&format!("&revision={n}"));
            }
            if let Some(id) = input {
                route.push_str(&format!("&inputId={}", urlencoding::encode(&id)));
            }
            let response: serde_json::Value =
                http::request_json(&with_route(hub_url, &route), "GET", Some(token), None).await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&response).unwrap_or_default()
            );
            Ok(())
        }
        ChannelCommand::MetadataRestore {
            channel_id,
            revision,
            expected_revision,
        } => {
            let channel_id = resolve_channel_reference(hub_url, token, &channel_id).await?;
            let route = format!(
                "/api/channels/{}/metadata-restore",
                urlencoding::encode(&channel_id)
            );
            let response: serde_json::Value = http::request_json(&with_route(hub_url, &route), "POST", Some(token),
                Some(serde_json::json!({ "revision": revision, "expectedRevision": expected_revision }))).await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&response).unwrap_or_default()
            );
            Ok(())
        }
        ChannelCommand::Move {
            channel_id,
            space,
            proposal,
            ack,
            source_space,
        } => {
            if let Some(role) = ack {
                if running_inside_agent_execution_context() {
                    return Err(CliError::Auth("Agents cannot acknowledge transfers. Ask human admins to confirm outbound/inbound in Web.".into()));
                }
                let source = source_space.as_deref().unwrap_or_default();
                let proposal_id = proposal.as_deref().unwrap_or_default();
                let response: serde_json::Value = http::request_json(
                    &with_route(
                        hub_url,
                        &format!(
                            "/api/spaces/{}/channel-transfers/{}/ack",
                            urlencoding::encode(source),
                            urlencoding::encode(proposal_id)
                        ),
                    ),
                    "POST",
                    Some(token),
                    Some(serde_json::json!({ "role": role })),
                )
                .await?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&response).unwrap_or_default()
                );
                return Ok(());
            }
            let channel_id = resolve_channel_reference(hub_url, token, &channel_id).await?;
            let space_id = space.unwrap_or_default();
            let response: serde_json::Value = http::request_json(
                &with_route(
                    hub_url,
                    &format!(
                        "/api/channels/{}/transfer-proposals",
                        urlencoding::encode(&channel_id)
                    ),
                ),
                "POST",
                Some(token),
                Some(serde_json::json!({ "spaceId": space_id })),
            )
            .await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&response).unwrap_or_default()
            );
            println!(
                "Proposal created. Human admins must separately confirm outbound and inbound in Web or with --proposal <id> --source-space <id> --ack <role>. Agents must stop here."
            );
            Ok(())
        }
        ChannelCommand::Visibility { channel_id, state } => {
            let channel_id = resolve_channel_reference(hub_url, token, &channel_id).await?;
            cmd_channel_visibility(hub_url, token, &channel_id, state).await
        }
        ChannelCommand::Worktree { channel_id, state } => {
            let channel_id = resolve_channel_reference(hub_url, token, &channel_id).await?;
            cmd_channel_worktree(hub_url, token, &channel_id, state).await
        }
        ChannelCommand::Send(args) => cmd_send_args(hub_url, token, args).await,
        ChannelCommand::History {
            channel_id,
            authoritative,
        } => {
            let channel_id = resolve_channel_reference(hub_url, token, &channel_id).await?;
            cmd_channel_history(hub_url, token, &channel_id, authoritative).await
        }
        ChannelCommand::Chat { channel_id, limit } => {
            let channel_id = resolve_channel_reference(hub_url, token, &channel_id).await?;
            cmd_channel_chat(hub_url, token, &channel_id, limit).await
        }
    }
}

pub async fn cmd_send_args(
    hub_url: &str,
    token: &str,
    args: xmatrix_cli_args::SendArgs,
) -> error::Result<()> {
    let xmatrix_cli_args::SendArgs {
        channel_id,
        message_id,
        final_for,
        reply_to,
        recover,
        files,
        stdin,
        escape_newlines,
        message,
    } = args;

    if let Some(message_id) = recover {
        return cmd_recover_send(hub_url, token, &channel_id, &message_id).await;
    }
    cmd_send(
        hub_url,
        token,
        &channel_id,
        SendOptions {
            message_parts: &message,
            attachment_paths: &files,
            read_stdin: stdin,
            escape_newlines,
            message_id: message_id.as_deref(),
            final_for: final_for.as_deref(),
            reply_to: reply_to.as_deref(),
        },
    )
    .await
}

/// Message bodies (`send`, `channel edit-message`) can be resent on `--stdin`.
const MESSAGE_TEXT_ROUTES: TextRoutes<'static> = TextRoutes {
    stdin: true,
    file_flag: None,
};

async fn build_send_message_body(
    message_parts: &[String],
    read_stdin: bool,
    escape_newlines: bool,
) -> error::Result<String> {
    let arguments = message_parts.join(" ");
    text_input::ensure_text_intact(
        "message",
        &arguments,
        TextSource::Argument,
        MESSAGE_TEXT_ROUTES,
    )?;
    let mut message = if read_stdin {
        let mut bytes = Vec::new();
        tokio::io::stdin().read_to_end(&mut bytes).await?;
        let input = text_input::decode_utf8_input(bytes, "stdin")?;
        text_input::ensure_text_intact("message", &input, TextSource::Stdin, MESSAGE_TEXT_ROUTES)?;
        if message_parts.is_empty() {
            input
        } else if input.trim().is_empty() {
            arguments
        } else {
            format!("{arguments}\n{input}")
        }
    } else {
        arguments
    };

    if escape_newlines {
        message = decode_send_newline_escapes(&message);
    }

    Ok(message.trim().to_string())
}

fn decode_send_newline_escapes(input: &str) -> String {
    input
        .replace("\\r\\n", "\n")
        .replace("\\n", "\n")
        .replace("\\r", "\n")
}

async fn cmd_channel_create(
    hub_url: &str,
    token: &str,
    space_id: Option<String>,
    mode: String,
    summary: Option<String>,
    channel_name: Vec<String>,
) -> error::Result<()> {
    #[derive(Deserialize)]
    struct CreateResponse {
        channel: protocol::SerializedChannel,
    }

    let mode = mode.trim().to_ascii_lowercase();
    if mode != "open" && mode != "closed" {
        return Err(CliError::Launch(
            "channel mode must be open or closed".into(),
        ));
    }

    let sender = AgentSenderIdentity::from_env();
    let has_agent_sender_identity = sender.has_identity();
    let in_agent_session = agent_sender_env_value(&["XMATRIX_AGENT_SESSION"]).is_some();
    let in_daemon_agent_lineage = if has_agent_sender_identity {
        false
    } else {
        process_descends_from_persisted_daemon_agent_run()
    };
    if should_refuse_user_attributed_send_without_agent_identity(
        in_agent_session,
        in_daemon_agent_lineage,
        has_agent_sender_identity,
    ) {
        return Err(CliError::Launch(
            "Agent session: refusing to create a channel as the launching user — no agent identity was \
             available (expected XMATRIX_AGENT_NAME / XMATRIX_RUN_ID / XMATRIX_EXECUTION_KEY)"
                .into(),
        ));
    }

    let response: CreateResponse = http::request_json(
        &with_route(hub_url, HubRoutes::CHANNELS),
        "POST",
        Some(token),
        Some(channel_create_body(
            channel_name.join(" ").trim(),
            space_id.as_deref(),
            summary.as_deref(),
            &mode,
        )),
    )
    .await?;

    println!(
        "{} Created channel {} ({})",
        "✓".green().bold(),
        channel_label(&response.channel),
        response.channel.id.dimmed()
    );
    Ok(())
}

/// The create request the Hub accepts. The Hub owns the Channel Summary and
/// attributes the creator from the authenticated principal, so neither a
/// `summary` nor caller-claimed sender fields are sent; `--topic` is the
/// caller's description. Without a name it is a new conversation, as the web
/// starts one: xMatrix names it from its first message, which Jev may also
/// read as work for an Agent.
fn channel_create_body(
    name: &str,
    space_id: Option<&str>,
    topic: Option<&str>,
    mode: &str,
) -> serde_json::Value {
    let mut body = if name.is_empty() {
        serde_json::json!({
            "name": "New conversation",
            "mode": mode,
            "metadata": { "createdBy": "cli", "autoName": true },
        })
    } else {
        serde_json::json!({
            "name": name,
            "mode": mode,
            "metadata": { "createdBy": "cli" },
        })
    };
    let fields = [("spaceId", space_id), ("topic", topic)];
    for (key, value) in fields {
        if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
            body[key] = serde_json::Value::String(value.to_string());
        }
    }
    body
}

async fn cmd_channel_edit_message(
    hub_url: &str,
    token: &str,
    channel_id: &str,
    message_id: &str,
    body: &str,
) -> error::Result<()> {
    let body = body.trim();
    if body.is_empty() {
        return Err(CliError::Launch("a new message body is required".into()));
    }
    http::request_json::<serde_json::Value>(
        &with_route(
            hub_url,
            &format!(
                "/api/channels/{}/messages/{}",
                urlencoding::encode(channel_id),
                urlencoding::encode(message_id.trim())
            ),
        ),
        "PATCH",
        Some(token),
        Some(serde_json::json!({ "body": body })),
    )
    .await?;
    println!(
        "{} Edited message {}",
        "✓".green().bold(),
        message_id.dimmed()
    );
    Ok(())
}

async fn cmd_channel_react(
    hub_url: &str,
    token: &str,
    channel_id: &str,
    message_id: &str,
    emoji: &str,
) -> error::Result<()> {
    let emoji = emoji.trim();
    if emoji.is_empty() {
        return Err(CliError::Launch("an emoji is required".into()));
    }
    http::request_json::<serde_json::Value>(
        &with_route(
            hub_url,
            &format!(
                "/api/channels/{}/messages/{}/reactions",
                urlencoding::encode(channel_id),
                urlencoding::encode(message_id.trim())
            ),
        ),
        "POST",
        Some(token),
        Some(serde_json::json!({ "emoji": emoji })),
    )
    .await?;
    println!(
        "{} Toggled {} on message {}",
        "✓".green().bold(),
        emoji,
        message_id.dimmed()
    );
    Ok(())
}

async fn cmd_channel_delete_message(
    hub_url: &str,
    token: &str,
    channel_id: &str,
    message_id: &str,
    permanent: bool,
) -> error::Result<()> {
    let mut route = format!(
        "/api/channels/{}/messages/{}",
        urlencoding::encode(channel_id),
        urlencoding::encode(message_id.trim())
    );
    if permanent {
        route.push_str("?permanent=true");
    }
    http::request_json::<serde_json::Value>(
        &with_route(hub_url, &route),
        "DELETE",
        Some(token),
        None,
    )
    .await?;
    println!(
        "{} {} message {}",
        "✓".green().bold(),
        if permanent { "Deleted" } else { "Recalled" },
        message_id.dimmed()
    );
    Ok(())
}

async fn cmd_channel_join(
    hub_url: &str,
    token: &str,
    channel_id: &str,
    member_name: String,
) -> error::Result<()> {
    let sender = AgentSenderIdentity::from_env();

    http::request_json::<serde_json::Value>(
        &with_route(
            hub_url,
            &format!("/api/channels/{}/join", urlencoding::encode(channel_id)),
        ),
        "POST",
        Some(token),
        Some(serde_json::json!({
            "memberName": member_name,
            "senderAgentId": sender.agent_id,
            "senderAgentName": sender.agent_name,
            "senderAgentInstanceId": sender.instance_id,
            "senderRunId": sender.run_id,
            "senderExecutionKey": sender.execution_key,
        })),
    )
    .await?;

    println!("{} Joined channel {}", "✓".green().bold(), channel_id);
    Ok(())
}

async fn cmd_channel_leave(hub_url: &str, token: &str, channel_id: &str) -> error::Result<()> {
    let response = http::request_json::<serde_json::Value>(
        &with_route(
            hub_url,
            &format!("/api/channels/{}/leave", urlencoding::encode(channel_id)),
        ),
        "POST",
        Some(token),
        None,
    )
    .await?;

    // An Agent run lives in one Channel, so the Hub answers its leave by
    // stopping the run.
    if response
        .get("stopping")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        println!(
            "{} Left channel {}; this Agent run is stopping",
            "✓".green().bold(),
            channel_id
        );
    } else {
        println!("{} Left channel {}", "✓".green().bold(), channel_id);
    }
    Ok(())
}

async fn cmd_channel_rename(
    hub_url: &str,
    token: &str,
    channel_id: &str,
    name: Vec<String>,
) -> error::Result<()> {
    #[derive(Deserialize)]
    struct RenameResponse {
        channel: protocol::SerializedChannel,
    }

    let name = name.join(" ").trim().trim_start_matches('#').to_string();
    if name.is_empty() {
        return Err(CliError::Launch("channel name is required".into()));
    }

    let response: RenameResponse = http::request_json(
        &with_route(
            hub_url,
            &format!("/api/channels/{}", urlencoding::encode(channel_id)),
        ),
        "PATCH",
        Some(token),
        Some(serde_json::json!({ "name": name })),
    )
    .await?;

    println!(
        "{} Renamed channel {} to {}",
        "✓".green().bold(),
        response.channel.id.dimmed(),
        channel_label(&response.channel)
    );
    Ok(())
}

/// One About text field from its argument or its UTF-8 file, refused when the
/// shell's code page already mangled it.
fn about_text_input(
    field: &str,
    argument: Option<String>,
    file: Option<PathBuf>,
    file_flag: &str,
) -> error::Result<Option<String>> {
    let (text, source) = match (argument, file) {
        (_, Some(path)) => (text_input::read_text_file(&path)?, TextSource::File),
        (Some(text), None) => (text, TextSource::Argument),
        (None, None) => return Ok(None),
    };
    let routes = TextRoutes {
        stdin: false,
        file_flag: Some(file_flag),
    };
    text_input::ensure_text_intact(field, &text, source, routes)?;
    Ok(Some(text))
}

/// The channel's own About session saves its summary, and may name a channel
/// nobody has named yet, through the ordinary channel update.
async fn cmd_channel_about(
    hub_url: &str,
    token: &str,
    channel_id: &str,
    summary: String,
    name: Option<String>,
    through: Option<String>,
    expected_revision: Option<u64>,
) -> error::Result<()> {
    #[derive(Deserialize)]
    struct AboutResponse {
        channel: protocol::SerializedChannel,
    }

    let summary = summary.trim().to_string();
    if summary.is_empty() {
        return Err(CliError::Launch("channel About summary is required".into()));
    }
    let mut body = serde_json::json!({ "summary": summary });
    if let Some(revision) = expected_revision {
        body["expectedRevision"] = serde_json::json!(revision);
    }
    if let Some(name) = name.map(|name| name.trim().trim_start_matches('#').to_string())
        && !name.is_empty()
    {
        body["name"] = serde_json::Value::String(name);
    }
    if let Some(through) = through.map(|through| through.trim().to_string())
        && !through.is_empty()
    {
        body["throughMessageId"] = serde_json::Value::String(through);
    }
    let response: AboutResponse = http::request_json(
        &with_route(
            hub_url,
            &format!("/api/channels/{}", urlencoding::encode(channel_id)),
        ),
        "PATCH",
        Some(token),
        Some(body),
    )
    .await?;

    println!(
        "{} Saved the About of {}",
        "✓".green().bold(),
        channel_label(&response.channel)
    );
    Ok(())
}

async fn cmd_channel_visibility(
    hub_url: &str,
    token: &str,
    channel_id: &str,
    state: ChannelVisibilityState,
) -> error::Result<()> {
    #[derive(Deserialize)]
    struct VisibilityResponse {
        channel: protocol::SerializedChannel,
    }

    let (mode, label) = match state {
        ChannelVisibilityState::Public => ("open", "public"),
        ChannelVisibilityState::Private => ("closed", "private"),
    };
    let response: VisibilityResponse = http::request_json(
        &with_route(
            hub_url,
            &format!("/api/channels/{}", urlencoding::encode(channel_id)),
        ),
        "PATCH",
        Some(token),
        Some(serde_json::json!({ "mode": mode })),
    )
    .await?;

    println!(
        "{} Changed channel {} visibility to {}",
        "✓".green().bold(),
        response.channel.id.dimmed(),
        label
    );
    Ok(())
}

async fn cmd_channel_worktree(
    hub_url: &str,
    token: &str,
    channel_id: &str,
    state: WorktreeState,
) -> error::Result<()> {
    #[derive(Deserialize)]
    struct WorktreeResponse {
        channel: protocol::SerializedChannel,
    }

    let mode = match state {
        WorktreeState::On => "isolated",
        WorktreeState::Off => "disabled",
        WorktreeState::Inherit => "inherit-parent",
    };
    let response: WorktreeResponse = http::request_json(
        &with_route(hub_url, &protocol::channel_worktree_route(channel_id)),
        "PATCH",
        Some(token),
        Some(serde_json::json!({ "mode": mode })),
    )
    .await?;

    let label = channel_label(&response.channel);
    let state_label = match state {
        WorktreeState::On => "isolated",
        WorktreeState::Off => "disabled",
        WorktreeState::Inherit => "inheriting the parent channel",
    };
    println!(
        "{} Worktree mode {} for {} ({})",
        "✓".green().bold(),
        state_label,
        label,
        response.channel.id.dimmed()
    );
    Ok(())
}

/// Every message in a channel, oldest first. This is the one history read that
/// covers a channel completely: it pages backwards by sequence, so it also
/// returns the sequence-zero thread root a projection `afterSequence` walk
/// cannot reach.
pub async fn load_full_channel_history(
    hub_url: &str,
    token: &str,
    channel_id: &str,
) -> error::Result<Vec<protocol::ChannelMessage>> {
    // The machine daemon holds a shared validated history cache; when this
    // process was spawned with request-broker access, one broker call replaces
    // the whole walk. Any failure degrades to the direct walk below.
    if let Some((mut messages, repairs, unreadable)) =
        daemon_cached_channel_history(channel_id, token).await
    {
        report_repaired_history(hub_url, &repairs, unreadable).await;
        sort_channel_history(&mut messages);
        return Ok(messages);
    }
    load_authoritative_channel_history(hub_url, token, channel_id).await
}

async fn load_authoritative_channel_history(
    hub_url: &str,
    token: &str,
    channel_id: &str,
) -> error::Result<Vec<protocol::ChannelMessage>> {
    let mut before_sequence: Option<u64> = None;
    let mut messages = Vec::new();
    let mut seen_message_ids = HashSet::new();
    let mut page_repairs: Vec<wire_compat::WireRepair> = Vec::new();
    let mut unreadable_rows = 0usize;
    let mut first_unreadable: Option<String> = None;

    loop {
        let mut route = format!(
            "/api/channels/{}/history?limit={}",
            urlencoding::encode(channel_id),
            CHANNEL_HISTORY_PAGE_SIZE
        );
        if let Some(cursor) = before_sequence {
            route.push_str("&beforeSequence=");
            route.push_str(&cursor.to_string());
        }

        let response: ChannelHistoryResponse =
            http::request_json(&with_route(hub_url, &route), "GET", Some(token), None).await?;
        if let Some(input) = &response.about_input {
            println!("About authoritative input: {input}");
        }
        if response.messages.is_empty() {
            if response.has_more {
                return Err(CliError::Relay(
                    "Channel history reported another page without messages".to_string(),
                ));
            }
            break;
        }

        let (page, repairs, unreadable) =
            wire_compat::decode_rows_tolerant::<protocol::ChannelMessage>(&response.messages);
        page_repairs.extend(repairs);
        unreadable_rows += unreadable.len();
        if let Some(first) = unreadable.first()
            && first_unreadable.is_none()
        {
            first_unreadable = Some(first.clone());
        }
        if page.is_empty() {
            // Every row on this page was unreadable, so pagination has nothing
            // to advance on. Fail rather than silently truncate the history.
            return Err(CliError::Relay(format!(
                "Channel history page could not be read by this xMatrix CLI: {}",
                first_unreadable.unwrap_or_else(|| "unknown payload shape".to_string()),
            )));
        }

        let next_before_sequence = next_history_before_sequence(&page, response.has_more)?;
        messages.extend(
            page.into_iter()
                .filter(|message| seen_message_ids.insert(message.message_id.clone())),
        );

        let Some(next_before_sequence) = next_before_sequence else {
            break;
        };
        if before_sequence == Some(next_before_sequence) {
            return Err(CliError::Relay(
                "Channel history pagination did not advance its sequence cursor".to_string(),
            ));
        }
        before_sequence = Some(next_before_sequence);
    }

    report_repaired_history(hub_url, &page_repairs, unreadable_rows).await;

    sort_channel_history(&mut messages);

    Ok(messages)
}

/// Never silent: a read that only worked because this CLI repaired the payload
/// has to say so, and say what to do about it. The Hub's policy is read only
/// when there is something to report, so a clean read costs no extra request.
async fn report_repaired_history(
    hub_url: &str,
    repairs: &[wire_compat::WireRepair],
    unreadable_rows: usize,
) {
    let summary = wire_compat::repair_summary(repairs);
    if summary.is_empty() && unreadable_rows == 0 {
        return;
    }
    if let Some(report) = wire_compat::compatibility_report(
        &summary,
        unreadable_rows,
        hub_compatibility_policy(hub_url).await.as_ref(),
    ) {
        eprintln!("{report}");
    }
}

/// Best effort: the report is still actionable without the Hub's policy, so a
/// failed read here must never turn a working history read into an error.
async fn hub_compatibility_policy(hub_url: &str) -> Option<serde_json::Value> {
    http::request_json::<serde_json::Value>(
        &with_route(hub_url, protocol::CLIENT_COMPATIBILITY_PATH),
        "GET",
        None,
        None,
    )
    .await
    .ok()
}

fn sort_channel_history(messages: &mut [protocol::ChannelMessage]) {
    messages.sort_by(|left, right| {
        left.sent_at
            .cmp(&right.sent_at)
            .then_with(|| left.message_id.cmp(&right.message_id))
    });
}

const DAEMON_REQUEST_URL_ENV: &str = "XMATRIX_DAEMON_REQUEST_URL";
const DAEMON_REQUEST_CAPABILITY_ENV: &str = "XMATRIX_DAEMON_REQUEST_CAPABILITY";
const DAEMON_REQUEST_CAPABILITY_HEADER: &str = "x-xmatrix-request-capability";

#[derive(Deserialize)]
struct DaemonChannelHistoryResponse {
    /// Raw for the same reason the Hub page is: the daemon serves the Hub's
    /// shape, so it carries the Hub's forward-compatibility problem too.
    #[serde(default)]
    messages: Vec<serde_json::Value>,
}

/// Ask the machine daemon's request broker for the channel's full history.
/// `None` means "no usable broker answer" for any reason — env absent,
/// non-loopback URL, refusal, transport error, or an empty/error body — and
/// the caller falls back to the direct Hub walk, so this path can only ever
/// remove cost, never correctness. The daemon reads the Hub with this run's
/// own token, so authorization is unchanged.
async fn daemon_cached_channel_history(
    channel_id: &str,
    token: &str,
) -> Option<(
    Vec<protocol::ChannelMessage>,
    Vec<wire_compat::WireRepair>,
    usize,
)> {
    let url = std::env::var(DAEMON_REQUEST_URL_ENV).ok()?;
    let capability = std::env::var(DAEMON_REQUEST_CAPABILITY_ENV).ok()?;
    let url = url.trim();
    let capability = capability.trim();
    if url.is_empty() || capability.is_empty() {
        return None;
    }
    let parsed = reqwest::Url::parse(url).ok()?;
    if !matches!(
        parsed.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("[::1]")
    ) {
        return None;
    }
    let response = reqwest::Client::new()
        .post(format!(
            "{}/request/channel-history",
            url.trim_end_matches('/')
        ))
        .header(DAEMON_REQUEST_CAPABILITY_HEADER, capability)
        .json(&serde_json::json!({ "channelId": channel_id, "runToken": token }))
        .timeout(std::time::Duration::from_secs(180))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: DaemonChannelHistoryResponse = response.json().await.ok()?;
    if body.messages.is_empty() {
        return None;
    }
    let (messages, repairs, unreadable) =
        wire_compat::decode_rows_tolerant::<protocol::ChannelMessage>(&body.messages);
    if messages.is_empty() {
        // Nothing survived, so the broker answer is unusable; the direct walk
        // reports the incompatibility itself.
        return None;
    }
    Some((messages, repairs, unreadable.len()))
}

async fn cmd_channel_history(
    hub_url: &str,
    token: &str,
    channel_id: &str,
    authoritative: bool,
) -> error::Result<()> {
    let messages = if authoritative {
        load_authoritative_channel_history(hub_url, token, channel_id).await?
    } else {
        load_full_channel_history(hub_url, token, channel_id).await?
    };
    let threads = match load_channel_read_context(hub_url, token, channel_id).await {
        Ok(context) => {
            println!("{}", context.text);
            context.threads
        }
        Err(error) => {
            eprintln!("Channel context unavailable: {error}");
            Vec::new()
        }
    };

    if messages.is_empty() {
        println!("No messages found for channel {channel_id}.");
        return Ok(());
    }

    let local_images = materialize_history_image_attachments(hub_url, token, &messages).await;
    for message in &messages {
        print_history_message_with_local_images(message, &local_images, &threads);
    }

    Ok(())
}

fn history_page_before_sequence(messages: &[protocol::ChannelMessage]) -> Option<u64> {
    messages
        .iter()
        .filter_map(|message| message.sequence)
        // Thread roots are projected with sequence zero and are not valid Authority
        // beforeSequence cursors. They can appear on every page.
        .filter(|sequence| *sequence > 0)
        .min()
}

fn next_history_before_sequence(
    messages: &[protocol::ChannelMessage],
    has_more: bool,
) -> error::Result<Option<u64>> {
    if !has_more {
        return Ok(None);
    }
    history_page_before_sequence(messages)
        .map(Some)
        .ok_or_else(|| {
            CliError::Relay(
                "Channel history reported another page without a positive sequence cursor"
                    .to_string(),
            )
        })
}

fn print_channel_chat_messages(
    seen: &mut HashSet<String>,
    last_sequence: &mut u64,
    mut messages: Vec<protocol::ChannelMessage>,
) -> usize {
    messages.sort_by(protocol::compare_channel_messages);

    let mut printed = 0usize;
    for message in messages {
        if !seen.insert(message.message_id.clone()) {
            continue;
        }
        if let Some(sequence) = message.sequence {
            *last_sequence = (*last_sequence).max(sequence);
        }
        print_history_message_with_local_images(&message, &HashMap::new(), &[]);
        printed += 1;
    }
    printed
}

async fn fetch_channel_chat_history(
    hub_url: &str,
    token: &str,
    channel_id: &str,
    limit: u32,
    after_sequence: Option<u64>,
) -> error::Result<Vec<protocol::ChannelMessage>> {
    #[derive(Deserialize)]
    struct HistoryResponse {
        messages: Vec<protocol::ChannelMessage>,
    }

    let mut route = format!(
        "/api/channels/{}/history?limit={}",
        urlencoding::encode(channel_id),
        limit.clamp(1, 500)
    );
    if let Some(sequence) = after_sequence {
        route.push_str("&afterSequence=");
        route.push_str(&sequence.to_string());
    }
    let response: HistoryResponse =
        http::request_json(&with_route(hub_url, &route), "GET", Some(token), None).await?;
    Ok(response.messages)
}

async fn cmd_channel_chat(
    hub_url: &str,
    token: &str,
    channel_id: &str,
    limit: u32,
) -> error::Result<()> {
    let limit = limit.clamp(1, 500);
    let mut seen = HashSet::new();
    let mut last_sequence = 0u64;
    let owner_user_id = config::load_session_for_hub(hub_url)
        .await
        .map(|session| session.user.id)
        .unwrap_or_default();
    let mut human = HumanConnectionClient::connect_with_owner(
        hub_url,
        token.to_string(),
        "xmatrix-cli-chat".to_string(),
        &owner_user_id,
    )
    .await?;
    human.focus_channel(Some(channel_id.to_string()))?;

    let initial = fetch_channel_chat_history(hub_url, token, channel_id, limit, None).await?;
    print_channel_chat_messages(&mut seen, &mut last_sequence, initial);

    println!(
        "{} Opening Human chat {}. Commands: /refresh, /history, /help, /quit",
        "●".green().bold(),
        channel_id.dimmed()
    );

    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();

    loop {
        print!("xmatrix:{}> ", short_channel_id(channel_id));
        std::io::stdout()
            .flush()
            .map_err(|err| CliError::Launch(format!("flush stdout: {err}")))?;

        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line.map_err(|err| CliError::Launch(format!("read stdin: {err}")))? else {
                    break;
                };
                let input = line.trim();
                if input.is_empty() {
                    continue;
                }

                match input {
                    "/quit" | "/exit" => break,
                    "/help" => {
                        println!("/refresh  fetch messages after the latest local sequence");
                        println!("/history  reload the latest {limit} messages through relay");
                        println!("/quit     exit chat");
                    }
                    "/refresh" => {
                        let messages = fetch_channel_chat_history(
                            hub_url,
                            token,
                            channel_id,
                            limit,
                            Some(last_sequence),
                        ).await?;
                        let entry_count = messages.len();
                        if print_channel_chat_messages(&mut seen, &mut last_sequence, messages) == 0 {
                            println!("No new messages.");
                        }
                        if entry_count >= limit as usize {
                            println!(
                                "{} Refresh returned {entry_count} messages; run /refresh again if more may be pending.",
                                "⚠".yellow().bold()
                            );
                        }
                    }
                    "/history" => {
                        let messages = fetch_channel_chat_history(
                            hub_url,
                            token,
                            channel_id,
                            limit,
                            None,
                        ).await?;
                        if print_channel_chat_messages(&mut seen, &mut last_sequence, messages) == 0 {
                            println!("No unseen messages in the latest window.");
                        }
                    }
                    command if command.starts_with('/') => {
                        println!("Unknown command: {command}. Try /help.");
                    }
                    body => {
                        cmd_send(
                            hub_url,
                            token,
                            channel_id,
                            SendOptions { message_parts: &[body.to_string()], attachment_paths: &[],
                                read_stdin: false, escape_newlines: false, message_id: None, final_for: None, reply_to: None },
                        ).await?;
                    }
                }
            }
            event = human.event_rx.recv() => {
                let Some(event) = event else {
                    break;
                };
                match event {
                    HumanConnectionEvent::ChannelMessageReceived { message }
                        if message.channel_id == channel_id => {
                        print_channel_chat_messages(&mut seen, &mut last_sequence, vec![message]);
                    }
                    HumanConnectionEvent::Connected { reconnected: true, .. } => {
                        println!("{} Reconnected; use /refresh to fetch any missed messages.", "↻".cyan().bold());
                    }
                    HumanConnectionEvent::Disconnected { reason } => {
                        println!("{} Disconnected: {reason}", "⚠".yellow().bold());
                    }
                    HumanConnectionEvent::ChannelMessageUpdated { channel_id: event_channel_id, message }
                        if event_channel_id == channel_id => {
                        seen.remove(&message.message_id);
                        print_channel_chat_messages(&mut seen, &mut last_sequence, vec![message]);
                    }
                    HumanConnectionEvent::Error { message } => {
                        println!("{} Human connection error: {message}", "⚠".yellow().bold());
                    }
                    _ => {}
                }
            }
        }
    }

    let _ = human.focus_channel(None);
    human.close().await;
    Ok(())
}

fn print_history_message_with_local_images(
    message: &protocol::ChannelMessage,
    local_images: &HashMap<(String, String), PathBuf>,
    threads: &[OpenedChannelThread],
) {
    print!(
        "{}",
        format_history_message_with_local_images(
            message,
            local_images,
            xmatrix_cli_core::instant::now_utc_rfc3339().as_deref(),
            threads,
        )
    );
}

pub fn format_history_message(message: &protocol::ChannelMessage) -> String {
    format_history_message_with_local_images(
        message,
        &HashMap::new(),
        xmatrix_cli_core::instant::now_utc_rfc3339().as_deref(),
        &[],
    )
}

/// Render one history line against a fixed clock, so a whole transcript shares
/// one anchor and a test can pin the ages it asserts on.
pub fn format_history_message_at(
    message: &protocol::ChannelMessage,
    read_at: Option<&str>,
) -> String {
    format_history_message_with_local_images(message, &HashMap::new(), read_at, &[])
}

/// Format one history entry. When Relay V2 attachments only carry identity
/// coordinates (no data URL / signed URL), prefer a materialized local path so
/// agents and humans do not see a false "missing data" state for successful
/// uploads.
pub fn format_history_message_with_local_images(
    message: &protocol::ChannelMessage,
    local_images: &HashMap<(String, String), PathBuf>,
    read_at: Option<&str>,
    threads: &[OpenedChannelThread],
) -> String {
    let sequence = message
        .sequence
        .map(|value| format!("#{value} "))
        .unwrap_or_default();
    // A thread root says so on its own line: a reader who never turns back to
    // the `Opened threads` block must still see that this message was picked
    // up, and whether the thread was archived.
    let thread_marker = thread_root_marker(threads, &message.message_id)
        .map(|marker| format!(" {marker}"))
        .unwrap_or_default();
    // `sentAt` is UTC and says so, but a reader in another zone still has to
    // subtract to learn how stale a message is — and that subtraction against a
    // local clock is wrong by the zone offset. The age removes the need.
    let age = read_at
        .and_then(|now| xmatrix_cli_core::instant::relative_age(&message.sent_at, now))
        .map(|age| format!("({age}) "))
        .unwrap_or_default();
    // A link message's ordinal belongs to the Channel it came from, and a reply
    // to it is how an answer returns there; a reader of history needs both.
    let origin = match protocol::cross_channel_reply_source(message.metadata.as_ref()) {
        Some(source) => format!(
            " replying in Channel {}{}",
            source.channel_id,
            source
                .message_id
                .map(|id| format!(" [sourceMessageId={id}]"))
                .unwrap_or_default()
        ),
        None => message
            .from
            .origin_channel_id
            .as_deref()
            .map(str::trim)
            .filter(|channel| !channel.is_empty())
            .map(|channel| format!(" via Channel {channel}"))
            .unwrap_or_default(),
    };
    let reply = message
        .reply_to_message_id
        .as_deref()
        .map(|id| format!(" [replyToMessageId={id}]"))
        .unwrap_or_default();
    // Activity and superseded reports fold to one line, as they do on the web
    // (docs/design/conversation-activity.md §4.3).
    if let Some(folded) = protocol::folded_history_line(message) {
        return format!(
            "{} {}{}{}{origin} [messageId={}]{reply}{thread_marker} {}\n\n",
            message.sent_at.dimmed(),
            age.dimmed(),
            sequence.dimmed(),
            message.from.label.bold(),
            message.message_id,
            folded.dimmed()
        );
    }
    let mut output = format!(
        "{} {}{}{}{origin} [messageId={}]{reply}{thread_marker}\n",
        message.sent_at.dimmed(),
        age.dimmed(),
        sequence.dimmed(),
        message.from.label.bold(),
        message.message_id
    );

    if message.deleted_at.is_some() {
        output.push_str("  [message deleted]\n");
    } else if message.recalled_at.is_some() {
        output.push_str("  [message recalled]\n");
    } else if message.body.is_empty() {
        output.push('\n');
    } else {
        for line in message.body.lines() {
            output.push_str(&format!("  {line}\n"));
        }
        if let Some(edited_at) = message.edited_at.as_deref() {
            output.push_str(&format!("  [edited {edited_at}]\n"));
        }
    }
    if let Some(attachments) = message.attachments.as_deref() {
        for attachment in attachments {
            let url = attachment.url.as_deref().filter(|value| !value.is_empty());
            let local_path = local_images
                .get(&(message.message_id.clone(), attachment.id.clone()))
                .map(|path| path.display().to_string());
            let has_identity = attachment
                .channel_id
                .as_deref()
                .is_some_and(|value| !value.is_empty())
                && attachment
                    .message_id
                    .as_deref()
                    .is_some_and(|value| !value.is_empty())
                && !attachment.id.is_empty();
            let has_data = if local_path.is_some() {
                "local"
            } else if !attachment.data_url.is_empty() {
                "data"
            } else if url.is_some() {
                "url"
            } else if has_identity {
                "identity"
            } else {
                "missing data"
            };
            output.push_str(&format!(
                "  [attachment] {} ({} bytes, {}, {})\n",
                attachment.name, attachment.size, attachment.mime_type, has_data
            ));
            if let Some(path) = local_path.as_deref() {
                output.push_str(&format!("    local: {path}\n"));
            }
            if let Some(url) = url {
                output.push_str(&format!("    url: {url}\n"));
                if url.starts_with("http://") || url.starts_with("https://") {
                    output.push_str(&format!(
                        "    fetch: xmatrix attachment fetch {}\n",
                        shell_quote(url)
                    ));
                }
            } else if has_identity && local_path.is_none() {
                let channel_id = attachment
                    .channel_id
                    .as_deref()
                    .unwrap_or(message.channel_id.as_str());
                let message_id = attachment
                    .message_id
                    .as_deref()
                    .unwrap_or(message.message_id.as_str());
                output.push_str(&format!(
                    "    identity: channel={channel_id} message={message_id} attachment={}\n",
                    attachment.id
                ));
                output.push_str(
                    "    fetch: product-media (POST /api/relay-v2/message-attachments/product-media)\n",
                );
            }
        }
    }
    output.push('\n');
    output
}

/// Download identity-backed image attachments via the product-media read path
/// so history output can point at real local files instead of "missing data".
async fn materialize_history_image_attachments(
    hub_url: &str,
    token: &str,
    messages: &[protocol::ChannelMessage],
) -> HashMap<(String, String), PathBuf> {
    let mut local = HashMap::new();
    for message in messages {
        let Some(attachments) = message.attachments.as_deref() else {
            continue;
        };
        for attachment in attachments {
            if !attachment.data_url.is_empty() {
                continue;
            }
            if attachment
                .url
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            {
                continue;
            }
            let channel_id = attachment
                .channel_id
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or(message.channel_id.as_str());
            let message_id = attachment
                .message_id
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or(message.message_id.as_str());
            if channel_id.is_empty() || message_id.is_empty() || attachment.id.is_empty() {
                continue;
            }
            match download_message_attachment_product_media(
                hub_url,
                token,
                channel_id,
                message_id,
                &attachment.id,
                attachment.size,
                &attachment.mime_type,
                &attachment.name,
            )
            .await
            {
                Ok(path) => {
                    local.insert((message.message_id.clone(), attachment.id.clone()), path);
                }
                Err(err) => {
                    eprintln!(
                        "{} failed to materialize attachment {} ({}): {err}",
                        "⚠".yellow().bold(),
                        attachment.name,
                        attachment.id
                    );
                }
            }
        }
    }
    local
}

async fn download_message_attachment_product_media(
    hub_url: &str,
    token: &str,
    channel_id: &str,
    message_id: &str,
    attachment_id: &str,
    expected_size: u64,
    expected_mime: &str,
    name: &str,
) -> error::Result<PathBuf> {
    if expected_size == 0 || expected_size > CHANNEL_FILE_ATTACHMENT_MAX_BYTES {
        return Err(CliError::Http(
            "Channel attachment is outside the CLI media limit".into(),
        ));
    }
    let stem = xmatrix_cli_core::attachment_cache::cache_stem_for_identity(
        channel_id,
        message_id,
        attachment_id,
        expected_size,
    );
    if let Some(bytes) =
        xmatrix_cli_core::attachment_cache::read_cached_attachment(&stem, Some(expected_size))
    {
        return write_history_attachment_bytes(attachment_id, expected_mime, name, &bytes);
    }
    // Every history read lists the same images; one the Hub refused is not
    // asked for again until the refusal expires.
    if xmatrix_cli_core::attachment_cache::attachment_recently_refused(&stem) {
        return Err(CliError::Http(
            "Channel attachment was refused recently; not requesting it again yet".into(),
        ));
    }
    let url = with_route(hub_url, HubRoutes::MESSAGE_ATTACHMENT_PRODUCT_MEDIA);
    let body = serde_json::json!({
        "channelId": channel_id,
        "messageId": message_id,
        "attachmentId": attachment_id,
    });
    let broker = xmatrix_cli_core::access::requires_access(&url)
        .then(xmatrix_cli_core::access::daemon_request_broker)
        .flatten();
    let response = if let Some((broker_url, capability)) = broker {
        reqwest::Client::new()
            .post(format!("{broker_url}/request/hub-product-media"))
            .header("x-xmatrix-request-capability", capability)
            .json(&serde_json::json!({
                "url": url,
                "token": token,
                "expectedSize": expected_size,
                "body": body,
            }))
            .send()
            .await
    } else {
        let request = http::client()?
            .post(&url)
            .bearer_auth(token)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::CACHE_CONTROL, "no-store")
            .json(&body);
        http::with_access_header(request, &url)?.send().await
    }
    .map_err(|err| CliError::Http(format!("product-media request failed: {err}")))?;
    if matches!(
        response.status(),
        reqwest::StatusCode::FORBIDDEN | reqwest::StatusCode::NOT_FOUND
    ) {
        let _ = xmatrix_cli_core::attachment_cache::remember_refused_attachment(&stem);
    }
    let response = http::require_success(response, &url).await?;
    if let Some(length) = response.content_length()
        && length != expected_size
    {
        return Err(CliError::Http(
            "Channel image attachment length does not match authority".into(),
        ));
    }
    let mime_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|| expected_mime.to_string());
    if !mime_type.eq_ignore_ascii_case(expected_mime) && !expected_mime.is_empty() {
        // Prefer server content-type when present; still require image/*.
        if !mime_type.starts_with("image/") {
            return Err(CliError::Http(format!(
                "Channel image attachment MIME type is not an image: {mime_type}"
            )));
        }
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|err| CliError::Http(format!("product-media body read failed: {err}")))?;
    if expected_size > 0 && bytes.len() as u64 != expected_size {
        return Err(CliError::Http(
            "Channel attachment body length does not match authority".into(),
        ));
    }
    let _ = xmatrix_cli_core::attachment_cache::write_cached_attachment(&stem, &bytes);
    write_history_attachment_bytes(attachment_id, &mime_type, name, &bytes)
}

fn write_history_attachment_bytes(
    attachment_id: &str,
    mime_type: &str,
    name: &str,
    bytes: &[u8],
) -> error::Result<PathBuf> {
    let extension = channel_image_extension(mime_type, name);
    let safe_name: String = Path::new(name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment")
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let path = xmatrix_cli_core::attachment_cache::attachment_cache_dir().join(format!(
        "history-{}-{safe_name}.{extension}",
        &attachment_id[..attachment_id.len().min(12)],
    ));
    xmatrix_cli_core::attachment_cache::copy_cached_attachment_to(&path, bytes)?;
    Ok(path)
}

fn channel_image_extension(mime_type: &str, name: &str) -> &'static str {
    let lower_mime = mime_type.to_ascii_lowercase();
    if lower_mime.contains("png") {
        return "png";
    }
    if lower_mime.contains("jpeg") || lower_mime.contains("jpg") {
        return "jpg";
    }
    if lower_mime.contains("gif") {
        return "gif";
    }
    if lower_mime.contains("webp") {
        return "webp";
    }
    if lower_mime.contains("pdf") {
        return "pdf";
    }
    if lower_mime.contains("mp4") {
        return "mp4";
    }
    if lower_mime.contains("markdown") {
        return "md";
    }
    Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| match value.to_ascii_lowercase().as_str() {
            "png" => "png",
            "jpg" | "jpeg" => "jpg",
            "gif" => "gif",
            "webp" => "webp",
            "mp4" => "mp4",
            "webm" => "webm",
            "md" | "markdown" => "md",
            "txt" => "txt",
            "pdf" => "pdf",
            "zip" => "zip",
            "json" => "json",
            _ => "bin",
        })
        .unwrap_or("bin")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn channel_label(channel: &protocol::SerializedChannel) -> String {
    channel
        .name
        .clone()
        .unwrap_or_else(|| short_channel_id(&channel.id))
}

pub fn channel_presence_labels(channel: &protocol::SerializedChannel) -> String {
    let Some(presence) = channel.member_presence.as_ref() else {
        return "-".into();
    };
    if presence.is_empty() {
        return "-".into();
    }

    let mut entries = presence
        .iter()
        .filter(|(member, presence)| !is_daemon_channel_presence(member, presence))
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return "-".into();
    }

    entries.sort_by(|(left_member, left), (right_member, right)| {
        let left_label = channel_presence_label(left_member, left);
        let right_label = channel_presence_label(right_member, right);
        channel_presence_rank(left)
            .cmp(&channel_presence_rank(right))
            .then_with(|| left_label.cmp(&right_label))
    });

    entries
        .into_iter()
        .map(|(member, presence)| {
            let label = channel_presence_label(member, presence);
            let kind = if presence.kind == "agent" {
                "ai"
            } else {
                presence.kind.as_str()
            };
            match (presence.kind.as_str(), presence.status.as_deref()) {
                ("agent", _) | (_, None) => format!("{}({})", label, kind),
                (_, Some(status)) => format!("{}({}:{})", label, kind, status),
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn channel_presence_label(member: &str, presence: &protocol::ChannelMemberPresence) -> String {
    presence
        .label
        .as_ref()
        .filter(|name| !name.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| fallback_member_label(member))
}

fn presence_status_rank(status: &str) -> u8 {
    match status {
        "online" | "busy" => 0,
        "idle" => 1,
        _ => 2,
    }
}

fn channel_presence_rank(presence: &protocol::ChannelMemberPresence) -> u8 {
    if presence.kind == "agent" {
        return 2;
    }
    presence
        .status
        .as_deref()
        .map(presence_status_rank)
        .unwrap_or(2)
}

fn is_daemon_channel_presence(member: &str, presence: &protocol::ChannelMemberPresence) -> bool {
    if !member.starts_with("agent:") {
        return false;
    }
    let label = presence
        .label
        .as_deref()
        .unwrap_or(member)
        .trim()
        .to_ascii_lowercase();
    label == "xmatrix-daemon" || label.starts_with("xmatrix-daemon-")
}

fn fallback_member_label(member: &str) -> String {
    member
        .strip_prefix("user:")
        .map(|id| format!("web:{}", short_channel_id(id)))
        .unwrap_or_else(|| member.to_string())
}

pub fn short_channel_id(channel_id: &str) -> String {
    channel_id.chars().take(8).collect()
}

pub fn channel_name_from_cache(
    cache: &Arc<Mutex<HashMap<String, String>>>,
    channel_id: &str,
) -> String {
    cache
        .lock()
        .ok()
        .and_then(|guard| guard.get(channel_id).cloned())
        .unwrap_or_else(|| short_channel_id(channel_id))
}

#[cfg(test)]
#[expect(
    clippy::await_holding_lock,
    reason = "each #[tokio::test] runs on its own thread; the guard only serializes process-global env across test threads"
)]
mod tests {
    mod attachment_fixture {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../core/tests/support/attachment_fixture.rs"
        ));
    }

    use super::{
        OpenedChannelThread, agent_sender_env_value, attachment_upload_final_path,
        attachment_visibility_scope_id, channel_create_body, channel_entity_token,
        channel_image_mime_type, cmd_channel_create, decode_send_newline_escapes,
        format_history_message_at, is_agent_execution_context, is_intake,
        process_descends_from_tracked_pid, resolve_channel_selector,
        should_refuse_user_attributed_send_without_agent_identity, tracked_ancestor_pid,
    };
    use std::collections::{HashMap, HashSet};
    use xmatrix_cli_core::protocol::{
        ChannelAttachment, ChannelMessage, MessageSender, SerializedChannel,
    };

    static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn test_channel(id: &str, name: &str) -> SerializedChannel {
        SerializedChannel {
            id: id.to_string(),
            space_id: Some("space-1".to_string()),
            name: Some(name.to_string()),
            topic: None,
            summary: None,
            summary_source: None,
            mode: "open".to_string(),
            message_count: Some(0),
            member_presence: None,
            metadata: None,
            created_by: "user:owner".to_string(),
            created_by_agent: None,
            created_at: "2026-07-10T00:00:00Z".to_string(),
            updated_at: "2026-07-10T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn intake_is_a_conversation_a_participant_started() {
        let mut question = test_channel("c-1", "question");
        assert!(!is_intake(&question));
        question.metadata = Some(serde_json::json!({ "intakeOf": "participant-1" }));
        assert!(is_intake(&question));
        question.metadata = Some(serde_json::json!({ "intakeOf": null }));
        assert!(!is_intake(&question));
    }

    /* An open Channel's messages live in the Space scope, so an attachment
    registered under channel:<id> is rejected at bind time with "verified
    canonical attachment ref is unavailable". Agent sends used to hardcode the
    channel scope and could therefore never attach a file to an open Channel. */
    #[test]
    fn attachment_scope_follows_space_for_open_channels() {
        assert_eq!(
            attachment_visibility_scope_id("channel-1", Some("open"), Some("space-1"))
                .expect("open channel resolves to its Space scope"),
            "space:space-1"
        );
    }

    #[test]
    fn attachment_scope_isolates_closed_channels() {
        assert_eq!(
            attachment_visibility_scope_id("channel-1", Some("closed"), Some("space-1"))
                .expect("closed channel resolves to its own scope"),
            "channel:channel-1"
        );
    }

    #[test]
    fn attachment_scope_falls_back_when_channel_is_unknown() {
        assert_eq!(
            attachment_visibility_scope_id("channel-1", None, None)
                .expect("unknown mode keeps the channel-scoped guess"),
            "channel:channel-1"
        );
    }

    #[test]
    fn attachment_scope_rejects_open_channel_without_space() {
        assert!(attachment_visibility_scope_id("channel-1", Some("open"), None).is_err());
    }

    #[test]
    fn attachment_upload_uses_scope_bound_blob_authority_path() {
        assert_eq!(
            attachment_upload_final_path("intent-1", "space:space-1"),
            "/api/relay-v2/private-r2/uploads/intent-1/scope/space%3Aspace-1"
        );
    }

    #[test]
    fn channel_selector_resolves_canonical_web_urls() {
        let channel_id = "3971448a-1c8d-40b2-8d94-9a98d67af4b9";
        let channels = vec![test_channel(channel_id, "workspace instance")];

        assert_eq!(channel_entity_token(channel_id), "c3efck6xm5n");
        for selector in [
            "workspace-instance-c3efck6xm5n",
            "https://xmatrix.sh/app/acme-team-so7livxfrfb/channels/workspace-instance-c3efck6xm5n",
            "https://xmatrix.sh/app/acme-team-so7livxfrfb/channels/workspace-instance-c3efck6xm5n?view=latest#message:test",
        ] {
            assert_eq!(
                resolve_channel_selector(&channels, selector)
                    .expect("canonical channel URL")
                    .id,
                channel_id,
            );
        }
    }

    #[test]
    fn channel_selector_resolves_exact_id_web_urls() {
        let channel_id = "3971448a-1c8d-40b2-8d94-9a98d67af4b9";
        let channels = vec![test_channel(channel_id, "workspace instance")];

        for selector in [
            "workspace-instance--3971448a-1c8d-40b2-8d94-9a98d67af4b9",
            "https://next.xmatrix.sh/app/acme-team-so7livxfrfb/channels/workspace-instance--3971448a-1c8d-40b2-8d94-9a98d67af4b9",
        ] {
            assert_eq!(
                resolve_channel_selector(&channels, selector)
                    .expect("exact-id channel URL")
                    .id,
                channel_id,
            );
        }
    }

    #[test]
    fn channel_selector_prioritizes_canonical_url_token_over_title_match() {
        let channel_id = "b0ffd02f-848e-4c10-8d5a-7f6ca9cc3ca2";
        let selector =
            "https://xmatrix.sh/app/acme-team-so7livxfrfb/channels/onboarding-cah8i79can7";
        let channels = vec![
            test_channel(channel_id, "onboarding gap"),
            test_channel(
                "37a4d64a-3319-42fa-8c1e-9810938b9a74",
                &format!("{selector} issue"),
            ),
        ];

        assert_eq!(channel_entity_token(channel_id), "cah8i79can7");
        assert_eq!(
            resolve_channel_selector(&channels, selector)
                .expect("canonical URL should resolve by its entity token")
                .id,
            channel_id,
        );
    }

    #[test]
    fn cli_send_file_builds_checksum_verified_upload_input() {
        let path =
            std::env::temp_dir().join(format!("xmatrix-cli-attachment-{}.png", std::process::id()));
        std::fs::write(&path, [137, 80, 78, 71]).unwrap();

        let attachments =
            super::load_channel_file_attachments(std::slice::from_ref(&path)).unwrap();

        assert_eq!(attachments.len(), 1);
        assert_eq!(
            attachments[0].name,
            path.file_name().unwrap().to_string_lossy()
        );
        assert_eq!(attachments[0].mime_type, "image/png");
        assert_eq!(attachments[0].bytes, [137, 80, 78, 71]);
        assert_eq!(attachments[0].content_hash.len(), 64);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cli_send_file_accepts_markdown() {
        let path =
            std::env::temp_dir().join(format!("xmatrix-cli-attachment-{}.md", std::process::id()));
        std::fs::write(&path, b"# Deployment guide\n").unwrap();

        let attachments =
            super::load_channel_file_attachments(std::slice::from_ref(&path)).unwrap();

        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].mime_type, "text/markdown");
        assert_eq!(attachments[0].bytes, b"# Deployment guide\n");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cli_send_places_uploaded_attachment_bindings_in_message_payload() {
        let uploaded = super::UploadedMessageAttachment {
            attachment_id: "attachment-1".to_string(),
            object_key: "objects/aaaaaaaa".to_string(),
            content_hash: "a".repeat(64),
            encoded_bytes: 20,
            mime_type: "text/markdown".to_string(),
            name: "deployment-guide.md".to_string(),
        };

        assert_eq!(
            super::uploaded_attachment_bindings(&[uploaded]),
            vec![serde_json::json!({
                "attachmentId": "attachment-1",
                "objectKey": "objects/aaaaaaaa",
                "contentHash": "a".repeat(64),
                "encodedBytes": 20,
                "mimeType": "text/markdown",
                "name": "deployment-guide.md",
            })],
        );
    }

    #[test]
    fn cli_send_file_accepts_supported_image_extensions() {
        assert_eq!(
            channel_image_mime_type(&std::path::PathBuf::from("screen.PNG")),
            Some("image/png")
        );
        assert_eq!(
            channel_image_mime_type(&std::path::PathBuf::from("screen.jpeg")),
            Some("image/jpeg")
        );
        assert_eq!(
            channel_image_mime_type(&std::path::PathBuf::from("screen.webp")),
            Some("image/webp")
        );
        assert_eq!(
            channel_image_mime_type(&std::path::PathBuf::from("screen.gif")),
            Some("image/gif")
        );
        assert_eq!(
            channel_image_mime_type(&std::path::PathBuf::from("screen.svg")),
            None
        );
    }

    #[test]
    fn cli_send_uses_app_server_agent_identity_env() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        unsafe {
            std::env::set_var(
                "XMATRIX_TEST_AGENT_IDENTITY_ID_OVERRIDE",
                "agent:user:codex",
            );
            std::env::set_var("XMATRIX_TEST_AGENT_NAME_OVERRIDE", "codex");
        }

        assert_eq!(
            agent_sender_env_value(&[
                "XMATRIX_TEST_AGENT_ID",
                "XMATRIX_TEST_AGENT_IDENTITY_ID_OVERRIDE"
            ]),
            Some("agent:user:codex".to_string())
        );
        assert_eq!(
            agent_sender_env_value(&[
                "XMATRIX_TEST_AGENT_NAME",
                "XMATRIX_TEST_AGENT_NAME_OVERRIDE"
            ]),
            Some("codex".to_string())
        );

        unsafe {
            std::env::remove_var("XMATRIX_TEST_AGENT_IDENTITY_ID_OVERRIDE");
            std::env::remove_var("XMATRIX_TEST_AGENT_NAME_OVERRIDE");
        }
    }

    #[test]
    fn cli_send_refuses_human_fallback_inside_agent_context() {
        assert!(should_refuse_user_attributed_send_without_agent_identity(
            true, false, false
        ));
        assert!(should_refuse_user_attributed_send_without_agent_identity(
            false, true, false
        ));
        assert!(!should_refuse_user_attributed_send_without_agent_identity(
            true, true, true
        ));
        assert!(!should_refuse_user_attributed_send_without_agent_identity(
            false, false, false
        ));
    }

    #[test]
    fn channel_create_without_a_name_is_an_automatically_named_conversation() {
        let body = channel_create_body("", None, None, "open");
        assert_eq!(body["name"], "New conversation");
        assert_eq!(body["metadata"]["autoName"], true);
        let named = channel_create_body("plans", None, None, "open");
        assert!(named["metadata"].get("autoName").is_none());
    }

    #[test]
    fn channel_create_body_omits_ai_summary_and_claimed_sender_fields() {
        let body = channel_create_body("plans", None, Some("  weekly planning  "), "closed");
        let object = body.as_object().unwrap();
        assert!(!object.contains_key("summary"), "the Hub owns the Summary");
        assert!(
            !object.contains_key("spaceId"),
            "an omitted Space stays omitted"
        );
        for field in [
            "senderAgentId",
            "senderAgentName",
            "senderRunId",
            "senderExecutionKey",
        ] {
            assert!(
                !object.contains_key(field),
                "{field} is attributed by the Hub"
            );
        }
        assert!(!object.contains_key("parentChannelId"));
        assert_eq!(body["topic"], "weekly planning");
        assert_eq!(body["mode"], "closed");
        assert!(!object.contains_key("access") && !object.contains_key("memberName"));
    }

    #[tokio::test]
    async fn cli_channel_create_refuses_human_fallback_inside_agent_context() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let env_names = [
            "XMATRIX_AGENT_SESSION",
            "XMATRIX_AGENT_NAME",
            "XMATRIX_AGENT_NAME_OVERRIDE",
            "XMATRIX_AGENT_ID",
            "XMATRIX_AGENT_IDENTITY_ID_OVERRIDE",
            "XMATRIX_AGENT_INSTANCE_ID",
            "XMATRIX_RUN_ID",
            "XMATRIX_EXECUTION_KEY",
        ];
        let previous = env_names
            .iter()
            .map(|name| (*name, std::env::var_os(name)))
            .collect::<Vec<_>>();
        unsafe {
            for name in env_names {
                std::env::remove_var(name);
            }
            std::env::set_var("XMATRIX_AGENT_SESSION", "1");
        }

        let err = cmd_channel_create(
            "http://127.0.0.1:1",
            "token",
            None,
            "open".to_string(),
            None,
            vec!["test".to_string()],
        )
        .await
        .expect_err("agent sessions without agent identity must fail before HTTP");

        assert!(format!("{err}").contains("refusing to create a channel as the launching user"));

        unsafe {
            for (name, value) in previous {
                if let Some(value) = value {
                    std::env::set_var(name, value);
                } else {
                    std::env::remove_var(name);
                }
            }
        }
    }

    #[test]
    fn agent_execution_context_detected_from_any_signal() {
        // Any single signal marks an agent execution context so credential
        // resolution fails closed instead of using the human's saved session.
        assert!(is_agent_execution_context(true, false, false));
        assert!(is_agent_execution_context(false, true, false));
        // Even with all environment markers stripped, the tamper-resistant
        // daemon-run process lineage still recognizes the agent.
        assert!(is_agent_execution_context(false, false, true));
        // A genuine interactive human CLI session has no agent signals.
        assert!(!is_agent_execution_context(false, false, false));
    }

    #[test]
    fn cli_send_detects_daemon_agent_descendant_process() {
        let tracked_pids = HashSet::from([100]);
        let parents = HashMap::from([(500, 400), (400, 300), (300, 100), (100, 1)]);

        assert!(process_descends_from_tracked_pid(
            500,
            &tracked_pids,
            |pid| parents.get(&pid).copied()
        ));
        assert_eq!(
            tracked_ancestor_pid(500, &tracked_pids, |pid| parents.get(&pid).copied()),
            Some(100),
        );
    }

    #[test]
    fn cli_send_does_not_treat_unrelated_process_as_agent_descendant() {
        let tracked_pids = HashSet::from([100]);
        let parents = HashMap::from([(500, 400), (400, 300), (300, 1)]);

        assert!(!process_descends_from_tracked_pid(
            500,
            &tracked_pids,
            |pid| parents.get(&pid).copied()
        ));
    }

    #[test]
    fn cli_send_decodes_explicit_newline_escapes() {
        assert_eq!(
            decode_send_newline_escapes("Title\\n\\n- item\\r\\nnext"),
            "Title\n\n- item\nnext"
        );
    }

    #[test]
    fn authority_history_pagination_uses_has_more_and_sequence_cursor() {
        let attachment =
            attachment_fixture::image_attachment("att-1", "screen.jpg", "image/jpeg", 42);
        let page = vec![
            history_message(
                "thread-root",
                "chan-1",
                0,
                "root".to_string(),
                attachment.clone(),
                "2026-08-10T00:00:00.000Z",
            ),
            history_message(
                "message-42",
                "chan-1",
                42,
                "newer".to_string(),
                attachment.clone(),
                "2026-08-10T00:00:01.000Z",
            ),
            history_message(
                "message-17",
                "chan-1",
                17,
                "older".to_string(),
                attachment,
                "2026-08-10T00:00:02.000Z",
            ),
        ];

        assert_eq!(
            super::next_history_before_sequence(&page, true).expect("next Authority page"),
            Some(17)
        );
        assert_eq!(
            super::next_history_before_sequence(&page, false).expect("final Authority page"),
            None
        );
    }

    #[test]
    fn channel_history_output_shows_attachment_presence() {
        let attachment = ChannelAttachment {
            data_url: "data:image/jpeg;base64,abcd".to_string(),
            ..attachment_fixture::image_attachment("att-1", "screen.jpg", "image/jpeg", 42)
        };
        let mut message = history_message(
            "msg-1",
            "chan-1",
            7,
            "screenshot".to_string(),
            attachment,
            "2026-05-14T13:53:59.010Z",
        );
        message.from = MessageSender {
            identity_id: Some("agent:user:codex".to_string()),
            kind: "agent".to_string(),
            label: "codex".to_string(),
            agent_name: Some("codex".to_string()),
            ..message.from
        };

        let output = format_history_message_at(&message, None);

        // Label/sequence styling may insert ANSI codes between tokens.
        assert!(output.contains("#7"));
        assert!(output.contains("codex"));
        assert!(output.contains("screenshot"));
        assert!(output.contains("[attachment] screen.jpg (42 bytes, image/jpeg, data)"));
    }

    #[test]
    fn a_thread_root_line_says_its_thread_was_archived_not_that_nobody_took_it() {
        let attachment = ChannelAttachment {
            id: "att-1".to_string(),
            kind: "image".to_string(),
            name: "screen.jpg".to_string(),
            mime_type: "image/jpeg".to_string(),
            size: 42,
            data_url: String::new(),
            channel_id: None,
            message_id: None,
            url: None,
        };
        let message = history_message(
            "root-1",
            "chan-1",
            9,
            "新消息点进去不消失提示".to_string(),
            attachment,
            "2026-09-18T20:00:00.000Z",
        );
        let threads = [OpenedChannelThread {
            channel_id: "a449feff".to_string(),
            root_message_id: "root-1".to_string(),
            name: Some("unread badge".to_string()),
        }];
        let output = super::format_history_message_with_local_images(
            &message,
            &HashMap::new(),
            None,
            &threads,
        );
        let header = output.lines().next().expect("header line");
        assert!(header.contains("[messageId=root-1]"));
        assert!(header.contains("[thread=a449feff: picked up; work continues in the thread]"));

        let other = super::format_history_message_with_local_images(
            &message,
            &HashMap::new(),
            None,
            &[OpenedChannelThread {
                root_message_id: "root-2".to_string(),
                ..threads[0].clone()
            }],
        );
        assert!(!other.contains("[thread="));
    }

    /// One history message built in one place. These tests differ only in the
    /// attachment they render; re-declaring the whole message in each of them is
    /// the same hand-copied shape this module just finished removing.
    fn history_message(
        message_id: &str,
        channel_id: &str,
        sequence: u64,
        body: String,
        attachment: ChannelAttachment,
        sent_at: &str,
    ) -> ChannelMessage {
        ChannelMessage {
            entity_version: None,
            body_hash: None,
            message_id: message_id.to_string(),
            channel_id: channel_id.to_string(),
            sequence: Some(sequence),
            from: MessageSender {
                identity_id: Some("user:yiming".to_string()),
                kind: "user".to_string(),
                label: "Yiming Hu".to_string(),
                user_id: "user-1".to_string(),
                email: "yiming@example.com".to_string(),
                agent_name: None,
                instance_id: None,
                instance_label: None,
                origin_channel_id: None,
                goal: None,
                model: None,
                workspace: None,
                workspace_name: None,
                avatar_url: None,
            },
            body,
            reply_to_message_id: None,
            reply_to: None,
            attachments: Some(vec![attachment]),
            metadata: None,
            app_mentions: None,
            mention_read_statuses: None,
            reactions: None,
            edited_at: None,
            edited_by: None,
            recalled_at: None,
            deleted_at: None,
            recalled_by: None,
            superseded_by: None,
            sent_at: sent_at.to_string(),
        }
    }

    #[test]
    fn channel_history_output_names_a_link_origin_and_its_reply_target() {
        let attachment: ChannelAttachment = serde_json::from_value(serde_json::json!({
            "id": "att-link", "kind": "file", "name": "a.txt", "mimeType": "text/plain", "size": 1
        }))
        .unwrap();
        let mut message = history_message(
            "m-2",
            "ch-b",
            2,
            "answer".to_string(),
            attachment,
            "2026-09-25T18:00:00Z",
        );
        message.attachments = None;
        message.from.origin_channel_id = Some("ch-a".to_string());
        message.reply_to_message_id = Some("m-1".to_string());
        let output = format_history_message_at(&message, None);
        let header = output.lines().next().unwrap();
        assert!(header.contains(" via Channel ch-a "), "{header}");
        assert!(
            header.contains("[messageId=m-2] [replyToMessageId=m-1]"),
            "{header}"
        );
    }

    #[test]
    fn channel_history_output_folds_activity_to_one_line() {
        let attachment: ChannelAttachment = serde_json::from_value(serde_json::json!({
            "id": "att-none", "kind": "file", "name": "a.txt", "mimeType": "text/plain", "size": 1
        }))
        .unwrap();
        let mut message = history_message(
            "activity:r-1",
            "ch-a",
            4,
            "✓ Run e2e · → Open PR 2".to_string(),
            attachment,
            "2026-09-27T18:27:00Z",
        );
        message.attachments = None;
        message.metadata = Some(serde_json::json!({
            "xmatrixProvenance": "activity",
            "xmatrixActivity": { "kind": "plan", "completed": ["Run e2e"],
                "inProgress": "Open PR 2", "steps": [] },
        }));
        let output = format_history_message_at(&message, None);
        assert_eq!(
            output.lines().filter(|line| !line.is_empty()).count(),
            1,
            "{output}"
        );
        assert!(output.contains("[messageId=activity:r-1]"), "{output}");
        assert!(output.contains("▸ ✓ Run e2e · → Open PR 2"), "{output}");
    }

    #[test]
    fn channel_history_output_names_where_a_relayed_reply_was_written() {
        let attachment: ChannelAttachment = serde_json::from_value(serde_json::json!({
            "id": "att-relay", "kind": "file", "name": "a.txt", "mimeType": "text/plain", "size": 1
        }))
        .unwrap();
        let mut message = history_message(
            "link-reply:r-9",
            "ch-a",
            3,
            "confirmed".to_string(),
            attachment,
            "2026-09-25T18:00:00Z",
        );
        message.attachments = None;
        message.metadata = Some(serde_json::json!({
            "xmatrixProvenance": "cross_channel_reply",
            "crossChannelReply": { "sourceChannelId": "ch-b", "sourceMessageId": "r-9" },
        }));
        let output = format_history_message_at(&message, None);
        let header = output.lines().next().unwrap();
        assert!(
            header.contains(
                " replying in Channel ch-b [sourceMessageId=r-9] [messageId=link-reply:r-9]"
            ),
            "{header}"
        );
    }

    #[test]
    fn channel_history_output_marks_identity_backed_attachment_without_missing_data() {
        let attachment = ChannelAttachment {
            channel_id: Some("ch-1".to_string()),
            message_id: Some("msg-1".to_string()),
            ..attachment_fixture::image_attachment(
                "att-identity",
                "screen.png",
                "image/png",
                138_382,
            )
        };
        let message = history_message(
            "msg-1",
            "ch-1",
            1,
            String::new(),
            attachment,
            "2026-07-31T17:47:28.302Z",
        );

        let output = format_history_message_at(&message, None);
        assert!(output.contains("[attachment] screen.png (138382 bytes, image/png, identity)"));
        assert!(output.contains("identity: channel=ch-1 message=msg-1 attachment=att-identity"));
        assert!(!output.contains("missing data"));
    }

    #[test]
    fn channel_history_output_prefers_local_materialized_path() {
        let attachment = ChannelAttachment {
            channel_id: Some("ch-1".to_string()),
            message_id: Some("msg-1".to_string()),
            ..attachment_fixture::image_attachment("att-local", "screen.png", "image/png", 12)
        };
        let message = history_message(
            "msg-1",
            "ch-1",
            1,
            String::new(),
            attachment,
            "2026-07-31T17:47:28.302Z",
        );
        let mut local = std::collections::HashMap::new();
        local.insert(
            ("msg-1".to_string(), "att-local".to_string()),
            std::path::PathBuf::from("/tmp/xmatrix-history-screen.png"),
        );
        let output = super::format_history_message_with_local_images(&message, &local, None, &[]);
        assert!(output.contains("image/png, local"));
        assert!(output.contains("local: /tmp/xmatrix-history-screen.png"));
        assert!(!output.contains("missing data"));
    }

    #[test]
    fn channel_history_output_marks_url_backed_attachment_as_url() {
        let attachment = attachment_fixture::stored_url_attachment();
        let message = history_message(
            "msg-1",
            "chan-1",
            1,
            String::new(),
            attachment,
            "2026-05-26T19:22:06.960Z",
        );

        let output = format_history_message_at(&message, None);

        assert!(output.contains("[attachment] stored.png (309777 bytes, image/png, url)"));
        assert!(output.contains(
            "url: https://xmatrix.sh/api/xmatrix/channels/ch-1/attachments/att-url?token=t"
        ));
        assert!(output.contains(
            "fetch: xmatrix attachment fetch 'https://xmatrix.sh/api/xmatrix/channels/ch-1/attachments/att-url?token=t'"
        ));
        assert!(!output.contains("missing data"));
    }

    #[test]
    fn channel_history_output_omits_fetch_command_for_non_http_url() {
        let attachment = ChannelAttachment {
            id: "att-blob".to_string(),
            kind: "image".to_string(),
            name: "mobile-shot.png".to_string(),
            mime_type: "image/png".to_string(),
            size: 136_866,
            channel_id: None,
            message_id: None,
            data_url: String::new(),
            url: Some("blob:https://xmatrix.sh/abc123".to_string()),
        };
        let message = history_message(
            "msg-1",
            "chan-1",
            1,
            String::new(),
            attachment,
            "2026-05-26T19:22:06.960Z",
        );

        let output = format_history_message_at(&message, None);

        assert!(output.contains("[attachment] mobile-shot.png (136866 bytes, image/png, url)"));
        assert!(output.contains("url: blob:https://xmatrix.sh/abc123"));
        assert!(!output.contains("xmatrix attachment fetch"));
    }

    #[test]
    fn channel_history_fetch_command_quotes_single_quotes_in_url() {
        assert_eq!(
            super::shell_quote("https://example.com/attachment?token=one'two"),
            "'https://example.com/attachment?token=one'\\''two'"
        );
    }
}
