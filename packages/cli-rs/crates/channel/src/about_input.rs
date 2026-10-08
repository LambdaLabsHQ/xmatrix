//! Direct text input for the Channel's database-backed About. No local files.

use serde::Deserialize;
use tokio::io::AsyncReadExt;
use xmatrix_cli_core::error::{self, CliError};
use xmatrix_cli_core::text_input::{self, TextRoutes, TextSource};

const MAX_STDIN_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AboutInput {
    pub summary: String,
    pub name: Option<String>,
}

pub(crate) async fn read(
    summary: Option<String>,
    name: Option<String>,
    stdin: bool,
) -> error::Result<AboutInput> {
    if stdin {
        let mut bytes = Vec::new();
        tokio::io::stdin()
            .take((MAX_STDIN_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map_err(|error| CliError::Launch(format!("read About stdin: {error}")))?;
        return parse_stdin(bytes);
    }
    validate(
        AboutInput {
            summary: summary.unwrap_or_default(),
            name,
        },
        TextSource::Argument,
    )
}

fn parse_stdin(bytes: Vec<u8>) -> error::Result<AboutInput> {
    if bytes.len() > MAX_STDIN_BYTES {
        return Err(CliError::Launch(
            "About JSON stdin exceeds 64 KiB; nothing was sent".into(),
        ));
    }
    let json = text_input::decode_utf8_input(bytes, "About stdin")?;
    let input = serde_json::from_str(&json).map_err(|_| {
        // Do not echo input values or JSON fragments in an error.
        CliError::Launch(
            "About stdin must be a JSON object with string summary and optional string name; no other fields are accepted. Nothing was sent".into(),
        )
    })?;
    validate(input, TextSource::Stdin)
}

fn validate(input: AboutInput, source: TextSource) -> error::Result<AboutInput> {
    let routes = TextRoutes {
        stdin: true,
        file_flag: None,
    };
    text_input::ensure_text_intact("channel About summary", &input.summary, source, routes)?;
    if input.summary.trim().is_empty() {
        return Err(CliError::Launch(
            "channel About summary is required; nothing was sent".into(),
        ));
    }
    if let Some(name) = &input.name {
        text_input::ensure_text_intact("channel name", name, source, routes)?;
    }
    Ok(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_summary_and_title_travel_together_without_files() {
        for json in [
            r#"{"summary":"中文摘要","name":"频道标题"}"#,
            r#"{"summary":"\u4e2d\u6587\u6458\u8981","name":"\u9891\u9053\u6807\u9898"}"#,
        ] {
            let input = parse_stdin(json.as_bytes().to_vec()).unwrap();
            assert_eq!(input.summary, "中文摘要");
            assert_eq!(input.name.as_deref(), Some("频道标题"));
        }
        assert!(
            parse_stdin(br#"{"summary":"Summary"}"#.to_vec())
                .unwrap()
                .name
                .is_none()
        );
    }

    #[test]
    fn bad_or_unsupported_input_never_becomes_a_hub_update() {
        for json in [
            "not json",
            r#"{"name":"title"}"#,
            r#"{"summary":42}"#,
            r#"{"summary":" "}"#,
            r#"{"summary":"s","name":42}"#,
            r#"{"summary":"s","channelId":"foreign-channel"}"#,
            r#"{"summary":"s","expectedRevision":42}"#,
            r#"{"summary":"s","summary-file":"old.txt"}"#,
            r#"{"summary":"first","summary":"second"}"#,
            r#"{"summary":"\ufffd"}"#,
            r#"{"summary":"s","name":"\ufffd"}"#,
        ] {
            assert!(parse_stdin(json.as_bytes().to_vec()).is_err(), "{json}");
        }
        assert!(parse_stdin(vec![0xff]).is_err());
        assert!(parse_stdin(vec![b' '; MAX_STDIN_BYTES + 1]).is_err());
    }
}
