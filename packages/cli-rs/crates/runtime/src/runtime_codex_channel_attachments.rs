struct LocalImageFiles {
    paths: Vec<PathBuf>,
    image_paths: Vec<PathBuf>,
    by_id: HashMap<String, PathBuf>,
}

impl LocalImageFiles {
    fn empty() -> Self {
        Self {
            paths: Vec::new(),
            image_paths: Vec::new(),
            by_id: HashMap::new(),
        }
    }

    fn paths(&self) -> &[PathBuf] {
        &self.paths
    }

    fn image_paths(&self) -> &[PathBuf] {
        &self.image_paths
    }

    fn path_for(&self, attachment_id: &str) -> Option<&Path> {
        self.by_id.get(attachment_id).map(PathBuf::as_path)
    }

    #[cfg(test)]
    fn remember_path(&mut self, attachment_id: &str, path: PathBuf) {
        self.by_id.insert(attachment_id.to_string(), path);
    }

    fn push(&mut self, attachment: &protocol::ChannelAttachment, path: PathBuf) {
        self.by_id.insert(attachment.id.clone(), path.clone());
        if attachment.kind == "image" {
            self.image_paths.push(path.clone());
        }
        self.paths.push(path);
    }
}

impl Drop for LocalImageFiles {
    fn drop(&mut self) {
        for path in &self.paths {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
fn write_local_image_files(
    attachments: Option<&[protocol::ChannelAttachment]>,
) -> error::Result<LocalImageFiles> {
    let mut files = LocalImageFiles::empty();
    let Some(attachments) = attachments else {
        return Ok(files);
    };

    for attachment in attachments {
        if attachment.data_url.is_empty() {
            continue;
        }
        let bytes = decode_channel_image_attachment_data_url(attachment)?;
        let path = write_channel_image_attachment_bytes(attachment, &bytes)?;
        files.push(attachment, path);
    }

    Ok(files)
}

fn seed_attachment_download_bindings(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    attachments: &[protocol::ChannelAttachment],
) {
    // Birth / auto-join channel is always in-scope for product-media on this run.
    if let Ok(auto_join) = std::env::var("XMATRIX_AUTO_JOIN_CHANNEL_ID") {
        relay.allow_attachment_download_channel(auto_join.trim());
    }
    // Hub-issued attachment coordinates (including thread-root images whose
    // channelId can differ from the auto-join channel) must pass the client
    // gate before product-media HTTP. Hub still rechecks authority.
    for attachment in attachments {
        if let Some(channel_id) = attachment
            .channel_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            relay.allow_attachment_download_channel(channel_id);
        }
    }
}

async fn materialize_local_image_files(
    attachments: Option<&[protocol::ChannelAttachment]>,
    relay: Option<&agent_instance_connection::AgentInstanceConnectionClient>,
) -> error::Result<LocalImageFiles> {
    let Some(attachments) = attachments else {
        return Ok(LocalImageFiles::empty());
    };

    if let Some(relay) = relay {
        seed_attachment_download_bindings(relay, attachments);
    }

    let mut files = LocalImageFiles::empty();
    for attachment in attachments {
        match load_attachment_bytes(attachment, relay).await {
            Ok(Some(bytes)) => {
                let path = write_channel_image_attachment_bytes(attachment, &bytes)?;
                files.push(attachment, path);
            }
            Ok(None) => {}
            Err(err) => {
                return Err(err);
            }
        }
    }

    Ok(files)
}

/// Initial-message image materialize must not fail wrapper startup. Inbound
/// channel messages already treat download errors as non-fatal; birth-message
/// images (including thread-root attachments) must match so a single media
/// gate miss cannot leave a ghost "online" instance that never receives chat.
async fn materialize_initial_message_image_files(
    attachments: Option<&[protocol::ChannelAttachment]>,
    relay: Option<&agent_instance_connection::AgentInstanceConnectionClient>,
) -> LocalImageFiles {
    image_files_or_empty(
        materialize_local_image_files(attachments, relay).await,
        "initial message channel",
    )
}

/// Inbound channel images are best-effort too: a failed download leaves the
/// message's prompt without its local copies instead of dropping the message.
async fn materialize_inbound_image_files(
    attachments: Option<&[protocol::ChannelAttachment]>,
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
) -> LocalImageFiles {
    image_files_or_empty(
        materialize_local_image_files(attachments, Some(relay)).await,
        "inbound channel",
    )
}

fn image_files_or_empty(files: error::Result<LocalImageFiles>, origin: &str) -> LocalImageFiles {
    files.unwrap_or_else(|err| {
        eprintln!(
            "{} Failed to materialize {origin} images: {err}",
            "⚠".yellow().bold()
        );
        LocalImageFiles::empty()
    })
}

async fn load_attachment_bytes(
    attachment: &protocol::ChannelAttachment,
    relay: Option<&agent_instance_connection::AgentInstanceConnectionClient>,
) -> error::Result<Option<Vec<u8>>> {
    if let Some(bytes) = attachment_cache::read_cached_attachment_bytes(attachment) {
        return Ok(Some(bytes));
    }
    let bytes = if !attachment.data_url.is_empty() {
        decode_channel_image_attachment_data_url(attachment)?
    } else {
        let direct_url = attachment
            .url
            .as_deref()
            .filter(|value| !value.is_empty())
            .filter(|value| value.starts_with("http://") || value.starts_with("https://"));
        if let Some(url) = direct_url {
            download_channel_image_attachment_url(url, attachment).await?
        } else {
            let (Some(relay), Some(channel_id), Some(message_id)) = (
                relay,
                attachment.channel_id.as_deref(),
                attachment.message_id.as_deref(),
            ) else {
                return Err(CliError::Launch(format!(
                    "Channel attachment {} omitted its body and owner coordinates",
                    attachment.name
                )));
            };
            if channel_id.trim().is_empty()
                || message_id.trim().is_empty()
                || attachment.id.trim().is_empty()
            {
                return Err(CliError::Launch(format!(
                    "Channel attachment {} omitted its body and owner coordinates",
                    attachment.name
                )));
            }
            let download = relay
                .download_channel_attachment(
                    channel_id,
                    message_id,
                    &attachment.id,
                    attachment.size,
                )
                .await
                .map_err(|err| {
                    CliError::Launch(format!(
                        "Failed to download channel attachment {}: {err}",
                        attachment.name
                    ))
                })?;
            if !attachment.mime_type.is_empty()
                && !download
                    .mime_type
                    .eq_ignore_ascii_case(&attachment.mime_type)
            {
                return Err(CliError::Launch(format!(
                    "Channel attachment {} MIME type does not match authority",
                    attachment.name
                )));
            }
            download.bytes
        }
    };
    if bytes.is_empty() {
        return Ok(None);
    }
    if attachment.size > 0 && bytes.len() as u64 != attachment.size {
        return Err(CliError::Launch(format!(
            "Channel attachment {} body length does not match authority",
            attachment.name
        )));
    }
    let _ = attachment_cache::store_cached_attachment_bytes(attachment, &bytes);
    Ok(Some(bytes))
}

async fn download_channel_image_attachment_url(
    url: &str,
    attachment: &protocol::ChannelAttachment,
) -> error::Result<Vec<u8>> {
    let response = reqwest_client().get(url).send().await.map_err(|err| {
        CliError::Launch(format!(
            "Failed to download channel attachment {}: {err}",
            attachment.name
        ))
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(CliError::Launch(format!(
            "Failed to download channel attachment {}: HTTP {status}",
            attachment.name
        )));
    }
    let bytes = response.bytes().await.map_err(|err| {
        CliError::Launch(format!(
            "Failed to read channel attachment {}: {err}",
            attachment.name
        ))
    })?;
    Ok(bytes.to_vec())
}

fn write_channel_image_attachment_bytes(
    attachment: &protocol::ChannelAttachment,
    bytes: &[u8],
) -> error::Result<PathBuf> {
    let extension = attachment_ephemeral_extension(attachment);
    let dir = std::env::temp_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!(
        "xmatrix-attachment-{}-{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4(),
        extension
    ));
    std::fs::write(&path, bytes)?;
    Ok(path)
}

fn attachment_ephemeral_extension(attachment: &protocol::ChannelAttachment) -> &'static str {
    match attachment.mime_type.to_ascii_lowercase().as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "text/markdown" => "md",
        "text/plain" => "txt",
        "application/pdf" => "pdf",
        "application/zip" => "zip",
        "application/json" => "json",
        _ => match Path::new(&attachment.name)
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("png") => "png",
            Some("jpg" | "jpeg") => "jpg",
            Some("webp") => "webp",
            Some("gif") => "gif",
            Some("mp4") => "mp4",
            Some("webm") => "webm",
            Some("md" | "markdown") => "md",
            Some("txt") => "txt",
            Some("pdf") => "pdf",
            Some("zip") => "zip",
            Some("json") => "json",
            _ => "bin",
        },
    }
}

fn decode_channel_image_attachment_data_url(
    attachment: &protocol::ChannelAttachment,
) -> error::Result<Vec<u8>> {
    let (header, encoded) = attachment
        .data_url
        .trim()
        .split_once(',')
        .ok_or_else(|| CliError::Launch("Invalid channel image attachment data URL".into()))?;
    let Some((scheme, metadata)) = header.split_once(':') else {
        return Err(CliError::Launch(
            "Invalid channel image attachment data URL".into(),
        ));
    };
    if !scheme.eq_ignore_ascii_case("data") {
        return Err(CliError::Launch(
            "Invalid channel image attachment data URL".into(),
        ));
    }
    let mut metadata_parts = metadata.split(';');
    let media_type = metadata_parts
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliError::Launch("Invalid channel image attachment data URL".into()))?;
    let has_base64_marker = metadata_parts.any(|part| part.eq_ignore_ascii_case("base64"));
    if !media_type.eq_ignore_ascii_case(&attachment.mime_type) || !has_base64_marker {
        return Err(CliError::Launch(
            "Invalid channel image attachment data URL".into(),
        ));
    }

    base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|err| CliError::Launch(format!("Invalid channel image attachment: {err}")))
}
