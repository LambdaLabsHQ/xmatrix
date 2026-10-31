//! `xmatrix page automation`: a page's schedules
//! (docs/design/pages-live-document.md §6.1). A schedule is a line of its
//! page, written as Obsidian Tasks writes a recurring or scheduled task
//! (`- [ ] <what to do> 🔁 every 12 hours`, or `⏳ <time with its offset>` to
//! run once); it is written and changed with `page edit` like any text. These
//! commands list them, run one now, and pause, resume or delete one by
//! changing its line.

use colored::Colorize;
use serde::Deserialize;
use serde_json::json;
use xmatrix_cli_args::PageAutomationCommand;
use xmatrix_cli_core::error;
use xmatrix_cli_core::http;
use xmatrix_cli_core::protocol::with_route;

use crate::page::{enc, page_route, resolve_space};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageAutomation {
    pub id: String,
    /// A reminder: it runs once at `next_run_at`, then stops.
    #[serde(default)]
    pub once: bool,
    pub enabled: bool,
    /// The section its line is in.
    #[serde(default)]
    pub block_id: Option<String>,
    /// Its line, as last synced.
    #[serde(default)]
    pub source: Option<String>,
    /// Why its line does not run as written.
    #[serde(default)]
    pub problem: Option<String>,
    pub next_run_at: String,
    #[serde(default)]
    pub last_run_at: Option<String>,
    #[serde(default)]
    pub last_channel_id: Option<String>,
}

#[derive(Deserialize)]
struct ListResponse {
    automations: Vec<PageAutomation>,
}

/// One schedule: its id to act on it, where it is, whether and when it runs,
/// then its line.
pub(crate) fn render_page_automation(automation: &PageAutomation) -> String {
    let place = match automation.block_id.as_deref() {
        None | Some("") => "(top of page)".to_string(),
        Some(block) => format!("#{block}"),
    };
    let state = if let Some(problem) = automation.problem.as_deref() {
        format!("⚠ {problem}")
    } else if automation.once && !automation.enabled && automation.last_run_at.is_some() {
        "done: give its ⏳ a new time to remind again".to_string()
    } else if !automation.enabled {
        "paused".to_string()
    } else {
        format!("next {}", automation.next_run_at)
    };
    let last = match (&automation.last_run_at, &automation.last_channel_id) {
        (Some(at), Some(channel)) => format!(" · last {at} in {channel}"),
        (Some(at), None) => format!(" · last {at}"),
        _ => String::new(),
    };
    format!(
        "{} · {place} · {state}{last}\n    {}",
        automation.id,
        automation.source.as_deref().unwrap_or_default()
    )
}

fn automations_route(space: &str, page: &str) -> String {
    format!("{}/automations", page_route(space, page))
}

/// A page's schedules, for `page read`'s header; none when they cannot be read.
pub(crate) async fn page_automations(
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
pub(crate) fn render_page_automations_header(automations: &[PageAutomation]) -> String {
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

pub(crate) async fn cmd_page_automation(
    hub_url: &str,
    token: &str,
    command: PageAutomationCommand,
) -> error::Result<()> {
    let (page, automation, space, action) = match command {
        PageAutomationCommand::List { page, space } => {
            let space = resolve_space(hub_url, token, space).await?;
            let url = with_route(hub_url, &automations_route(&space, &page));
            let response: ListResponse = http::request_json(&url, "GET", Some(token), None).await?;
            if response.automations.is_empty() {
                println!(
                    "(no schedules on this page: write `- [ ] <what to do> 🔁 every 12 hours` in a section with `page edit`)"
                );
            }
            for automation in &response.automations {
                println!("{}", render_page_automation(automation));
            }
            return Ok(());
        }
        PageAutomationCommand::Pause {
            page,
            automation,
            space,
        } => (page, automation, space, "pause"),
        PageAutomationCommand::Resume {
            page,
            automation,
            space,
        } => (page, automation, space, "resume"),
        PageAutomationCommand::Run {
            page,
            automation,
            space,
        } => (page, automation, space, "run"),
        PageAutomationCommand::Delete {
            page,
            automation,
            space,
        } => (page, automation, space, "delete"),
    };
    let space = resolve_space(hub_url, token, space).await?;
    let route = format!("{}/{}", automations_route(&space, &page), enc(&automation));
    let (route, method) = if action == "delete" {
        (route, "DELETE")
    } else {
        (format!("{route}/{action}"), "POST")
    };
    http::request_json::<serde_json::Value>(
        &with_route(hub_url, &route),
        method,
        Some(token),
        Some(json!({})),
    )
    .await?;
    println!(
        "{} {}",
        "✓".green().bold(),
        match action {
            "pause" => "Paused: its line is now `- [-]`",
            "resume" => "Resumed: its line is now `- [ ]`",
            "delete" => "Deleted: its line is out of the page",
            _ => "Due now; it runs in a new conversation",
        }
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn automation(json: serde_json::Value) -> PageAutomation {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn a_schedule_says_where_it_is_whether_it_runs_and_its_line() {
        let running = automation(json!({
            "id": "a-1", "enabled": true, "blockId": "audit", "nextRunAt": "2026-11-01T02:00:00.000Z",
            "source": "- [ ] Audit the code 🔁 every 12 hours",
        }));
        assert_eq!(
            render_page_automation(&running),
            "a-1 · #audit · next 2026-11-01T02:00:00.000Z\n    - [ ] Audit the code 🔁 every 12 hours"
        );
        let stuck = automation(json!({
            "id": "a-2", "enabled": false, "nextRunAt": "2026-11-01T02:00:00.000Z",
            "problem": "Connect GitHub for this Space to run on its repositories",
        }));
        assert!(render_page_automation(&stuck).starts_with("a-2 · (top of page) · ⚠ Connect GitHub"));
        let done = automation(json!({
            "id": "a-3", "once": true, "enabled": false, "nextRunAt": "2026-11-01T02:00:00.000Z",
            "lastRunAt": "2026-11-01T02:00:03.000Z", "lastChannelId": "c-9",
        }));
        assert!(render_page_automation(&done).starts_with(
            "a-3 · (top of page) · done: give its ⏳ a new time to remind again · last 2026-11-01T02:00:03.000Z in c-9"
        ));
    }
}
