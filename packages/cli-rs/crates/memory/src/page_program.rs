//! A page's Norn programs in `page read`'s header
//! (docs/architecture/norn-host.md): each `norn run` block, how it stands,
//! and where its work is discussed.

use serde::Deserialize;
use xmatrix_cli_core::http;
use xmatrix_cli_core::protocol::with_route;

use crate::page::page_route;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageProgram {
    pub name: String,
    #[serde(default)]
    pub channel_id: Option<String>,
    pub state: String,
    /// Why the block as written does not run.
    #[serde(default)]
    pub problem: Option<String>,
    /// How its program ended.
    #[serde(default)]
    pub result: Option<String>,
    /// Each request the program made, oldest first.
    #[serde(default)]
    pub requests: Vec<PageProgramRequest>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageProgramRequest {
    pub holder: String,
    pub asked_at: String,
    #[serde(default)]
    pub outcome: Option<String>,
    #[serde(default)]
    pub settled_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProgramsResponse {
    programs: Vec<PageProgram>,
}

/// A page's programs, for `page read`'s header; none when they cannot be read.
pub(crate) async fn page_programs(
    hub_url: &str,
    token: &str,
    space: &str,
    page: &str,
) -> Vec<PageProgram> {
    let url = with_route(hub_url, &format!("{}/programs", page_route(space, page)));
    http::request_json::<ProgramsResponse>(&url, "GET", Some(token), None)
        .await
        .map(|response| response.programs)
        .unwrap_or_default()
}

/// One program in one line: its state, its conversation, and its latest request.
fn render_page_program(program: &PageProgram) -> String {
    let mut line = format!("{} · {}", program.name, program.state.replace('_', " "));
    if let Some(channel) = &program.channel_id {
        line.push_str(&format!(" in {channel}"));
    }
    if let Some(request) = program.requests.last() {
        let asked = program.requests.len();
        let latest = match (&request.outcome, &request.settled_at) {
            (Some(outcome), Some(at)) => {
                format!("{} {} {at}", request.holder, outcome.replace('_', " "))
            }
            _ => format!("{} asked {}, open", request.holder, request.asked_at),
        };
        line.push_str(&format!(" · {asked} asked, latest: {latest}"));
    }
    if let Some(why) = program.problem.as_ref().or(program.result.as_ref()) {
        line.push_str(&format!("\n    {}", why.lines().next().unwrap_or_default()));
    }
    line
}

/// The `programs:` lines of `page read`'s header.
pub(crate) fn render_page_programs_header(programs: &[PageProgram]) -> String {
    if programs.is_empty() {
        return String::new();
    }
    let mut out = String::from("programs:\n");
    for program in programs {
        out.push_str(&format!("  - {}\n", render_page_program(program)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_page_read_says_how_each_program_stands() {
        let programs: Vec<PageProgram> = serde_json::from_value(json!([
            { "name": "audit", "channelId": "conv-1", "state": "running", "requests": [
                { "holder": "@auto", "text": "Audit", "askedAt": "2026-11-13T10:00:00.000Z", "by": null,
                  "outcome": "no_reply", "reply": null, "settledAt": "2026-11-13T18:00:00.000Z" },
                { "holder": "@claude", "text": "Audit", "askedAt": "2026-11-13T18:00:01.000Z", "by": null,
                  "outcome": null, "reply": null, "settledAt": null }] },
            { "name": "main", "state": "not_started", "problem": "1:1 Unbound name remind\nmore", "requests": [] },
            { "name": "check", "channelId": "conv-2", "state": "completed", "result": "()",
              "requests": [{ "holder": "@auto", "text": "Check", "askedAt": "2026-11-12T09:00:00.000Z", "by": null,
                "outcome": "answered", "reply": "fine", "settledAt": "2026-11-12T09:04:00.000Z" }] }
        ]))
        .unwrap();
        assert_eq!(
            render_page_programs_header(&programs),
            "programs:\n  - audit · running in conv-1 · 2 asked, latest: @claude asked 2026-11-13T18:00:01.000Z, open\n\
             \x20 - main · not started\n    1:1 Unbound name remind\n\
             \x20 - check · completed in conv-2 · 1 asked, latest: @auto answered 2026-11-12T09:04:00.000Z\n    ()\n"
        );
        assert_eq!(render_page_programs_header(&[]), "");
    }
}
