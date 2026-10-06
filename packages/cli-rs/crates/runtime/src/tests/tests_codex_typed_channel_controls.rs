#[test]
fn codex_typed_channel_commands_keep_model_and_reasoning_out_of_prompt_text() {
    assert_eq!(
        super::parse_codex_typed_channel_command(" /model gpt-5.6-sol "),
        Some(super::CodexTypedChannelCommand::Model {
            model: "gpt-5.6-sol".to_string(),
        })
    );
    assert_eq!(
        super::parse_codex_typed_channel_command("/reasoning medium"),
        Some(super::CodexTypedChannelCommand::Effort {
            effort: "medium".to_string(),
        })
    );
    assert_eq!(
        super::parse_codex_typed_channel_command("/effort high"),
        Some(super::CodexTypedChannelCommand::Effort {
            effort: "high".to_string(),
        })
    );
    assert_eq!(
        super::parse_codex_typed_channel_command("/reasoning"),
        Some(super::CodexTypedChannelCommand::Effort {
            effort: "".to_string(),
        })
    );
    assert_eq!(
        super::parse_codex_typed_channel_command("/reasonings high"),
        None
    );
    assert_eq!(super::parse_codex_typed_channel_command("/review"), None);
}
