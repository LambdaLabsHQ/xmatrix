use xmatrix_cli_core::protocol::ChannelAttachment;

pub(crate) fn image_attachment(
    id: &str,
    name: &str,
    mime_type: &str,
    size: u64,
) -> ChannelAttachment {
    ChannelAttachment {
        id: id.into(),
        kind: "image".into(),
        name: name.into(),
        mime_type: mime_type.into(),
        size,
        channel_id: None,
        message_id: None,
        data_url: String::new(),
        url: None,
    }
}

pub(crate) fn stored_url_attachment() -> ChannelAttachment {
    ChannelAttachment {
        url: Some(
            "https://xmatrix.sh/api/xmatrix/channels/ch-1/attachments/att-url?token=t".into(),
        ),
        ..image_attachment("att-url", "stored.png", "image/png", 309_777)
    }
}
