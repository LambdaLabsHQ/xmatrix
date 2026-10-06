/// Parse the first case-insensitive Content-Length; each fixture chooses its absent-header policy.
pub(crate) fn content_length(headers: &str) -> Option<usize> {
    headers.lines().find_map(|line| {
        line.to_ascii_lowercase()
            .strip_prefix("content-length:")
            .and_then(|value| value.trim().parse::<usize>().ok())
    })
}
