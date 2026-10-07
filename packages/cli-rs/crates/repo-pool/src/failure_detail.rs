//! Redact secrets without replacing the underlying Git diagnostic.
use regex::Regex;
use std::sync::LazyLock;

pub(super) fn sanitize(raw: &str, max_bytes: usize) -> String {
    static RULES: LazyLock<Vec<(Regex, &str)>> = LazyLock::new(|| {
        [
            (r"(?is)-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|$)", "[REDACTED]"),
            (r"(?i)([a-z][a-z0-9+.-]*://)[^\s/]+@", "${1}***@"),
            (r#"(?i)([a-z][a-z0-9+.-]*://[^\s?'\"<>#]+)[?#][^\s'\"<>]*"#, "${1}?[REDACTED]"),
            (r"(?i)((?:authorization|proxy-authorization|cookie|set-cookie)\s*:)\s*[^\r\n]+", "${1} [REDACTED]"),
            (r"(?i)\b(?:bearer|basic)\s+[a-z0-9+/_.=~-]+", "[REDACTED]"),
            (r#"(?i)((?:[a-z_]*token|password|passwd|secret|api[_-]?key)["']?\s*[=:]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s&;'\"]+)"#, "${1}[REDACTED]"),
            (r"\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)", "[REDACTED]"),
        ].into_iter().map(|(pattern, replacement)| (Regex::new(pattern).expect("static redaction pattern"), replacement)).collect()
    });
    let mut text = raw.to_owned();
    for (pattern, replacement) in RULES.iter() {
        text = pattern.replace_all(&text, *replacement).into_owned();
    }
    text.retain(|c| !c.is_control() || c == '\n' || c == '\t');
    if text.len() > max_bytes {
        let mut end = max_bytes;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("...");
    }
    text
}

#[cfg(test)]
mod tests {
    #[test]
    fn quoted_and_truncated_credentials_are_redacted() {
        for raw in [
            r#"{"token":"JSON_SECRET"}"#,
            "-----BEGIN RSA PRIVATE KEY-----\nKEY_SECRET\n",
            "Bearer HEADER_SECRET",
        ] {
            let safe = super::sanitize(raw, 2_000);
            for secret in ["JSON_SECRET", "KEY_SECRET", "HEADER_SECRET"] {
                assert!(!safe.contains(secret), "{safe}");
            }
        }
    }
}
