//! The web's route keys, read the way `channel-links.ts` writes them: a slug of
//! the name, then `<prefix><up to 10 base36 digits of the id>` (`s` for a
//! Space, `c` for a Channel link). The token survives a rename, so a pasted
//! link resolves by it.

/// The last path segment of a pasted link or key, without query or fragment.
pub fn last_segment(raw: &str) -> Option<String> {
    let path = raw.trim().split(['?', '#']).next().unwrap_or_default();
    let segment = path.trim_end_matches('/').rsplit('/').next()?;
    urlencoding::decode(segment)
        .ok()
        .map(|decoded| decoded.into_owned())
}

/// `<prefix><base36 id>`, cut to 10 digits, as the web mints it.
pub fn entity_token(prefix: char, id: &str) -> String {
    let compact: String = id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_ascii_lowercase();
    if compact.is_empty() {
        return format!("{prefix}unknown");
    }
    let digits = u128::from_str_radix(&compact, 16).map_or(compact, base36);
    format!("{prefix}{}", &digits[..digits.len().min(10)])
}

/// The trailing `<prefix><token>` of a route key, lowercased.
pub fn key_token(key: &str, prefix: char) -> Option<String> {
    let token = key.rsplit('-').next()?.to_ascii_lowercase();
    (token.starts_with(prefix)
        && (9..=13).contains(&token.len())
        && token.bytes().all(|byte| byte.is_ascii_alphanumeric()))
    .then_some(token)
}

/// Lowercase ASCII words joined by single dashes; empty when there are none.
pub fn slug(value: &str) -> String {
    let mut slug = String::new();
    for ch in value.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.trim_end_matches('-').to_string()
}

fn base36(mut value: u128) -> String {
    let mut digits = Vec::new();
    loop {
        digits.push(std::char::from_digit((value % 36) as u32, 36).unwrap_or('0'));
        value /= 36;
        if value == 0 {
            break;
        }
    }
    digits.into_iter().rev().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_match_the_web() {
        assert_eq!(
            entity_token('s', "0b5c1d9e-7f3a-4c2b-9e1d-2a6f8c4b5e70"),
            "so7livxfrfb"
        );
        assert_eq!(
            entity_token('c', "3971448a-1c8d-40b2-8d94-9a98d67af4b9"),
            "c3efck6xm5n"
        );
        assert_eq!(entity_token('c', "--"), "cunknown");
    }

    #[test]
    fn a_key_yields_its_token_and_segment() {
        assert_eq!(
            key_token("Acme-Team-So7livxfrfb", 's').as_deref(),
            Some("so7livxfrfb")
        );
        assert_eq!(key_token("lambda-labs", 's'), None);
        assert_eq!(
            last_segment("https://xmatrix.sh/app/x/channels/a%20b-c1/?view=1#m").as_deref(),
            Some("a b-c1")
        );
        assert_eq!(slug("  #Hello, World!! "), "hello-world");
    }
}
