//! The same bounded grammar artifact as @xmatrix/protocol. This module parses
//! data only; resolving identities and granting execution remain Hub duties.
use std::sync::LazyLock;

use serde::Deserialize;

#[derive(Deserialize)]
struct Grammar {
    #[serde(rename = "schemaVersion")]
    version: u8,
    rules: Vec<Rule>,
}

#[derive(Deserialize)]
struct Rule {
    id: String,
    operation: String,
    terms: Vec<Term>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Term {
    Literal {
        values: Vec<String>,
    },
    #[serde(other)]
    Other,
}

static GRAMMAR: LazyLock<Grammar> = LazyLock::new(|| {
    let grammar: Grammar = serde_json::from_str(include_str!(
        "../../../../protocol/src/message-interaction-grammar.json"
    ))
    .expect("checked-in interaction grammar");
    assert_eq!(grammar.version, 1);
    grammar
});

/// Runtime control tokens come from the shared grammar rather than another
/// hard-coded /model,/effort,/reasoning list in each runtime adapter.
pub fn runtime_control_operation(token: &str) -> Option<&'static str> {
    GRAMMAR
        .rules
        .iter()
        .filter(|rule| rule.id.starts_with("runtime."))
        .find_map(|rule| {
            rule.terms.iter().find_map(|term| match term {
                Term::Literal { values }
                    if values.iter().any(|value| {
                        value.starts_with('/') && value.eq_ignore_ascii_case(token)
                    }) =>
                {
                    Some(rule.operation.as_str())
                }
                _ => None,
            })
        })
}
