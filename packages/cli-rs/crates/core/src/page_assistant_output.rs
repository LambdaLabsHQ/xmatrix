//! Versioned assistant-output delivery. Product syntax is interpreted by the Hub.
use serde::{Deserialize, Serialize};

pub const CAPABILITY: &str = "page_assistant_output_v1";
pub const MAX_TEXT_BYTES: usize = 4096;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantOutput {
    pub stream: String,
    pub started_at: i64,
    pub seq: u64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OutputStatus {
    Accepted,
    Limited,
    Unknown,
    Rejected,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantOutputAck {
    pub stream: String,
    pub seq: u64,
    pub at: usize,
    pub status: OutputStatus,
    pub retry_after_ms: Option<u64>,
    pub problems: Vec<String>,
}

impl AssistantOutputAck {
    pub fn matches(&self, input: &AssistantOutput, confirmed: usize) -> bool {
        let size = input.text.as_deref().unwrap_or_default().chars().count();
        self.stream == input.stream
            && self.seq == input.seq
            && self.at >= confirmed
            && self.at <= size
            && (self.status != OutputStatus::Accepted || self.at == size)
    }
}

/// Byte-bounded transport frames split only at Unicode scalar boundaries.
pub fn chunks(text: &str) -> impl Iterator<Item = &str> {
    let mut rest = text;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let mut end = rest.len().min(MAX_TEXT_BYTES);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        let (chunk, next) = rest.split_at(end);
        rest = next;
        Some(chunk)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_output_keeps_bytes_and_cursor_units_distinct() {
        let text = "你😀é".repeat(2000);
        let split: Vec<_> = chunks(&text).collect();
        assert!(split.iter().all(|part| part.len() <= MAX_TEXT_BYTES));
        assert_eq!(split.concat(), text);
        let input = AssistantOutput {
            stream: "s".into(),
            started_at: 1,
            seq: 4,
            kind: "text".into(),
            text: Some("你😀".into()),
        };
        let mut ack = AssistantOutputAck {
            stream: "s".into(),
            seq: 4,
            at: 2,
            status: OutputStatus::Accepted,
            retry_after_ms: None,
            problems: vec![],
        };
        assert!(ack.matches(&input, 1));
        ack.at = 1;
        assert!(!ack.matches(&input, 0));
        ack.status = OutputStatus::Limited;
        assert!(ack.matches(&input, 0));
        assert!(!ack.matches(&input, 2));
        ack.seq = 3;
        assert!(!ack.matches(&input, 0));
    }
}
