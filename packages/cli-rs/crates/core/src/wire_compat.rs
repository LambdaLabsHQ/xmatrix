//! Forward compatibility for Hub payloads this CLI is older than.
//!
//! The Hub and the CLI upgrade independently, so a Hub that starts emitting a
//! new shape always reaches some CLI that predates it. Before this module a
//! single absent field cost the caller everything: `MessageSender::email` went
//! missing for one sender shape and `xmatrix channel history` returned
//! `missing field \`email\` at line 1 column 371` for the whole Channel, which
//! is how Focus lost the history of every Channel the management identity had
//! posted in.
//!
//! Repair instead of discard, and never in silence. What gets repaired comes
//! from serde's own error rather than a hand-maintained per-field list, so a
//! field this CLI has never heard of is covered by the same code.

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

/// Bounds the repair loop. A payload needing more than this is a different
/// shape, not an older one, and must fail rather than be reshaped into silence.
const MAX_REPAIRS: usize = 16;

/// Candidate fills, ordered by how common the field type is on the wire. Each
/// carries the word serde uses for it so a wrong guess is recognizable.
const CANDIDATES: [(&str, &str); 5] = [
    ("string", "\"\""),
    ("integer", "0"),
    ("boolean", "false"),
    ("sequence", "[]"),
    ("map", "{}"),
];

/// One field this CLI required that the payload did not carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireRepair {
    pub field: String,
}

#[derive(Debug, Clone)]
pub struct WireDecoded<T> {
    pub value: T,
    /// Empty when the payload matched this CLI exactly.
    pub repairs: Vec<WireRepair>,
}

fn candidate_value(literal: &str) -> Value {
    serde_json::from_str(literal).expect("candidate fill must be valid JSON")
}

/// serde reports an absent field as ``missing field `name` ``, without a path.
fn missing_field(message: &str) -> Option<String> {
    let start = message.find("missing field `")? + "missing field `".len();
    let rest = &message[start..];
    let end = rest.find('`')?;
    Some(rest[..end].to_string())
}

/// Insert `field` into every object that lacks it. Over-insertion is safe: no
/// wire struct denies unknown fields, so an object that never wanted this field
/// ignores it. Never overwrite a value the Hub actually sent.
fn fill_missing_field(value: &mut Value, field: &str, fill: &Value) -> bool {
    let mut filled = false;
    match value {
        Value::Object(map) => {
            if !map.contains_key(field) {
                map.insert(field.to_string(), fill.clone());
                filled = true;
            }
            for (_, child) in map.iter_mut() {
                filled |= fill_missing_field(child, field, fill);
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                filled |= fill_missing_field(item, field, fill);
            }
        }
        _ => {}
    }
    filled
}

/// True when the error is serde rejecting the fill we just inserted, which
/// means the guess was the wrong type rather than the wrong place.
fn rejected_our_fill(message: &str, serde_type: &str) -> bool {
    message.contains(&format!("invalid type: {serde_type}"))
}

/// Decode one payload, repairing absent fields and reporting every repair.
///
/// Returns the original error when the payload cannot be repaired, so a
/// genuinely malformed response still fails instead of arriving as defaults.
pub fn decode_tolerant<T: DeserializeOwned>(payload: &Value) -> Result<WireDecoded<T>, String> {
    let mut current = payload.clone();
    let mut repairs: Vec<WireRepair> = Vec::new();

    for _ in 0..=MAX_REPAIRS {
        let error = match serde_json::from_value::<T>(current.clone()) {
            Ok(value) => return Ok(WireDecoded { value, repairs }),
            Err(error) => error.to_string(),
        };
        let Some(field) = missing_field(&error) else {
            return Err(error);
        };
        let mut advanced = false;
        for (serde_type, literal) in CANDIDATES {
            let fill = candidate_value(literal);
            let mut trial = current.clone();
            if !fill_missing_field(&mut trial, &field, &fill) {
                // The field is present everywhere, so this error is about a
                // shape we cannot reach by filling. Stop rather than loop.
                return Err(error);
            }
            let accepted = match serde_json::from_value::<T>(trial.clone()) {
                Ok(_) => true,
                Err(next) => !rejected_our_fill(&next.to_string(), serde_type),
            };
            if accepted {
                current = trial;
                repairs.push(WireRepair {
                    field: field.clone(),
                });
                advanced = true;
                break;
            }
        }
        if !advanced {
            return Err(error);
        }
    }
    Err(format!(
        "payload needed more than {MAX_REPAIRS} compatibility repairs; this CLI is too old to read it",
    ))
}

/// Decode a list payload row by row so one unreadable row cannot cost the
/// caller the rest. Returns the rows that decoded, the repairs applied, and the
/// rows that could not be repaired at all.
pub fn decode_rows_tolerant<T: DeserializeOwned>(
    rows: &[Value],
) -> (Vec<T>, Vec<WireRepair>, Vec<String>) {
    let mut decoded = Vec::with_capacity(rows.len());
    let mut repairs = Vec::new();
    let mut failures = Vec::new();
    for row in rows {
        match decode_tolerant::<T>(row) {
            Ok(result) => {
                repairs.extend(result.repairs);
                decoded.push(result.value);
            }
            Err(error) => failures.push(error),
        }
    }
    (decoded, repairs, failures)
}

/// Collapse repairs into the distinct field names, most frequent first, so the
/// report names the shape difference instead of repeating it per row.
pub fn repair_summary(repairs: &[WireRepair]) -> Vec<(String, usize)> {
    let mut counts: Map<String, Value> = Map::new();
    for repair in repairs {
        let next = counts
            .get(&repair.field)
            .and_then(Value::as_u64)
            .unwrap_or(0)
            + 1;
        counts.insert(repair.field.clone(), Value::from(next));
    }
    let mut summary: Vec<(String, usize)> = counts
        .into_iter()
        .map(|(field, count)| (field, count.as_u64().unwrap_or(0) as usize))
        .collect();
    summary.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    summary
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    struct Sender {
        kind: String,
        label: String,
        user_id: String,
        email: String,
    }

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    struct Message {
        message_id: String,
        from: Sender,
        body: String,
        #[serde(default)]
        tags: Vec<String>,
    }

    fn management_message_without_email() -> Value {
        serde_json::json!({
            "messageId": "m1",
            "from": { "kind": "agent", "label": "xMatrix", "userId": "u1" },
            "body": "hello",
        })
    }

    #[test]
    fn an_absent_field_costs_the_field_and_nothing_else() {
        let decoded = decode_tolerant::<Message>(&management_message_without_email()).unwrap();
        assert_eq!(decoded.value.message_id, "m1");
        assert_eq!(decoded.value.body, "hello");
        assert_eq!(decoded.value.from.label, "xMatrix");
        assert_eq!(decoded.value.from.email, "");
        assert_eq!(
            decoded.repairs,
            vec![WireRepair {
                field: "email".into()
            }]
        );
    }

    #[test]
    fn a_repair_is_never_silent() {
        let decoded = decode_tolerant::<Message>(&management_message_without_email()).unwrap();
        assert!(
            !decoded.repairs.is_empty(),
            "the caller must be able to report this"
        );
    }

    #[test]
    fn a_payload_that_matches_is_not_touched() {
        let payload = serde_json::json!({
            "messageId": "m1",
            "from": { "kind": "user", "label": "Y", "userId": "u1", "email": "y@example.com" },
            "body": "hello",
        });
        let decoded = decode_tolerant::<Message>(&payload).unwrap();
        assert_eq!(decoded.value.from.email, "y@example.com");
        assert!(decoded.repairs.is_empty());
    }

    #[test]
    fn a_non_string_field_is_filled_with_its_own_type() {
        #[derive(Debug, Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Counted {
            name: String,
            count: u64,
            enabled: bool,
            items: Vec<String>,
        }
        let decoded = decode_tolerant::<Counted>(&serde_json::json!({ "name": "x" })).unwrap();
        assert_eq!(decoded.value.name, "x");
        assert_eq!(decoded.value.count, 0);
        assert!(!decoded.value.enabled);
        assert!(decoded.value.items.is_empty());
        assert_eq!(decoded.repairs.len(), 3);
    }

    #[test]
    fn a_wrong_typed_value_still_fails_instead_of_arriving_as_a_default() {
        let payload = serde_json::json!({
            "messageId": 7,
            "from": { "kind": "user", "label": "Y", "userId": "u1", "email": "y@example.com" },
            "body": "hello",
        });
        let error = decode_tolerant::<Message>(&payload).unwrap_err();
        assert!(error.contains("invalid type"), "{error}");
    }

    #[test]
    fn one_unreadable_row_does_not_cost_the_rest_of_the_page() {
        let rows = vec![
            management_message_without_email(),
            serde_json::json!({ "messageId": 7, "from": {}, "body": "bad" }),
            serde_json::json!({
                "messageId": "m3",
                "from": { "kind": "user", "label": "Y", "userId": "u1", "email": "y@e.com" },
                "body": "third",
            }),
        ];
        let (decoded, repairs, failures) = decode_rows_tolerant::<Message>(&rows);
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[1].body, "third");
        assert_eq!(failures.len(), 1);
        assert_eq!(repair_summary(&repairs), vec![("email".to_string(), 1)]);
    }

    #[test]
    fn the_summary_counts_each_absent_field_once_per_row() {
        let rows = vec![
            management_message_without_email(),
            management_message_without_email(),
        ];
        let (decoded, repairs, failures) = decode_rows_tolerant::<Message>(&rows);
        assert_eq!(decoded.len(), 2);
        assert!(failures.is_empty());
        assert_eq!(repair_summary(&repairs), vec![("email".to_string(), 2)]);
    }
}

/// The Hub owns the compatibility policy, so the upgrade hint is read from it
/// rather than hard-coded here: the advice stays correct when the policy moves.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HubCompatibilityPolicy {
    #[serde(default)]
    protocol_version: Option<u64>,
    #[serde(default)]
    upgrade_url: Option<String>,
}

/// One line the user can act on, naming the shape difference and what to do.
/// `policy` is the raw `/api/client-compatibility` body when it could be read.
pub fn compatibility_report(
    summary: &[(String, usize)],
    unreadable_rows: usize,
    policy: Option<&Value>,
) -> Option<String> {
    if summary.is_empty() && unreadable_rows == 0 {
        return None;
    }
    let mut line = String::from("⚠ This xMatrix CLI is older than the Hub's payload shape.");
    if !summary.is_empty() {
        let fields = summary
            .iter()
            .map(|(field, count)| format!("`{field}` ({count})"))
            .collect::<Vec<_>>()
            .join(", ");
        line.push_str(&format!(" Filled absent field(s): {fields}."));
    }
    if unreadable_rows > 0 {
        line.push_str(&format!(
            " {unreadable_rows} row(s) could not be read at all and were skipped."
        ));
    }
    let parsed = policy
        .and_then(|value| serde_json::from_value::<HubCompatibilityPolicy>(value.clone()).ok());
    if let Some(version) = parsed.as_ref().and_then(|p| p.protocol_version) {
        line.push_str(&format!(" Hub protocol version {version}."));
    }
    line.push_str(" Run `xmatrix update`");
    if let Some(url) = parsed.as_ref().and_then(|p| p.upgrade_url.as_deref()) {
        line.push_str(&format!(" ({url})"));
    }
    line.push('.');
    Some(line)
}

#[cfg(test)]
mod report_tests {
    use super::*;

    #[test]
    fn a_clean_read_reports_nothing() {
        assert_eq!(compatibility_report(&[], 0, None), None);
    }

    #[test]
    fn the_report_names_the_field_the_count_and_the_action() {
        let report = compatibility_report(&[("email".to_string(), 12)], 0, None).unwrap();
        assert!(report.contains("`email` (12)"), "{report}");
        assert!(report.contains("xmatrix update"), "{report}");
    }

    #[test]
    fn the_upgrade_hint_comes_from_the_hub_policy_not_this_binary() {
        let policy = serde_json::json!({
            "protocolVersion": 3,
            "upgradeUrl": "https://xmatrix.sh/download",
        });
        let report = compatibility_report(&[("email".to_string(), 1)], 0, Some(&policy)).unwrap();
        assert!(report.contains("protocol version 3"), "{report}");
        assert!(report.contains("https://xmatrix.sh/download"), "{report}");
    }

    #[test]
    fn a_missing_policy_still_produces_an_actionable_report() {
        let report = compatibility_report(&[], 3, None).unwrap();
        assert!(report.contains("3 row(s)"), "{report}");
        assert!(report.contains("xmatrix update"), "{report}");
    }
}

/// The shape this module exists for, held against the real wire struct rather
/// than a stand-in.
#[cfg(test)]
mod real_protocol_tests {
    use super::*;
    use crate::protocol::ChannelMessage;

    /// The Hub's xMatrix management sender snapshot carries no `email`
    /// (`index-routes-channel-agent.ts`, `trustedAgentSenderPresentation`).
    /// Before this module that one absence failed the whole history page.
    fn management_authored_message() -> Value {
        serde_json::json!({
            "messageId": "msg-1",
            "channelId": "channel-1",
            "sequence": 12,
            "from": {
                "identityId": "xmatrix:management",
                "kind": "agent",
                "agentId": "agent:owner:suffix",
                "label": "xMatrix",
                "name": "xMatrix",
                "agentName": "xMatrix",
                "userId": "user-1",
                "avatarUrl": "/brand/xmatrix-management-icon.png",
                "instanceId": "instance-1"
            },
            "body": "Channel About refreshed.",
            "sentAt": "2026-09-16T21:28:46.000Z"
        })
    }

    #[test]
    fn a_management_authored_message_is_readable_and_reported() {
        let decoded = decode_tolerant::<ChannelMessage>(&management_authored_message()).unwrap();
        assert_eq!(decoded.value.message_id, "msg-1");
        assert_eq!(decoded.value.body, "Channel About refreshed.");
        assert_eq!(decoded.value.from.label, "xMatrix");
        assert_eq!(decoded.value.from.user_id, "user-1");
        assert_eq!(decoded.value.from.email, "");
        assert_eq!(
            decoded.repairs,
            vec![WireRepair {
                field: "email".into()
            }]
        );

        let report = compatibility_report(&repair_summary(&decoded.repairs), 0, None).unwrap();
        assert!(report.contains("`email` (1)"), "{report}");
    }

    #[test]
    fn the_rest_of_a_page_survives_one_management_message() {
        let ordinary = serde_json::json!({
            "messageId": "msg-2",
            "channelId": "channel-1",
            "sequence": 13,
            "from": {
                "kind": "user", "label": "Yiming", "userId": "user-2",
                "email": "yiming@example.com"
            },
            "body": "second",
            "sentAt": "2026-09-16T21:29:00.000Z"
        });
        let rows = vec![management_authored_message(), ordinary];
        let (decoded, repairs, failures) = decode_rows_tolerant::<ChannelMessage>(&rows);
        assert_eq!(decoded.len(), 2, "no row may be lost to the other's shape");
        assert!(failures.is_empty());
        assert_eq!(repair_summary(&repairs), vec![("email".to_string(), 1)]);
    }
}
