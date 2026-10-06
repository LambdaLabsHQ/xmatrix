//! A `--space` argument as people copy it: a Space id, the Space's route key
//! from a web link (`acme-team-so7livxfrfb`), or the whole link. Routes take
//! the id, so anything else is resolved against the Spaces this principal can
//! read. A route key the Hub is never asked about cannot be misreported as a
//! permission failure.

use serde::Deserialize;

use crate::error::{CliError, Result};
use crate::http;
use crate::protocol::{HubRoutes, SerializedSpace};
use crate::route_key;

/// The Space id `raw` names. A Space id is returned as given, without a request.
pub async fn resolve_space_ref(hub_url: &str, token: &str, raw: &str) -> Result<String> {
    let reference = space_reference(raw);
    if looks_like_space_id(&reference) {
        return Ok(reference);
    }
    #[derive(Deserialize)]
    struct SpacesResponse {
        spaces: Vec<SerializedSpace>,
    }
    let url = format!("{}{}", hub_url.trim_end_matches('/'), HubRoutes::SPACES);
    let response: SpacesResponse = http::request_json(&url, "GET", Some(token), None).await?;
    match_space(&reference, &response.spaces).ok_or_else(|| {
        CliError::Launch(format!(
            "`{raw}` is not a Space you can access; pass a Space id (see `xmatrix spaces`)"
        ))
    })
}

/// The route segment of a pasted `…/app/<space>/…` link, else the value itself.
fn space_reference(raw: &str) -> String {
    let trimmed = raw.trim();
    match trimmed.split_once("/app/") {
        Some((_, rest)) => rest.split(['/', '?', '#']).next().unwrap_or("").to_string(),
        None => trimmed.to_string(),
    }
}

fn looks_like_space_id(value: &str) -> bool {
    value.len() == 36
        && value.char_indices().all(|(index, ch)| match index {
            8 | 13 | 18 | 23 => ch == '-',
            _ => ch.is_ascii_hexdigit(),
        })
}

fn match_space(reference: &str, spaces: &[SerializedSpace]) -> Option<String> {
    let wanted = reference.to_ascii_lowercase();
    let token = route_key::key_token(&wanted, 's');
    spaces
        .iter()
        .find(|space| {
            space.id.eq_ignore_ascii_case(&wanted)
                || space_route_key(space) == wanted
                || token.as_deref() == Some(route_key::entity_token('s', &space.id).as_str())
        })
        .map(|space| space.id.clone())
}

/// The web's Space route key: `<name slug>-s<id token>`.
fn space_route_key(space: &SerializedSpace) -> String {
    let slug = route_key::slug(&space.name);
    let slug = if slug.is_empty() {
        "untitled"
    } else {
        slug.as_str()
    };
    format!("{slug}-{}", route_key::entity_token('s', &space.id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn space(id: &str, name: &str) -> SerializedSpace {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": name, "ownerId": "u", "members": [],
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
        }))
        .unwrap()
    }

    #[test]
    fn a_space_id_passes_through() {
        assert!(looks_like_space_id("0b5c1d9e-7f3a-4c2b-9e1d-2a6f8c4b5e70"));
        assert!(!looks_like_space_id("acme-team-so7livxfrfb"));
    }

    #[test]
    fn the_route_key_matches_the_web_link() {
        // The key production links use for this Space.
        let lambda = space("0b5c1d9e-7f3a-4c2b-9e1d-2a6f8c4b5e70", "Acme Team");
        assert_eq!(space_route_key(&lambda), "acme-team-so7livxfrfb");
    }

    #[test]
    fn a_route_key_or_link_resolves_to_its_space() {
        let spaces = [
            space("11111111-1111-4111-8111-111111111111", "Other"),
            space("0b5c1d9e-7f3a-4c2b-9e1d-2a6f8c4b5e70", "Acme Team"),
        ];
        let id = Some("0b5c1d9e-7f3a-4c2b-9e1d-2a6f8c4b5e70".to_string());
        assert_eq!(match_space("acme-team-so7livxfrfb", &spaces), id);
        // A renamed Space still matches by the id token its old links carry.
        assert_eq!(match_space("old-name-so7livxfrfb", &spaces), id);
        assert_eq!(
            match_space(
                &space_reference("https://xmatrix.sh/app/acme-team-so7livxfrfb/channels/bugs-c1"),
                &spaces
            ),
            id
        );
        assert_eq!(match_space("lambda-labs", &spaces), None);
    }
}
