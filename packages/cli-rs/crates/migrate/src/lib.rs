use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use xmatrix_cli_core::error::{CliError, Result};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackMigrationPayload {
    pub workspace_name: String,
    pub space_name: String,
    pub history_mode: String,
    pub channels: Vec<SlackMigrationChannel>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackMigrationChannel {
    pub slack_id: Option<String>,
    pub name: String,
    pub is_private: bool,
    pub is_archived: bool,
    pub topic: Option<String>,
    pub messages: Vec<SlackMigrationMessage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackMigrationMessage {
    pub slack_ts: String,
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_email: Option<String>,
    pub user_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub text: String,
}

#[derive(Debug)]
pub struct SlackExportStats {
    pub channel_count: usize,
    pub message_count: usize,
}

#[derive(Debug, Clone)]
struct SlackUserIdentity {
    name: String,
    email: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SlackUser {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    real_name: Option<String>,
    #[serde(default)]
    profile: Option<SlackUserProfile>,
}

#[derive(Debug, Deserialize)]
struct SlackUserProfile {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    real_name: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    image_192: Option<String>,
    #[serde(default)]
    image_72: Option<String>,
    #[serde(default)]
    image_48: Option<String>,
    #[serde(default)]
    image_32: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SlackConversation {
    id: String,
    name: String,
    #[serde(default)]
    is_archived: bool,
    #[serde(default)]
    is_private: bool,
    #[serde(default)]
    topic: Option<SlackTopic>,
}

#[derive(Debug, Clone, Deserialize)]
struct SlackTopic {
    #[serde(default)]
    value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SlackMessage {
    ts: String,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    bot_profile: Option<SlackBotProfile>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    files: Vec<SlackFile>,
}

#[derive(Debug, Clone, Deserialize)]
struct SlackBotProfile {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    icons: Option<SlackBotIcons>,
}

#[derive(Debug, Clone, Deserialize)]
struct SlackBotIcons {
    #[serde(default)]
    image_72: Option<String>,
    #[serde(default)]
    image_48: Option<String>,
    #[serde(default)]
    image_36: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SlackFile {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    url_private: Option<String>,
    #[serde(default)]
    permalink: Option<String>,
}

struct ExportJson {
    path: String,
    contents: String,
}

fn migration_space_name(workspace_name: &str, override_name: Option<String>) -> String {
    override_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("{workspace_name} Slack"))
}

fn migration_channel_topic(conversation: Option<&SlackConversation>) -> Option<String> {
    conversation
        .and_then(|conversation| conversation.topic.as_ref())
        .and_then(|topic| topic.value.as_deref())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn load_slack_export(
    export_path: &Path,
    include_archived: bool,
    max_messages_per_channel: usize,
    history_mode: String,
    space_name_override: Option<String>,
) -> Result<SlackMigrationPayload> {
    let json_files = read_export_json_files(export_path)?;
    if json_files.is_empty() {
        return Err(CliError::Launch(
            "Slack export does not contain JSON files".into(),
        ));
    }

    let workspace_name = export_path
        .file_stem()
        .and_then(|name| name.to_str())
        .map(clean_workspace_name)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Slack import".to_string());
    let space_name = migration_space_name(&workspace_name, space_name_override);

    let users = load_users(&json_files)?;
    let conversations = load_conversations(&json_files)?;
    let mut messages_by_channel = load_messages(&json_files)?;

    let mut channels = Vec::new();
    for (channel_name, mut messages) in messages_by_channel.drain() {
        let conversation = conversations.get(&channel_name);
        let is_archived = conversation.map(|c| c.is_archived).unwrap_or(false);
        if is_archived && !include_archived {
            continue;
        }

        messages.sort_by(|left, right| compare_slack_ts(&left.ts, &right.ts));
        if max_messages_per_channel > 0 && messages.len() > max_messages_per_channel {
            let start = messages.len() - max_messages_per_channel;
            messages = messages.split_off(start);
        }

        let migrated_messages = messages
            .into_iter()
            .filter_map(|message| normalize_message(message, &users))
            .collect::<Vec<_>>();

        if migrated_messages.is_empty() {
            continue;
        }

        channels.push(SlackMigrationChannel {
            slack_id: conversation.map(|c| c.id.clone()),
            name: conversation
                .map(|c| c.name.clone())
                .unwrap_or_else(|| channel_name.clone()),
            is_private: conversation.map(|c| c.is_private).unwrap_or(false),
            is_archived,
            topic: migration_channel_topic(conversation),
            messages: migrated_messages,
        });
    }

    channels.sort_by(|left, right| left.name.cmp(&right.name));

    if channels.is_empty() {
        return Err(CliError::Launch(
            "No Slack channel messages found to migrate".into(),
        ));
    }

    Ok(SlackMigrationPayload {
        workspace_name,
        space_name,
        history_mode,
        channels,
    })
}

pub fn stats(payload: &SlackMigrationPayload) -> SlackExportStats {
    SlackExportStats {
        channel_count: payload.channels.len(),
        message_count: payload
            .channels
            .iter()
            .map(|channel| channel.messages.len())
            .sum(),
    }
}

pub async fn load_slack_workspace(
    slack_token: &str,
    include_archived: bool,
    max_messages_per_channel: usize,
    history_mode: String,
    space_name_override: Option<String>,
) -> Result<SlackMigrationPayload> {
    let client = reqwest::Client::new();
    let auth = slack_api_get::<SlackAuthTest>(&client, slack_token, "auth.test", &[]).await?;
    let workspace_name = auth
        .team
        .map(|team| team.trim().to_string())
        .filter(|team| !team.is_empty())
        .unwrap_or_else(|| "Slack".to_string());
    let space_name = migration_space_name(&workspace_name, space_name_override);

    let users = load_users_from_slack_api(&client, slack_token).await?;
    let conversations =
        load_conversations_from_slack_api(&client, slack_token, include_archived).await?;
    if conversations.is_empty() {
        return Err(CliError::Launch(
            "Slack API returned no accessible public or private channels".into(),
        ));
    }

    let oldest = if history_mode == "free" {
        Some((unix_now_secs().saturating_sub(90 * 24 * 60 * 60)).to_string())
    } else {
        None
    };

    let mut channels = Vec::new();
    for conversation in conversations {
        let messages = load_channel_history_from_slack_api(
            &client,
            slack_token,
            &conversation.id,
            max_messages_per_channel,
            oldest.as_deref(),
        )
        .await?;
        let mut migrated_messages = messages
            .into_iter()
            .filter_map(|message| normalize_message(message, &users))
            .collect::<Vec<_>>();
        migrated_messages.sort_by(|left, right| compare_slack_ts(&left.slack_ts, &right.slack_ts));

        let topic = migration_channel_topic(Some(&conversation));
        channels.push(SlackMigrationChannel {
            slack_id: Some(conversation.id),
            name: conversation.name,
            is_private: conversation.is_private,
            is_archived: conversation.is_archived,
            topic,
            messages: migrated_messages,
        });
    }

    channels.sort_by(|left, right| left.name.cmp(&right.name));

    Ok(SlackMigrationPayload {
        workspace_name,
        space_name,
        history_mode,
        channels,
    })
}

fn read_export_json_files(export_path: &Path) -> Result<Vec<ExportJson>> {
    if export_path.is_dir() {
        let mut files = Vec::new();
        read_json_files_from_dir(export_path, export_path, &mut files)?;
        return Ok(files);
    }

    if export_path.is_file()
        && export_path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return read_json_files_from_zip(export_path);
    }

    Err(CliError::Launch(format!(
        "Slack export path must be a .zip file or directory: {}",
        export_path.display()
    )))
}

#[derive(Debug, Deserialize)]
struct SlackAuthTest {
    #[serde(default)]
    team: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SlackResponseMetadata {
    #[serde(default)]
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SlackUsersListResponse {
    #[serde(default)]
    members: Vec<SlackUser>,
    #[serde(default)]
    response_metadata: Option<SlackResponseMetadata>,
}

#[derive(Debug, Deserialize)]
struct SlackConversationsListResponse {
    #[serde(default)]
    channels: Vec<SlackConversation>,
    #[serde(default)]
    response_metadata: Option<SlackResponseMetadata>,
}

#[derive(Debug, Deserialize)]
struct SlackHistoryResponse {
    #[serde(default)]
    messages: Vec<SlackMessage>,
    #[serde(default)]
    response_metadata: Option<SlackResponseMetadata>,
}

async fn load_users_from_slack_api(
    client: &reqwest::Client,
    slack_token: &str,
) -> Result<HashMap<String, SlackUserIdentity>> {
    let mut cursor: Option<String> = None;
    let mut users = HashMap::new();

    loop {
        let mut params = vec![("limit", "200".to_string())];
        if let Some(cursor_value) = cursor.as_deref() {
            params.push(("cursor", cursor_value.to_string()));
        }
        let response =
            slack_api_get::<SlackUsersListResponse>(client, slack_token, "users.list", &params)
                .await?;
        for user in response.members {
            let identity = slack_user_identity(&user);
            users.insert(user.id, identity);
        }

        cursor = response
            .response_metadata
            .and_then(|metadata| metadata.next_cursor)
            .filter(|value| !value.is_empty());
        if cursor.is_none() {
            break;
        }
    }

    Ok(users)
}

async fn load_conversations_from_slack_api(
    client: &reqwest::Client,
    slack_token: &str,
    include_archived: bool,
) -> Result<Vec<SlackConversation>> {
    let mut cursor: Option<String> = None;
    let mut conversations = Vec::new();

    loop {
        let exclude_archived = if include_archived { "false" } else { "true" };
        let mut params = vec![
            ("types", "public_channel,private_channel".to_string()),
            ("exclude_archived", exclude_archived.to_string()),
            ("limit", "200".to_string()),
        ];
        if let Some(cursor_value) = cursor.as_deref() {
            params.push(("cursor", cursor_value.to_string()));
        }
        let response = slack_api_get::<SlackConversationsListResponse>(
            client,
            slack_token,
            "conversations.list",
            &params,
        )
        .await?;
        conversations.extend(response.channels);

        cursor = response
            .response_metadata
            .and_then(|metadata| metadata.next_cursor)
            .filter(|value| !value.is_empty());
        if cursor.is_none() {
            break;
        }
    }

    Ok(conversations)
}

async fn load_channel_history_from_slack_api(
    client: &reqwest::Client,
    slack_token: &str,
    channel_id: &str,
    max_messages: usize,
    oldest: Option<&str>,
) -> Result<Vec<SlackMessage>> {
    let mut cursor: Option<String> = None;
    let mut messages = Vec::new();

    loop {
        let mut params = vec![
            ("channel", channel_id.to_string()),
            ("limit", "200".to_string()),
        ];
        if let Some(cursor_value) = cursor.as_deref() {
            params.push(("cursor", cursor_value.to_string()));
        }
        if let Some(oldest_value) = oldest {
            params.push(("oldest", oldest_value.to_string()));
        }

        let response = slack_api_get::<SlackHistoryResponse>(
            client,
            slack_token,
            "conversations.history",
            &params,
        )
        .await?;
        messages.extend(response.messages);

        if max_messages > 0 && messages.len() >= max_messages {
            messages.truncate(max_messages);
            break;
        }

        cursor = response
            .response_metadata
            .and_then(|metadata| metadata.next_cursor)
            .filter(|value| !value.is_empty());
        if cursor.is_none() {
            break;
        }
    }

    Ok(messages)
}

async fn slack_api_get<T: DeserializeOwned>(
    client: &reqwest::Client,
    slack_token: &str,
    method: &str,
    params: &[(&str, String)],
) -> Result<T> {
    let query = params
        .iter()
        .map(|(key, value)| format!("{key}={}", urlencoding::encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let url = if query.is_empty() {
        format!("https://slack.com/api/{method}")
    } else {
        format!("https://slack.com/api/{method}?{query}")
    };
    let response = client.get(url).bearer_auth(slack_token).send().await?;
    let status = response.status();
    let payload = response.json::<serde_json::Value>().await?;
    if !status.is_success() || payload.get("ok").and_then(|value| value.as_bool()) != Some(true) {
        let error = payload
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or("Slack API request failed");
        return Err(CliError::Http(format!("Slack {method} failed: {error}")));
    }

    Ok(serde_json::from_value(payload)?)
}

fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn read_json_files_from_dir(base: &Path, dir: &Path, files: &mut Vec<ExportJson>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            read_json_files_from_dir(base, &path, files)?;
            continue;
        }

        if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
        {
            let relative_path = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            files.push(ExportJson {
                path: relative_path,
                contents: fs::read_to_string(&path)?,
            });
        }
    }

    Ok(())
}

fn read_json_files_from_zip(export_path: &Path) -> Result<Vec<ExportJson>> {
    let file = File::open(export_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(zip_error)?;
    let mut files = Vec::new();

    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(zip_error)?;
        if file.is_dir() || !file.name().ends_with(".json") {
            continue;
        }

        let mut contents = String::new();
        file.read_to_string(&mut contents)?;
        files.push(ExportJson {
            path: normalize_export_path(file.name()),
            contents,
        });
    }

    Ok(files)
}

fn zip_error(err: zip::result::ZipError) -> CliError {
    CliError::Launch(format!("Could not read Slack export zip: {err}"))
}

fn load_users(files: &[ExportJson]) -> Result<HashMap<String, SlackUserIdentity>> {
    let mut users = HashMap::new();
    for file in files {
        if export_basename(&file.path) != "users.json" {
            continue;
        }

        let parsed = serde_json::from_str::<Vec<SlackUser>>(&file.contents)?;
        for user in parsed {
            let identity = slack_user_identity(&user);
            users.insert(user.id, identity);
        }
    }

    Ok(users)
}

fn slack_user_identity(user: &SlackUser) -> SlackUserIdentity {
    let profile = user.profile.as_ref();
    let name = profile
        .and_then(|profile| profile.display_name.as_ref())
        .or(profile.and_then(|profile| profile.real_name.as_ref()))
        .or(user.real_name.as_ref())
        .or(user.name.as_ref())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| user.id.clone());
    let avatar_url = profile.and_then(profile_avatar_url);
    let email = profile
        .and_then(|profile| profile.email.as_ref())
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());

    SlackUserIdentity {
        name,
        email,
        avatar_url,
    }
}

fn load_conversations(files: &[ExportJson]) -> Result<HashMap<String, SlackConversation>> {
    let mut conversations = HashMap::new();
    for file in files {
        let basename = export_basename(&file.path);
        if !matches!(basename.as_str(), "channels.json" | "groups.json") {
            continue;
        }

        let parsed = serde_json::from_str::<Vec<SlackConversation>>(&file.contents)?;
        for conversation in parsed {
            conversations.insert(conversation.name.clone(), conversation);
        }
    }

    Ok(conversations)
}

fn load_messages(files: &[ExportJson]) -> Result<HashMap<String, Vec<SlackMessage>>> {
    let mut messages_by_channel: HashMap<String, Vec<SlackMessage>> = HashMap::new();
    for file in files {
        if !is_slack_message_file(&file.path) {
            continue;
        }

        let Some(channel_name) = export_channel_name(&file.path) else {
            continue;
        };
        let parsed = serde_json::from_str::<Vec<SlackMessage>>(&file.contents)?;
        messages_by_channel
            .entry(channel_name)
            .or_default()
            .extend(parsed);
    }

    Ok(messages_by_channel)
}

fn normalize_message(
    message: SlackMessage,
    users: &HashMap<String, SlackUserIdentity>,
) -> Option<SlackMigrationMessage> {
    let mut text = message.text.unwrap_or_default().trim().to_string();
    for file in message.files {
        let label = file
            .title
            .or(file.name)
            .unwrap_or_else(|| "file".to_string());
        let url = file.permalink.or(file.url_private).unwrap_or_default();
        if !text.is_empty() {
            text.push('\n');
        }
        if url.is_empty() {
            text.push_str(&format!("[Slack file] {label}"));
        } else {
            text.push_str(&format!("[Slack file] {label} {url}"));
        }
    }

    if text.is_empty() {
        return None;
    }

    let user_identity = message.user.as_ref().and_then(|user_id| users.get(user_id));
    let user_name = user_identity
        .map(|identity| identity.name.clone())
        .or(message.username)
        .or_else(|| {
            message
                .bot_profile
                .as_ref()
                .and_then(|bot| bot.name.clone())
        })
        .unwrap_or_else(|| "Slack".to_string());
    let avatar_url = user_identity
        .and_then(|identity| identity.avatar_url.clone())
        .or_else(|| message.bot_profile.as_ref().and_then(bot_avatar_url));

    Some(SlackMigrationMessage {
        slack_ts: message.ts,
        user_id: message.user,
        user_email: user_identity.and_then(|identity| identity.email.clone()),
        user_name,
        avatar_url,
        text,
    })
}

fn profile_avatar_url(profile: &SlackUserProfile) -> Option<String> {
    profile
        .image_192
        .as_ref()
        .or(profile.image_72.as_ref())
        .or(profile.image_48.as_ref())
        .or(profile.image_32.as_ref())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn bot_avatar_url(bot: &SlackBotProfile) -> Option<String> {
    bot.icons.as_ref().and_then(|icons| {
        icons
            .image_72
            .as_ref()
            .or(icons.image_48.as_ref())
            .or(icons.image_36.as_ref())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn is_slack_message_file(path: &str) -> bool {
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.len() != 2 {
        return false;
    }

    let filename = parts[1];
    filename.len() == "0000-00-00.json".len()
        && filename.ends_with(".json")
        && filename.as_bytes().get(4) == Some(&b'-')
        && filename.as_bytes().get(7) == Some(&b'-')
}

fn export_channel_name(path: &str) -> Option<String> {
    path.split('/').next().map(|part| part.to_string())
}

fn export_basename(path: &str) -> String {
    PathBuf::from(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_string()
}

fn normalize_export_path(path: &str) -> String {
    path.replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/")
}

fn clean_workspace_name(name: &str) -> String {
    name.trim()
        .trim_end_matches(".zip")
        .replace(['_', '-'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn compare_slack_ts(left: &str, right: &str) -> std::cmp::Ordering {
    let left = left.parse::<f64>().unwrap_or(0.0);
    let right = right.parse::<f64>().unwrap_or(0.0);
    left.partial_cmp(&right)
        .unwrap_or(std::cmp::Ordering::Equal)
}
