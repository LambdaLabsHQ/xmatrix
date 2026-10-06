//! `xmatrix page automation`: a page's Automations
//! (docs/design/pages-live-document.md §6). Each keeps a section true and is
//! referenced in it; whoever can edit the page manages them, and a Run does so
//! as its owner, so what it sets up keeps running after the Run ends.

use std::path::PathBuf;

use colored::Colorize;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use xmatrix_cli_args::PageAutomationCommand;
use xmatrix_cli_core::error::{self, CliError};
use xmatrix_cli_core::http;
use xmatrix_cli_core::protocol::with_route;
use xmatrix_cli_core::text_input::{self, TextSource};

use crate::page::{PAGE_TEXT_ROUTES, enc, page_route, resolve_space};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageAutomation {
    pub id: String,
    pub version: u64,
    pub name: String,
    pub interval_minutes: u64,
    pub enabled: bool,
    /// The section its reference is in; absent while detached.
    #[serde(default)]
    pub block_id: Option<String>,
    #[serde(default)]
    pub detached_at: Option<String>,
    pub next_run_at: String,
    #[serde(default)]
    pub last_run_at: Option<String>,
    pub channel_id: String,
    #[serde(default)]
    pub expression: Option<PageAutomationExpression>,
    #[serde(default)]
    pub triggers: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PageAutomationExpression {
    pub text: String,
}

#[derive(Deserialize)]
struct ListResponse {
    automations: Vec<PageAutomation>,
}

#[derive(Deserialize)]
struct OneResponse {
    automation: PageAutomation,
}

/// How often, in words.
pub fn render_cadence(minutes: u64) -> String {
    match minutes {
        1440 => "daily".into(),
        m if m % 1440 == 0 => format!("every {} days", m / 1440),
        60 => "hourly".into(),
        m if m % 60 == 0 => format!("every {} h", m / 60),
        m => format!("every {m} min"),
    }
}

/// One line per Automation: id and version to act on it, where it is, how
/// often, whether it runs; then what it does each time.
pub fn render_page_automation(automation: &PageAutomation) -> String {
    let place = match automation.block_id.as_deref() {
        None => "(detached)".to_string(),
        Some("") => "(top of page)".to_string(),
        Some(block) => format!("#{block}"),
    };
    let state = if automation.detached_at.is_some() {
        "detached: put its reference back to resume it".to_string()
    } else if !automation.enabled {
        "paused".to_string()
    } else {
        format!("next {}", automation.next_run_at)
    };
    let last = automation
        .last_run_at
        .as_deref()
        .map(|at| format!(" · last {at}"))
        .unwrap_or_default();
    let instruction = automation
        .expression
        .as_ref()
        .map(|expression| expression.text.replace('\n', " "))
        .unwrap_or_default();
    let instruction: String = instruction.chars().take(160).collect();
    let triggers = automation
        .triggers
        .iter()
        .map(render_trigger)
        .collect::<Vec<_>>();
    let triggers = if triggers.is_empty() {
        String::new()
    } else {
        format!(" · on {}", triggers.join(", "))
    };
    format!(
        "{} v{} · {} · {place} · {}{triggers} · {state}{last} · conversation {}\n    {instruction}",
        automation.id,
        automation.version,
        automation.name,
        render_cadence(automation.interval_minutes),
        automation.channel_id
    )
}

/// A trigger as `--on` spells it.
pub fn render_trigger(trigger: &Value) -> String {
    let field = |name: &str| {
        trigger
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
    };
    let kind = field("kind");
    if kind == "owed" {
        return "owed".into();
    }
    if kind == "event" {
        let feature = match field("feature") {
            "" => "*",
            feature => feature,
        };
        return match field("source") {
            "" | "*" => format!("{}:{feature}", field("provider")),
            source => format!("{}:{feature}:{source}", field("provider")),
        };
    }
    let branch = match field("branch") {
        "" => String::new(),
        branch => format!("@{branch}"),
    };
    let rest = if kind == "merged" {
        trigger
            .get("paths")
            .and_then(Value::as_array)
            .map(|paths| {
                paths
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default()
    } else {
        field("workflow").to_string()
    };
    let rest = if rest.is_empty() {
        rest
    } else {
        format!(":{rest}")
    };
    format!("{kind}:{}{branch}{rest}", field("repository"))
}

/// `--on` as the trigger the Hub takes: merged:owner/repo[@branch][:path,…],
/// ci-failed:owner/repo[@branch][:workflow], owed, or a connector event
/// <provider>:<feature|*>[:<source>]. The Hub validates the connector's names.
pub fn parse_trigger(value: &str) -> error::Result<Value> {
    let value = value.trim();
    if value == "owed" {
        return Ok(json!({ "kind": "owed" }));
    }
    let invalid = || {
        CliError::Launch(format!(
            "--on takes merged:owner/repo[@branch][:path,…], ci-failed:owner/repo[@branch][:workflow], owed or <connector>:<event|*>[:<source>], not {value:?}"
        ))
    };
    let (kind, rest) = value.split_once(':').ok_or_else(invalid)?;
    if kind != "merged" && kind != "ci-failed" {
        let provider_shaped = kind
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_lowercase())
            && kind
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        let (feature, source) = rest.split_once(':').unwrap_or((rest, "*"));
        if !provider_shaped
            || feature.is_empty()
            || source.is_empty()
            || source.contains(char::is_whitespace)
        {
            return Err(invalid());
        }
        let mut trigger = json!({ "kind": "event", "provider": kind, "source": source });
        if feature != "*" {
            trigger["feature"] = json!(feature);
        }
        return Ok(trigger);
    }
    let (target, extra) = rest.split_once(':').unwrap_or((rest, ""));
    let (repository, branch) = target.split_once('@').unwrap_or((target, ""));
    if repository
        .split('/')
        .filter(|part| !part.is_empty())
        .count()
        != 2
    {
        return Err(invalid());
    }
    let mut trigger = json!({ "kind": kind, "repository": repository });
    if !branch.is_empty() {
        trigger["branch"] = json!(branch);
    }
    if !extra.is_empty() {
        if kind == "merged" {
            trigger["paths"] = json!(
                extra
                    .split(',')
                    .map(str::trim)
                    .filter(|p| !p.is_empty())
                    .collect::<Vec<_>>()
            );
        } else {
            trigger["workflow"] = json!(extra);
        }
    }
    Ok(trigger)
}

/// A cadence as minutes: a number of minutes, or a number with m, h or d.
pub fn parse_every(value: &str) -> error::Result<u64> {
    let value = value.trim().to_ascii_lowercase();
    let (number, unit) = match value.char_indices().find(|(_, c)| !c.is_ascii_digit()) {
        Some((at, _)) => (&value[..at], value[at..].trim()),
        None => (value.as_str(), "m"),
    };
    let multiplier = match unit {
        "m" | "min" => 1,
        "h" => 60,
        "d" => 1440,
        _ => 0,
    };
    match number.parse::<u64>() {
        Ok(amount) if multiplier > 0 && amount > 0 => Ok(amount * multiplier),
        _ => Err(CliError::Launch(format!(
            "--every takes minutes, or a number with m, h or d (e.g. 12h), not {value:?}"
        ))),
    }
}

/// The instruction from -m, -f or --stdin, when one is given.
fn instruction_input(
    instruction: Option<String>,
    file: Option<PathBuf>,
    stdin: bool,
) -> error::Result<Option<String>> {
    match [instruction.is_some(), file.is_some(), stdin]
        .iter()
        .filter(|given| **given)
        .count()
    {
        0 => return Ok(None),
        1 => {}
        _ => {
            return Err(CliError::Launch(
                "give the instruction with only one of -m, -f or --stdin".into(),
            ));
        }
    }
    let (text, source) = match (instruction, file) {
        (_, Some(file)) => (text_input::read_text_file(&file)?, TextSource::File),
        (Some(instruction), None) => (instruction, TextSource::Argument),
        (None, None) => (text_input::read_stdin_text()?, TextSource::Stdin),
    };
    text_input::ensure_text_intact("Automation instruction", &text, source, PAGE_TEXT_ROUTES)?;
    Ok(Some(text))
}

fn automations_route(space: &str, page: &str) -> String {
    format!("{}/automations", page_route(space, page))
}

/// A page's Automations, for `page read`'s header; none when they cannot be read.
pub async fn page_automations(
    hub_url: &str,
    token: &str,
    space: &str,
    page: &str,
) -> Vec<PageAutomation> {
    let url = with_route(hub_url, &automations_route(space, page));
    http::request_json::<ListResponse>(&url, "GET", Some(token), None)
        .await
        .map(|response| response.automations)
        .unwrap_or_default()
}

/// The `automations:` lines of `page read`'s header.
pub fn render_page_automations_header(automations: &[PageAutomation]) -> String {
    if automations.is_empty() {
        return String::new();
    }
    let mut out = String::from("automations:\n");
    for automation in automations {
        let line = render_page_automation(automation);
        let first = line.lines().next().unwrap_or_default();
        out.push_str(&format!("  - {first}\n"));
    }
    out
}

async fn send(
    hub_url: &str,
    token: &str,
    route: &str,
    method: &str,
    body: Value,
) -> error::Result<PageAutomation> {
    let response: OneResponse =
        http::request_json(&with_route(hub_url, route), method, Some(token), Some(body)).await?;
    Ok(response.automation)
}

fn done(verb: &str, automation: &PageAutomation) {
    println!(
        "{} {verb}\n{}",
        "✓".green().bold(),
        render_page_automation(automation)
    );
}

async fn set_running(
    hub_url: &str,
    token: &str,
    space: Option<String>,
    page: &str,
    automation: &str,
    version: u64,
    action: &str,
) -> error::Result<()> {
    let space = resolve_space(hub_url, token, space).await?;
    let route = format!(
        "{}/{}/{action}",
        automations_route(&space, page),
        enc(automation)
    );
    let changed = send(
        hub_url,
        token,
        &route,
        "POST",
        json!({ "expectedVersion": version }),
    )
    .await?;
    done(
        if action == "pause" {
            "Paused"
        } else {
            "Resumed"
        },
        &changed,
    );
    Ok(())
}

pub async fn cmd_page_automation(
    hub_url: &str,
    token: &str,
    command: PageAutomationCommand,
) -> error::Result<()> {
    match command {
        PageAutomationCommand::List { page, space } => {
            let space = resolve_space(hub_url, token, space).await?;
            let url = with_route(hub_url, &automations_route(&space, &page));
            let response: ListResponse = http::request_json(&url, "GET", Some(token), None).await?;
            if response.automations.is_empty() {
                println!("(no Automations on this page)");
            }
            for automation in &response.automations {
                println!("{}", render_page_automation(automation));
            }
            Ok(())
        }
        PageAutomationCommand::Create {
            page,
            block,
            name,
            every,
            triggers,
            instruction,
            file,
            stdin,
            space,
        } => {
            let triggers = triggers
                .iter()
                .map(|trigger| parse_trigger(trigger))
                .collect::<error::Result<Vec<_>>>()?;
            let instruction = instruction_input(instruction, file, stdin)?.ok_or_else(|| {
                CliError::Launch("give what to do each time with -m, -f or --stdin".into())
            })?;
            let space = resolve_space(hub_url, token, space).await?;
            let mut body = json!({
                "name": name, "instruction": instruction, "intervalMinutes": parse_every(&every)?,
            });
            if let Some(block) = block {
                body["blockId"] = json!(block);
            }
            if !triggers.is_empty() {
                body["triggers"] = json!(triggers);
            }
            let created = send(
                hub_url,
                token,
                &automations_route(&space, &page),
                "POST",
                body,
            )
            .await?;
            done("Created; its reference is in the section", &created);
            Ok(())
        }
        PageAutomationCommand::Edit {
            page,
            automation,
            version,
            name,
            every,
            triggers,
            no_triggers,
            instruction,
            file,
            stdin,
            space,
        } => {
            let mut body = Map::new();
            if no_triggers || !triggers.is_empty() {
                let triggers = triggers
                    .iter()
                    .map(|trigger| parse_trigger(trigger))
                    .collect::<error::Result<Vec<_>>>()?;
                body.insert("triggers".into(), json!(triggers));
            }
            body.insert("expectedVersion".into(), json!(version));
            if let Some(name) = name {
                body.insert("name".into(), json!(name));
            }
            if let Some(every) = every {
                body.insert("intervalMinutes".into(), json!(parse_every(&every)?));
            }
            if let Some(instruction) = instruction_input(instruction, file, stdin)? {
                body.insert("instruction".into(), json!(instruction));
            }
            let space = resolve_space(hub_url, token, space).await?;
            let route = format!("{}/{}", automations_route(&space, &page), enc(&automation));
            let edited = send(hub_url, token, &route, "PATCH", Value::Object(body)).await?;
            done(
                if edited.id == automation {
                    "Edited"
                } else {
                    "Replaced with yours (it runs as its author)"
                },
                &edited,
            );
            Ok(())
        }
        PageAutomationCommand::Pause {
            page,
            automation,
            version,
            space,
        } => set_running(hub_url, token, space, &page, &automation, version, "pause").await,
        PageAutomationCommand::Resume {
            page,
            automation,
            version,
            space,
        } => set_running(hub_url, token, space, &page, &automation, version, "resume").await,
        PageAutomationCommand::Attach {
            page,
            automation,
            block,
            space,
        } => {
            let space = resolve_space(hub_url, token, space).await?;
            let route = format!(
                "{}/{}/reference",
                automations_route(&space, &page),
                enc(&automation)
            );
            let attached = send(
                hub_url,
                token,
                &route,
                "POST",
                json!({ "blockId": block.unwrap_or_default() }),
            )
            .await?;
            done("Its reference is in the section", &attached);
            Ok(())
        }
        PageAutomationCommand::Delete {
            page,
            automation,
            version,
            space,
        } => {
            let space = resolve_space(hub_url, token, space).await?;
            let url = with_route(
                hub_url,
                &format!(
                    "{}/{}?expectedVersion={version}",
                    automations_route(&space, &page),
                    enc(&automation)
                ),
            );
            let _: Value = http::request_json(&url, "DELETE", Some(token), None).await?;
            println!(
                "{} Deleted {automation}; its reference is out of the page",
                "✓".green().bold()
            );
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trigger_is_spelled_the_same_way_in_and_out() {
        for spelled in [
            "owed",
            "merged:acme/widgets",
            "merged:acme/widgets@dev:packages/hub,docs",
            "ci-failed:acme/widgets:CI",
            "sentry:issue.created:web",
            "webhook:*",
            "gitlab:pipelines:group/app",
        ] {
            assert_eq!(render_trigger(&parse_trigger(spelled).unwrap()), spelled);
        }
        assert_eq!(
            parse_trigger("merged:acme/widgets@main:packages/hub").unwrap(),
            json!({ "kind": "merged", "repository": "acme/widgets", "branch": "main", "paths": ["packages/hub"] })
        );
        assert_eq!(
            parse_trigger("linear:issue").unwrap(),
            json!({ "kind": "event", "provider": "linear", "source": "*", "feature": "issue" })
        );
        for bad in [
            "nightly",
            "merged:acme",
            "merged:",
            "ci-failed:a/b/c",
            "Sentry:x",
            "sentry:",
            "sentry:x:",
        ] {
            assert!(parse_trigger(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_cadence_is_minutes_or_a_number_with_a_unit() {
        assert_eq!(parse_every("90").unwrap(), 90);
        assert_eq!(parse_every("30m").unwrap(), 30);
        assert_eq!(parse_every(" 12h ").unwrap(), 720);
        assert_eq!(parse_every("2d").unwrap(), 2880);
        for bad in ["", "0", "h", "12w", "1.5h"] {
            assert!(parse_every(bad).is_err(), "{bad}");
        }
        assert_eq!(render_cadence(720), "every 12 h");
        assert_eq!(render_cadence(1440), "daily");
        assert_eq!(render_cadence(45), "every 45 min");
    }

    #[test]
    fn a_line_says_where_it_is_and_whether_it_runs() {
        let automation = |block: Option<&str>, enabled: bool, detached: bool| PageAutomation {
            id: "a-1".into(),
            version: 3,
            name: "Code audit".into(),
            interval_minutes: 720,
            enabled,
            block_id: block.map(str::to_string),
            detached_at: detached.then(|| "2026-09-27T00:00:00.000Z".into()),
            next_run_at: "2026-09-28T06:00:00.000Z".into(),
            last_run_at: None,
            channel_id: "c-1".into(),
            expression: Some(PageAutomationExpression {
                text: "@auto repo:o/r\naudit".into(),
            }),
            triggers: Vec::new(),
        };
        assert_eq!(
            render_page_automation(&automation(Some("architecture"), true, false)),
            "a-1 v3 · Code audit · #architecture · every 12 h · next 2026-09-28T06:00:00.000Z · conversation c-1\n    @auto repo:o/r audit"
        );
        assert!(render_page_automation(&automation(None, false, true)).contains("(detached)"));
        assert!(
            render_page_automation(&automation(Some("ui"), false, false)).contains(" · paused ·")
        );
        let header = render_page_automations_header(&[automation(Some(""), true, false)]);
        assert!(header.starts_with("automations:\n  - a-1 v3 · Code audit · (top of page)"));
        assert!(!header.contains("audit\n    "));
    }
}
