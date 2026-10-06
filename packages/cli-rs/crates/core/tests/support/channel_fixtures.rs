use crate::protocol::{ChannelMessage, MessageSender};

pub(crate) fn sender(
    identity_id: Option<&str>,
    kind: &str,
    label: &str,
    user_id: &str,
    email: &str,
) -> MessageSender {
    MessageSender {
        identity_id: identity_id.map(str::to_string),
        kind: kind.into(),
        label: label.into(),
        user_id: user_id.into(),
        email: email.into(),
        agent_name: None,
        instance_id: None,
        instance_label: None,
        origin_channel_id: None,
        goal: None,
        model: None,
        workspace: None,
        workspace_name: None,
        avatar_url: None,
    }
}

pub(crate) fn message(
    message_id: &str,
    channel_id: &str,
    sequence: Option<u64>,
    from: MessageSender,
    body: &str,
    sent_at: &str,
) -> ChannelMessage {
    ChannelMessage {
        entity_version: None,
        body_hash: None,
        message_id: message_id.into(),
        channel_id: channel_id.into(),
        sequence,
        from,
        body: body.into(),
        reply_to_message_id: None,
        reply_to: None,
        attachments: None,
        app_mentions: None,
        metadata: None,
        mention_read_statuses: None,
        reactions: None,
        edited_at: None,
        edited_by: None,
        recalled_at: None,
        deleted_at: None,
        recalled_by: None,
        superseded_by: None,
        sent_at: sent_at.into(),
    }
}
