//! The same bounded grammar artifact as @xmatrix/protocol. This module parses
//! data only; resolving identities and granting execution remain Hub duties.
use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;

#[derive(Deserialize)]
struct Grammar {
    #[serde(rename = "schemaVersion")]
    version: u8,
    rules: Vec<Rule>,
    #[serde(rename = "argumentFormats")]
    argument_formats: BTreeMap<String, String>,
    limits: Limits,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Limits {
    body_length: usize,
    terms: usize,
    depth: usize,
}

#[derive(Deserialize)]
struct Rule {
    id: String,
    operation: String,
    mode: String,
    boundary: Option<String>,
    terms: Vec<Term>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Term {
    Literal { values: Vec<String> },
    Argument { name: String, format: String },
    Space,
    Optional { terms: Vec<Term> },
}

static GRAMMAR: LazyLock<Grammar> = LazyLock::new(|| {
    let grammar: Grammar = serde_json::from_str(include_str!(
        "../../../../protocol/src/message-interaction-grammar.json"
    ))
    .expect("checked-in interaction grammar");
    assert_eq!(grammar.version, 1);
    grammar
});

#[derive(Debug, PartialEq, Eq)]
pub struct GrammarMatch {
    pub start: usize,
    pub end: usize,
    pub arguments: BTreeMap<String, String>,
}

fn terms_pattern(terms: &[Term], depth: usize) -> Option<String> {
    if depth > GRAMMAR.limits.depth || terms.len() > GRAMMAR.limits.terms {
        return None;
    }
    let mut result = String::new();
    for term in terms {
        result.push_str(&match term {
            Term::Literal { values } => format!(
                "(?:{})",
                values
                    .iter()
                    .map(|value| regex::escape(value))
                    .collect::<Vec<_>>()
                    .join("|")
            ),
            Term::Space => "\\s+".into(),
            Term::Optional { terms } => format!("(?:{})?", terms_pattern(terms, depth + 1)?),
            Term::Argument { name, format } => {
                let source = GRAMMAR.argument_formats.get(format)?;
                format!("(?P<{name}>{source})")
            }
        });
    }
    Some(result)
}

/// Match a named protocol rule. Byte offsets are converted to the protocol's
/// UTF-16 offsets so CLI results and browser selections identify the same text.
pub fn match_grammar(id: &str, body: &str) -> Vec<GrammarMatch> {
    if body.encode_utf16().count() > GRAMMAR.limits.body_length {
        return Vec::new();
    }
    let Some(rule) = GRAMMAR.rules.iter().find(|rule| rule.id == id) else {
        return Vec::new();
    };
    let Some(source) = terms_pattern(&rule.terms, 0) else {
        return Vec::new();
    };
    let pattern = if rule.mode == "mention" {
        format!("(?i)(?:^|[\\s(\\[{{])(?P<invocation>{source})")
    } else {
        format!("(?i)^\\s*(?P<invocation>{source})\\s*$")
    };
    // ECMAScript WhiteSpace + LineTerminator, also used by the TS consumer.
    // Rust's Unicode \s additionally includes U+0085 and excludes U+FEFF.
    let whitespace =
        r"\t-\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";
    let pattern = pattern
        .replace(r"\s", &format!("[{whitespace}]"))
        .replace(r"\S", &format!("[^{whitespace}]"));
    let Ok(pattern) = Regex::new(&pattern) else {
        return Vec::new();
    };
    pattern
        .captures_iter(body)
        .filter_map(|captures| {
            let invocation = captures.name("invocation")?;
            if rule.mode == "mention"
                && body[invocation.end()..].chars().next().is_some_and(|next| {
                    !is_protocol_whitespace(next)
                        && (rule.boundary.as_deref() == Some("space")
                            || !"]})，。！？；、）】》」』".contains(next))
                })
            {
                return None;
            }
            let arguments = pattern
                .capture_names()
                .flatten()
                .filter(|name| *name != "invocation")
                .filter_map(|name| {
                    captures
                        .name(name)
                        .map(|value| (name.to_string(), value.as_str().to_string()))
                })
                .collect();
            Some(GrammarMatch {
                start: body[..invocation.start()].encode_utf16().count(),
                end: body[..invocation.end()].encode_utf16().count(),
                arguments,
            })
        })
        .collect()
}

fn is_protocol_whitespace(value: char) -> bool {
    matches!(value, '\t'..='\r' | ' ' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_typescript_rust_grammar_vectors() {
        let cases: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../protocol/test/message-interaction-vectors.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let actual: Vec<_> = match_grammar(
                case["rule"].as_str().unwrap(),
                case["body"].as_str().unwrap(),
            )
            .into_iter()
            .map(|matched| {
                serde_json::json!({
                    "start": matched.start, "end": matched.end, "arguments": matched.arguments,
                })
            })
            .collect();
            assert_eq!(
                serde_json::json!(actual),
                case["matches"],
                "{}",
                case["body"]
            );
        }
    }
}
