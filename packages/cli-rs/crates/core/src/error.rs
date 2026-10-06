use thiserror::Error;

/// Longest `source()` chain folded into one operator-facing line.
const MAX_ERROR_CHAIN_DEPTH: usize = 5;

/// Flatten an error and its `source()` chain into one line.
///
/// `reqwest::Error`'s `Display` stops at `error sending request for url (...)`
/// and keeps the actual cause — dns failure, connection reset, timeout — in
/// `source()`. Reporting only the outer message names a URL and nothing else.
pub fn describe_error_chain(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut next = error.source();
    let mut depth = 0;
    while let Some(cause) = next {
        if depth >= MAX_ERROR_CHAIN_DEPTH {
            break;
        }
        let text = cause.to_string();
        if !text.is_empty() && !message.contains(&text) {
            message.push_str(": ");
            message.push_str(&text);
        }
        next = cause.source();
        depth += 1;
    }
    message
}

#[derive(Debug, Error)]
pub enum CliError {
    #[error("{vendor} {transport} transport: {source}")]
    ProviderTransport {
        vendor: String,
        transport: &'static str,
        source: ProviderTransportFailure,
    },

    #[error("{0}")]
    Auth(String),

    #[error("{0}")]
    Http(String),

    #[error("{0}")]
    UpgradeRequired(String),

    #[error("{0}")]
    Relay(String),

    #[error("{0}")]
    RelayTransient(String),

    #[error("{0}")]
    AgentOperation(#[source] Box<AgentOperationError>),

    #[error("{0}")]
    Launch(String),

    #[error("{0}")]
    Pty(String),

    #[error("{0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Json(#[from] serde_json::Error),

    #[error("{}", describe_error_chain(.0))]
    Request(#[from] reqwest::Error),

    #[error("{0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),
}

pub type Result<T> = std::result::Result<T, CliError>;

#[derive(Clone, Debug, Error)]
pub enum ProviderTransportFailure {
    #[error("message too large ({size} bytes; limit {max_size} bytes)")]
    MessageTooLarge { size: usize, max_size: usize },
    #[error(
        "notification backlog full ({messages}/{max_messages} messages, {bytes}/{max_bytes} bytes); resume the existing session after reducing the backlog"
    )]
    BacklogFull {
        messages: usize,
        max_messages: usize,
        bytes: usize,
        max_bytes: usize,
    },
    #[error("invalid JSON at line {line}, column {column}")]
    InvalidJson { line: usize, column: usize },
    #[error("connection closed (WebSocket close code: {code:?})")]
    Closed { code: Option<u16> },
    #[error("{0}")]
    Connection(String),
}

impl ProviderTransportFailure {
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Closed { .. } | Self::Connection(_))
    }
}

#[cfg(test)]
mod tests {
    use super::describe_error_chain;

    #[derive(Debug)]
    struct TestError {
        message: &'static str,
        source: Option<Box<TestError>>,
    }

    impl std::fmt::Display for TestError {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str(self.message)
        }
    }

    impl std::error::Error for TestError {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.source
                .as_ref()
                .map(|source| source.as_ref() as &(dyn std::error::Error + 'static))
        }
    }

    fn error(message: &'static str, source: Option<TestError>) -> TestError {
        TestError {
            message,
            source: source.map(Box::new),
        }
    }

    #[test]
    fn provider_transport_names_the_vendor_size_and_limit() {
        let reported = super::CliError::ProviderTransport {
            vendor: "Codex".into(),
            transport: "WebSocket",
            source: super::ProviderTransportFailure::MessageTooLarge {
                size: 20_184_530,
                max_size: 16_777_216,
            },
        }
        .to_string();
        assert_eq!(
            reported,
            "Codex WebSocket transport: message too large (20184530 bytes; limit 16777216 bytes)"
        );
        assert!(
            !super::ProviderTransportFailure::MessageTooLarge {
                size: 20_184_530,
                max_size: 16_777_216,
            }
            .retryable()
        );
        assert!(super::ProviderTransportFailure::Closed { code: Some(1000) }.retryable());
    }

    #[test]
    fn a_transport_error_reports_the_cause_its_display_omits() {
        let reported = describe_error_chain(&error(
            "error sending request for url (https://hub.example/api/machine-daemon/workspaces)",
            Some(error("connection reset", None)),
        ));
        assert_eq!(
            reported,
            "error sending request for url (https://hub.example/api/machine-daemon/workspaces): connection reset",
        );
    }

    #[test]
    fn an_error_without_a_source_is_unchanged() {
        assert_eq!(
            describe_error_chain(&error("plain failure", None)),
            "plain failure"
        );
    }

    #[test]
    fn a_cause_already_quoted_by_its_wrapper_is_not_repeated() {
        let reported = describe_error_chain(&error(
            "outer: inner detail",
            Some(error("inner detail", None)),
        ));
        assert_eq!(reported, "outer: inner detail");
    }

    #[test]
    fn a_deep_chain_is_bounded() {
        let mut deepest = error("cause-9", None);
        for index in (0..9).rev() {
            let message: &'static str = Box::leak(format!("cause-{index}").into_boxed_str());
            deepest = error(message, Some(deepest));
        }
        let reported = describe_error_chain(&deepest);
        assert!(reported.starts_with("cause-0: cause-1"), "got {reported}");
        assert!(
            !reported.contains("cause-7"),
            "chain must stop at the depth cap, got {reported}",
        );
    }
}

#[derive(Debug)]
pub struct AgentOperationError {
    pub message: String,
    pub failure: crate::protocol::AgentOperationFailure,
}
impl std::fmt::Display for AgentOperationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} [{}; stage={}",
            self.message, self.failure.code, self.failure.stage
        )?;
        if let Some(origin) = &self.failure.origin_stage {
            write!(formatter, "; origin={origin}")?;
        }
        write!(formatter, "; {}]", self.failure.diagnostic_id)
    }
}
impl std::error::Error for AgentOperationError {}
impl From<AgentOperationError> for CliError {
    fn from(error: AgentOperationError) -> Self {
        Self::AgentOperation(Box::new(error))
    }
}
impl CliError {
    pub fn operation_failure(&self) -> Option<&crate::protocol::AgentOperationFailure> {
        match self {
            Self::AgentOperation(error) => Some(&error.failure),
            _ => None,
        }
    }
    pub fn is_relay_transient(&self) -> bool {
        matches!(self, Self::RelayTransient(_))
            || self
                .operation_failure()
                .is_some_and(|failure| failure.retryable)
    }
}
