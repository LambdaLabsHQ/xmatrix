use super::*;
use xmatrix_cli_core::channel_read_context::{OpenedChannelThread, render_channel_read_context};

/// What one read of a Channel knows before its first transcript line.
pub struct ChannelReadContext {
    /// The rendered `## Channel context (read-only)` block.
    pub text: String,
    /// The same threads the block lists, kept structured so each transcript
    /// line can carry its own thread state instead of relying on the reader
    /// to cross-reference the block.
    pub threads: Vec<OpenedChannelThread>,
}

/// The catalog read narrowed to one Channel and its direct children. An older
/// Hub ignores the parameter and answers with the complete catalog, which
/// `render_context` filters to the same result.
fn channel_family_route(channel_id: &str) -> String {
    format!(
        "{}?familyOfChannelId={}",
        HubRoutes::CHANNELS,
        urlencoding::encode(channel_id)
    )
}

/// Read the authorized directory afresh: history caches must not freeze Summary or thread links.
pub async fn load_channel_read_context(
    hub_url: &str,
    token: &str,
    channel_id: &str,
) -> error::Result<ChannelReadContext> {
    #[derive(Deserialize)]
    struct Response {
        channels: Vec<protocol::SerializedChannel>,
    }
    let response: Response = http::request_json(
        &with_route(hub_url, &channel_family_route(channel_id)),
        "GET",
        Some(token),
        None,
    )
    .await?;
    render_context(&response.channels, channel_id)
}

fn render_context(
    channels: &[protocol::SerializedChannel],
    channel_id: &str,
) -> error::Result<ChannelReadContext> {
    let channel = channels
        .iter()
        .find(|channel| channel.id == channel_id)
        .ok_or_else(|| {
            CliError::Launch("Channel context is not in the authorized directory".into())
        })?;
    let mut threads = channels
        .iter()
        .filter_map(|child| {
            let metadata = child.metadata.as_ref()?;
            if metadata.get("kind")?.as_str()? != "thread"
                || metadata.get("threadRootChannelId")?.as_str()? != channel_id
            {
                return None;
            }
            let root_message_id = metadata.get("threadRootMessageId")?.as_str()?;
            if root_message_id.is_empty() {
                return None;
            }
            Some(OpenedChannelThread {
                channel_id: child.id.clone(),
                root_message_id: root_message_id.into(),
                name: child.name.clone(),
            })
        })
        .collect::<Vec<_>>();
    threads.sort_by(|a, b| {
        a.root_message_id
            .cmp(&b.root_message_id)
            .then(a.channel_id.cmp(&b.channel_id))
    });
    let text = render_channel_read_context(
        channel.summary.as_deref(),
        channel.summary_source.as_ref(),
        &threads,
    );
    Ok(ChannelReadContext { text, threads })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn channel(id: &str, metadata: serde_json::Value) -> protocol::SerializedChannel {
        serde_json::from_value(serde_json::json!({
            "id": id, "metadata": metadata,
            "summary": "Implementation is already in the thread.",
            "mode": "open", "createdBy": "user", "createdAt": "2026-09-13"
        }))
        .unwrap()
    }

    #[test]
    fn read_context_requests_only_the_channel_family() {
        assert_eq!(
            channel_family_route("c/1 2"),
            format!("{}?familyOfChannelId=c%2F1%202", HubRoutes::CHANNELS)
        );
    }

    #[test]
    fn history_context_links_only_visible_threads_to_the_exact_root() {
        let thread = serde_json::json!({"kind": "thread", "threadRootChannelId": "parent", "threadRootMessageId": "root-message"});
        let channels = vec![
            channel("parent", serde_json::Value::Null),
            channel("opened", thread),
            channel("ordinary", serde_json::json!({})),
            channel(
                "wrong-root",
                serde_json::json!({"kind":"thread", "threadRootChannelId":"other", "threadRootMessageId":"secret"}),
            ),
        ];
        let context = render_context(&channels, "parent").unwrap();
        let output = context.text;
        assert_eq!(context.threads.len(), 1);
        assert_eq!(context.threads[0].channel_id, "opened");
        assert!(output.contains("Implementation is already in the thread."));
        assert!(output.contains("\"channelId\":\"opened\""));
        assert!(output.contains("\"rootMessageId\":\"root-message\""));
        assert!(!output.contains("\"ordinary\""));
        assert!(!output.contains("secret"));
        assert!(render_context(&channels, "inaccessible").is_err());
    }
}
