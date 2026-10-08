//! `xmatrix page`: the Space's living documents
//! (docs/design/pages-and-conversations.md). Agents read pages as markdown,
//! edit against the revision they read, and every read or edit from a Run is
//! linked to the Run's conversation so a page shows who is working on it.

use std::collections::BTreeMap;
use std::path::PathBuf;

use colored::Colorize;
use serde::Deserialize;
use serde_json::json;
use xmatrix_cli_args::{PageCommand, PageMigrationCommand};
use xmatrix_cli_core::error::{self, CliError};
use xmatrix_cli_core::http;
use xmatrix_cli_core::protocol::{channel_pages_route, with_route};
use xmatrix_cli_core::text_input::{self, TextRoutes, TextSource};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSummary {
    pub page_id: String,
    pub parent_page_id: Option<String>,
    pub title: String,
    pub position: String,
    pub access_mode: String,
    pub head_revision: u64,
    #[serde(default)]
    pub agent_suggest_only: bool,
    pub can_edit: bool,
    /// The page that states how the Space is run.
    #[serde(default)]
    pub governance: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageAuthor {
    pub kind: String,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRevision {
    pub revision: u64,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub authors: Vec<PageAuthor>,
    #[serde(default)]
    pub conversation_ids: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDocument {
    #[serde(flatten)]
    pub summary: PageSummary,
    pub body: String,
    pub revision_info: PageRevision,
}

/// What a reader of each section should know besides its text: when and
/// where it last changed, who has claimed it, who is on it now.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageAwareness {
    #[serde(default)]
    pub blocks: Vec<PageBlockAwareness>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageBlockAwareness {
    pub block_id: String,
    #[serde(default)]
    pub updated: Option<PageRevision>,
    #[serde(default)]
    pub claims: Vec<PageClaim>,
    #[serde(default)]
    pub present: Vec<PagePresent>,
    #[serde(default)]
    pub discussions: Vec<PageDiscussion>,
    #[serde(default)]
    pub owed: Option<PageOwedUpdate>,
    #[serde(default)]
    pub working: Vec<PageWorkingAgent>,
}

/// An Agent live in a conversation linked to a section, whether or not it has
/// the page open.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageWorkingAgent {
    pub name: String,
    pub status: String,
    pub conversation_id: String,
}

/// Claimed work on a section ended after its last change and was not written back.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageOwedUpdate {
    pub reason: String,
    pub at: String,
    pub holder: String,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub pull_request_url: Option<String>,
}

/// An open discussion anchored in a section's text.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDiscussion {
    pub link_id: String,
    pub conversation_id: String,
    pub quote: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PagePresent {
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub activity: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
}

#[derive(Deserialize)]
struct TreeResponse {
    pages: Vec<PageSummary>,
}

#[derive(Deserialize)]
struct PageResponse {
    page: PageDocument,
}

#[derive(Deserialize)]
struct PageSummaryResponse {
    page: PageSummary,
}

#[derive(Deserialize)]
struct RemoveResponse {
    removed: bool,
}

/// An edit is merged and committed by the page's live session, which says
/// what it did besides its text.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditResponse {
    revision: u64,
    kind: String,
    head_revision: u64,
    // Absent from a Hub before these were reported.
    #[serde(default)]
    detached_automations: Vec<PageAutomationAnchorChange>,
    #[serde(default)]
    attached_automations: Vec<PageAutomationAnchorChange>,
    #[serde(default)]
    removed_sections: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageAutomationAnchorChange {
    automation_id: String,
    name: String,
}

/// What an edit did besides its text, one line each, so a writer whose edit
/// dropped sections or paused Automations sees it at once.
fn render_edit_effects(page: &str, base: u64, edited: &EditResponse) -> String {
    let mut out = String::new();
    for section in &edited.removed_sections {
        out.push_str(&format!(
            "⚠ Removed section \"{section}\" and everything under it. If that was not meant, \
             see it with: xmatrix page read {page} --revision {base}\n"
        ));
    }
    for automation in &edited.detached_automations {
        out.push_str(&format!(
            "⚠ Detached Automation \"{}\" ({}): its reference left the page, so it is paused. \
             Put the reference back to resume it.\n",
            automation.name, automation.automation_id
        ));
    }
    for automation in &edited.attached_automations {
        out.push_str(&format!(
            "Resumed Automation \"{}\" ({}): its reference is on the page again.\n",
            automation.name, automation.automation_id
        ));
    }
    out
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageClaim {
    pub claim_id: String,
    pub block_id: String,
    pub holder: PageAuthor,
    pub expires_at: String,
    #[serde(default)]
    pub conversation_id: Option<String>,
}

#[derive(Deserialize)]
struct ClaimResponse {
    claim: PageClaim,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimsResponse {
    claims: Vec<PageClaim>,
    competitive_blocks: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreReviewResponse {
    head_sha: String,
}

#[derive(Deserialize)]
struct ReleaseResponse {
    released: bool,
}

/// One line per claim: where, who, until when, and its id to release it.
pub fn render_page_claim(claim: &PageClaim) -> String {
    let block = if claim.block_id.is_empty() {
        "(whole page)".to_string()
    } else {
        format!("#{}", claim.block_id)
    };
    format!(
        "{block} {} until {} · {}",
        claim.holder.label, claim.expires_at, claim.claim_id
    )
}

#[derive(Deserialize)]
struct HistoryResponse {
    revisions: Vec<PageRevision>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpaceResponse {
    space_id: String,
}

pub(crate) fn enc(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}

/// Where this Run records that it has written back to its pages (or found
/// nothing to write back), beside its status file.
fn writeback_marker() -> Option<PathBuf> {
    std::env::var_os("XMATRIX_RUN_STATUS_FILE").map(writeback_marker_for)
}

/// Each Run has its own status file; the marker extends that name, so one
/// Run's write-back never speaks for another's.
fn writeback_marker_for(status: std::ffi::OsString) -> PathBuf {
    let mut marker = status;
    marker.push(".page-writeback");
    PathBuf::from(marker)
}

fn record_writeback(note: &str) {
    if let Some(path) = writeback_marker() {
        let _ = std::fs::write(path, note);
    }
}

/// The conversation this Run works in, if it is a Run.
fn run_conversation() -> Option<String> {
    std::env::var("XMATRIX_AUTO_JOIN_CHANNEL_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
}

pub(crate) async fn resolve_space(
    hub_url: &str,
    token: &str,
    space: Option<String>,
) -> error::Result<String> {
    if let Some(space) = space.filter(|value| !value.trim().is_empty()) {
        return xmatrix_cli_core::space_ref::resolve_space_ref(hub_url, token, &space).await;
    }
    let Some(conversation) = run_conversation() else {
        return Err(CliError::Launch(
            "pass --space <space-id> (outside a Run there is no conversation to resolve it from)"
                .into(),
        ));
    };
    let url = with_route(
        hub_url,
        &format!("/api/channels/{}/page-space", enc(&conversation)),
    );
    let response: SpaceResponse = http::request_json(&url, "GET", Some(token), None).await?;
    Ok(response.space_id)
}

pub(crate) fn page_route(space: &str, page: &str) -> String {
    format!("/api/spaces/{}/pages/{}", enc(space), enc(page))
}

/// Children listed under their parent, in sibling order.
pub fn render_page_tree(pages: &[PageSummary]) -> String {
    let mut children: BTreeMap<Option<String>, Vec<&PageSummary>> = BTreeMap::new();
    for page in pages {
        children
            .entry(page.parent_page_id.clone())
            .or_default()
            .push(page);
    }
    for list in children.values_mut() {
        list.sort_by(|a, b| a.position.cmp(&b.position).then(a.page_id.cmp(&b.page_id)));
    }
    let known: std::collections::HashSet<&str> = pages.iter().map(|p| p.page_id.as_str()).collect();
    let mut out = String::new();
    fn walk(
        out: &mut String,
        children: &BTreeMap<Option<String>, Vec<&PageSummary>>,
        parent: Option<String>,
        depth: usize,
    ) {
        let Some(list) = children.get(&parent) else {
            return;
        };
        for page in list {
            let marks = format!(
                "{}{}{}",
                if page.governance { " [governance]" } else { "" },
                if page.access_mode == "restricted" {
                    " [restricted]"
                } else {
                    ""
                },
                if page.can_edit { "" } else { " [read-only]" }
            );
            out.push_str(&format!(
                "{}- {} ({} · r{}){}\n",
                "  ".repeat(depth),
                page.title,
                page.page_id,
                page.head_revision,
                marks
            ));
            if depth < 64 {
                walk(out, children, Some(page.page_id.clone()), depth + 1);
            }
        }
    }
    walk(&mut out, &children, None, 0);
    // A page whose parent this reader cannot open is shown at the top level.
    for (parent, list) in &children {
        if let Some(parent) = parent
            && !known.contains(parent.as_str())
        {
            for page in list {
                out.push_str(&format!(
                    "- {} ({} · r{})\n",
                    page.title, page.page_id, page.head_revision
                ));
                walk(&mut out, &children, Some(page.page_id.clone()), 1);
            }
        }
    }
    out
}

/// What changed on a page since a revision someone read.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageChanges {
    pub page_id: String,
    pub since: u64,
    pub head_revision: u64,
    #[serde(default)]
    pub revisions: Vec<PageRevision>,
    #[serde(default)]
    pub diff: Vec<PageDiffPart>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PageDiffPart {
    pub kind: String,
    pub lines: Vec<String>,
}

/// The revisions after `since` and a diff of the page since then, with a line of context around each change.
pub fn render_page_changes(changes: &PageChanges) -> String {
    let mut out = format!(
        "---\npageId: {}\nsince: {}\nheadRevision: {}\n",
        changes.page_id, changes.since, changes.head_revision
    );
    if changes.revisions.is_empty() {
        out.push_str("---\n(no changes)\n");
        return out;
    }
    out.push_str("revisions:\n");
    for revision in &changes.revisions {
        let authors = revision
            .authors
            .iter()
            .map(|a| a.label.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let mut line = format!(
            "  r{} {} by {}",
            revision.revision, revision.created_at, authors
        );
        if let Some(conversation) = revision.conversation_ids.first() {
            line.push_str(&format!(" in conversation {conversation}"));
        }
        out.push_str(&line);
        out.push('\n');
    }
    out.push_str("---\n");
    let last = changes.diff.len().saturating_sub(1);
    for (index, part) in changes.diff.iter().enumerate() {
        match part.kind.as_str() {
            "added" => part
                .lines
                .iter()
                .for_each(|line| out.push_str(&format!("+ {line}\n"))),
            "removed" => part
                .lines
                .iter()
                .for_each(|line| out.push_str(&format!("- {line}\n"))),
            _ => {
                // Unchanged text: one line of context beside each change.
                let lines = &part.lines;
                let head = if index > 0 { lines.first() } else { None };
                let tail = if index < last && (lines.len() > 1 || head.is_none()) {
                    lines.last()
                } else {
                    None
                };
                let shown = usize::from(head.is_some()) + usize::from(tail.is_some());
                if let Some(line) = head {
                    out.push_str(&format!("  {line}\n"));
                }
                if lines.len() > shown {
                    out.push_str("  …\n");
                }
                if let Some(line) = tail {
                    out.push_str(&format!("  {line}\n"));
                }
            }
        }
    }
    out
}

/// The `blocks:` front matter: per section, its last change, claims and who is on it.
pub fn render_page_awareness(awareness: &PageAwareness) -> String {
    let mut out = String::new();
    for block in &awareness.blocks {
        let mut lines = Vec::new();
        if let Some(updated) = &block.updated {
            let authors = updated
                .authors
                .iter()
                .map(|a| a.label.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            let mut line = format!(
                "updated: r{} {} by {}",
                updated.revision, updated.created_at, authors
            );
            if let Some(conversation) = updated.conversation_ids.first() {
                line.push_str(&format!(" in conversation {conversation}"));
            }
            lines.push(line);
        }
        for claim in &block.claims {
            let mut line = format!(
                "claimed: {} until {} (claim {})",
                claim.holder.label, claim.expires_at, claim.claim_id
            );
            if let Some(conversation) = &claim.conversation_id {
                line.push_str(&format!(" in conversation {conversation}"));
            }
            lines.push(line);
        }
        for person in &block.present {
            let mut line = format!(
                "{}: {}",
                person.activity.as_deref().unwrap_or("viewing"),
                person.name
            );
            if person.kind == "agent" {
                line.push_str(" (Agent)");
            }
            if let Some(conversation) = &person.conversation_id {
                line.push_str(&format!(" in conversation {conversation}"));
            }
            lines.push(line);
        }
        for agent in &block.working {
            let state = if agent.status == "busy" {
                "working"
            } else {
                "idle"
            };
            lines.push(format!(
                "{state}: {} (Agent) in conversation {}",
                agent.name, agent.conversation_id
            ));
        }
        if let Some(owed) = &block.owed {
            let what = match (owed.reason.as_str(), &owed.pull_request_url) {
                ("merged", Some(url)) => format!("{url} merged"),
                ("released", _) => "claim released".to_string(),
                ("lapsed", _) => "claim lapsed".to_string(),
                _ => "claimed work ended".to_string(),
            };
            let mut line = format!("owed: an update — {what} at {} ({})", owed.at, owed.holder);
            if let Some(conversation) = &owed.conversation_id {
                line.push_str(&format!(" in conversation {conversation}"));
            }
            lines.push(line);
        }
        for discussion in &block.discussions {
            let quote: String = discussion.quote.chars().take(80).collect();
            lines.push(format!(
                "discussion: \"{}\" in conversation {} (link {}; `xmatrix page resolve` once its outcome is in the page)",
                quote.replace('"', "'"),
                discussion.conversation_id,
                discussion.link_id
            ));
        }
        if lines.is_empty() {
            continue;
        }
        let name = if block.block_id.is_empty() {
            "(top)"
        } else {
            block.block_id.as_str()
        };
        out.push_str(&format!("  {name}:\n"));
        for line in lines {
            out.push_str(&format!("    {line}\n"));
        }
    }
    if out.is_empty() {
        out
    } else {
        format!("blocks:\n{out}")
    }
}

pub fn render_page_document(page: &PageDocument) -> String {
    render_page_document_with(page, None)
}

/// The page with its header; the header carries each section's awareness when it is known.
pub fn render_page_document_with(page: &PageDocument, awareness: Option<&PageAwareness>) -> String {
    let authors = page
        .revision_info
        .authors
        .iter()
        .map(|author| author.label.clone())
        .collect::<Vec<_>>()
        .join(", ");
    let mut header = format!(
        "---\npageId: {}\ntitle: {}\nrevision: {}\nheadRevision: {}\ncanEdit: {}\nlastEditedBy: {}\n",
        page.summary.page_id,
        page.summary.title,
        page.revision_info.revision,
        page.summary.head_revision,
        page.summary.can_edit,
        authors
    );
    if page.summary.agent_suggest_only {
        header.push_str("agentEdits: suggestions for a human to accept\n");
    }
    if let Some(awareness) = awareness {
        header.push_str(&render_page_awareness(awareness));
    }
    header.push_str("---\n");
    format!("{header}{}", page.body)
}

/// Page markdown and Automation instructions can be resent with -f or --stdin.
pub(crate) const PAGE_TEXT_ROUTES: TextRoutes<'static> = TextRoutes {
    stdin: true,
    file_flag: Some("-f"),
};

fn read_body(body: Option<String>, file: Option<PathBuf>, stdin: bool) -> error::Result<String> {
    let given = [body.is_some(), file.is_some(), stdin]
        .iter()
        .filter(|x| **x)
        .count();
    if given != 1 {
        return Err(CliError::Launch(
            "give the new markdown with exactly one of -m, -f or --stdin".into(),
        ));
    }
    let (text, source) = match (body, file) {
        (Some(body), _) => (body, TextSource::Argument),
        (None, Some(file)) => (text_input::read_text_file(&file)?, TextSource::File),
        (None, None) => (text_input::read_stdin_text()?, TextSource::Stdin),
    };
    text_input::ensure_text_intact("page markdown", &text, source, PAGE_TEXT_ROUTES)?;
    Ok(text)
}

pub async fn cmd_page(hub_url: &str, token: &str, command: PageCommand) -> error::Result<()> {
    match command {
        PageCommand::Linked { conversation } => {
            let conversation = conversation.or_else(run_conversation).ok_or_else(|| {
                CliError::Launch("page linked needs --conversation outside a Run".into())
            })?;
            let pages = linked_pages(hub_url, token, &channel_pages_route(&conversation)).await?;
            print!("{}", render_linked_pages(&pages));
            Ok(())
        }
        PageCommand::Tree { space } => {
            let space = resolve_space(hub_url, token, space).await?;
            let url = with_route(hub_url, &format!("/api/spaces/{}/pages", enc(&space)));
            let response: TreeResponse = http::request_json(&url, "GET", Some(token), None).await?;
            if response.pages.is_empty() {
                println!("(no pages yet)");
            } else {
                print!("{}", render_page_tree(&response.pages));
            }
            Ok(())
        }
        PageCommand::Read {
            page,
            space,
            revision,
            since,
            block,
            no_link,
        } => {
            let space = resolve_space(hub_url, token, space).await?;
            if let Some(since) = since {
                let route = format!("{}/changes?since={since}", page_route(&space, &page));
                let changes: PageChanges =
                    http::request_json(&with_route(hub_url, &route), "GET", Some(token), None)
                        .await?;
                print!("{}", render_page_changes(&changes));
                return Ok(());
            }
            let mut query = Vec::new();
            if let Some(revision) = revision {
                query.push(format!("revision={revision}"));
            }
            if !no_link && let Some(conversation) = run_conversation() {
                query.push(format!("conversationId={}", enc(&conversation)));
                if let Some(block) = &block {
                    query.push(format!("blockId={}", enc(block)));
                }
            }
            let mut route = page_route(&space, &page);
            if !query.is_empty() {
                route.push('?');
                route.push_str(&query.join("&"));
            }
            let url = with_route(hub_url, &route);
            let response: PageResponse = http::request_json(&url, "GET", Some(token), None).await?;
            // The head is read with who is on what; an older revision stands alone.
            let (awareness, automations): (Option<PageAwareness>, _) = if revision.is_none() {
                let route = format!("{}/awareness", page_route(&space, &page));
                (
                    http::request_json(&with_route(hub_url, &route), "GET", Some(token), None)
                        .await
                        .ok(),
                    crate::page_automation::page_automations(hub_url, token, &space, &page).await,
                )
            } else {
                (None, Vec::new())
            };
            let document = render_page_document_with(&response.page, awareness.as_ref());
            // A page's Automations are live references: the header says what each one is now.
            let header = crate::page_automation::render_page_automations_header(&automations);
            print!(
                "{}",
                match document.split_once("\n---\n") {
                    Some((front, body)) if !header.is_empty() =>
                        format!("{front}\n{header}---\n{body}"),
                    _ => document,
                }
            );
            Ok(())
        }
        PageCommand::Edit {
            page,
            base,
            space,
            body,
            file,
            stdin,
            blocks,
            conversation,
        } => {
            let space = resolve_space(hub_url, token, space).await?;
            let text = read_body(body, file, stdin)?;
            let conversations: Vec<String> =
                conversation.or_else(run_conversation).into_iter().collect();
            let url = with_route(hub_url, &page_route(&space, &page));
            let result: error::Result<EditResponse> = http::request_json(
                &url,
                "PUT",
                Some(token),
                Some(json!({
                    "baseRevision": base,
                    "body": text,
                    "conversationIds": conversations,
                    "blockIds": blocks,
                })),
            )
            .await;
            match result {
                Ok(edited) => {
                    record_writeback(&format!("edited {page} r{}", edited.revision));
                    let verb = if edited.kind == "suggestion" {
                        "Suggested"
                    } else {
                        "Committed"
                    };
                    println!(
                        "{} {} revision {} of {} (head r{})",
                        "✓".green().bold(),
                        verb,
                        edited.revision,
                        page,
                        edited.head_revision
                    );
                    print!("{}", render_edit_effects(&page, base, &edited));
                    Ok(())
                }
                Err(error)
                    if error
                        .http_message()
                        .is_some_and(|message| message.contains("changed since you read it")) =>
                {
                    let message = error.to_string();
                    // Hand the Agent the current head so it can merge and retry.
                    let current: PageResponse = http::request_json(
                        &with_route(hub_url, &format!("{}?", page_route(&space, &page))),
                        "GET",
                        Some(token),
                        None,
                    )
                    .await?;
                    eprintln!(
                        "{} {message}\nCurrent head (r{}) follows; merge your change into it and edit again with --base {}:",
                        "!".yellow().bold(),
                        current.page.summary.head_revision,
                        current.page.summary.head_revision
                    );
                    print!("{}", render_page_document(&current.page));
                    Err(error)
                }
                Err(error) => Err(error),
            }
        }
        PageCommand::Create {
            title,
            parent,
            after,
            restricted,
            space,
            body,
            file,
            stdin,
        } => {
            let space = resolve_space(hub_url, token, space).await?;
            let mut request = json!({ "title": title });
            if body.is_some() || file.is_some() || stdin {
                request["body"] = json!(read_body(body, file, stdin)?);
            }
            if let Some(parent) = parent {
                request["parentPageId"] = json!(parent);
            }
            if let Some(after) = after {
                request["afterPageId"] = json!(after);
            }
            if restricted {
                request["accessMode"] = json!("restricted");
            }
            let url = with_route(hub_url, &format!("/api/spaces/{}/pages", enc(&space)));
            let created: PageSummaryResponse =
                http::request_json(&url, "POST", Some(token), Some(request)).await?;
            println!(
                "{} Created {} ({} · r{})",
                "✓".green().bold(),
                created.page.title,
                created.page.page_id,
                created.page.head_revision
            );
            Ok(())
        }
        PageCommand::Move {
            page,
            parent,
            root,
            after,
            space,
        } => {
            if parent.is_none() && !root && after.is_none() {
                return Err(CliError::Http(
                    "Name where the page goes: --under <page>, --root, or --after <page>".into(),
                ));
            }
            let space = resolve_space(hub_url, token, space).await?;
            let mut request = json!({});
            if root {
                request["parentPageId"] = serde_json::Value::Null;
            } else if let Some(parent) = parent {
                request["parentPageId"] = json!(parent);
            }
            if let Some(after) = after {
                request["afterPageId"] = json!(after);
            }
            let url = with_route(hub_url, &page_route(&space, &page));
            let moved: PageSummaryResponse =
                http::request_json(&url, "PATCH", Some(token), Some(request)).await?;
            println!(
                "{} Moved {} under {}",
                "✓".green().bold(),
                moved.page.title,
                moved.page.parent_page_id.as_deref().unwrap_or("the root")
            );
            Ok(())
        }
        PageCommand::Rename { page, title, space } => {
            let space = resolve_space(hub_url, token, space).await?;
            let url = with_route(hub_url, &page_route(&space, &page));
            let renamed: PageSummaryResponse =
                http::request_json(&url, "PATCH", Some(token), Some(json!({ "title": title })))
                    .await?;
            println!(
                "{} Renamed {page} to {}",
                "✓".green().bold(),
                renamed.page.title
            );
            Ok(())
        }
        PageCommand::Delete { page, space } => {
            let space = resolve_space(hub_url, token, space).await?;
            let url = with_route(hub_url, &page_route(&space, &page));
            let response: RemoveResponse =
                http::request_json(&url, "DELETE", Some(token), None).await?;
            if response.removed {
                println!("{} Deleted {page}", "✓".green().bold());
                Ok(())
            } else {
                Err(CliError::Http(format!("{page} was not deleted")))
            }
        }
        PageCommand::History { page, space } => {
            let space = resolve_space(hub_url, token, space).await?;
            let url = with_route(hub_url, &format!("{}/history", page_route(&space, &page)));
            let response: HistoryResponse =
                http::request_json(&url, "GET", Some(token), None).await?;
            for revision in response.revisions {
                let authors = revision
                    .authors
                    .iter()
                    .map(|author| format!("{} ({})", author.label, author.kind))
                    .collect::<Vec<_>>()
                    .join(", ");
                println!(
                    "r{} {} {} by {}{}",
                    revision.revision,
                    revision.kind,
                    revision.created_at,
                    authors,
                    if revision.conversation_ids.is_empty() {
                        String::new()
                    } else {
                        format!(" · from {}", revision.conversation_ids.join(", "))
                    }
                );
            }
            Ok(())
        }
        PageCommand::Done { reason } => {
            record_writeback(&format!("no change: {}", reason.as_deref().unwrap_or("")));
            // Sections this conversation's ended claims left owing an update no longer owe one.
            if let Some(conversation) = run_conversation() {
                let url = with_route(
                    hub_url,
                    &format!("/api/channels/{}/page-writeback", enc(&conversation)),
                );
                let _: serde_json::Value =
                    http::request_json(&url, "POST", Some(token), Some(json!({}))).await?;
            }
            println!("{} Noted: no page needed an update", "✓".green().bold());
            Ok(())
        }
        PageCommand::Link {
            page,
            block,
            space,
            conversation,
        } => {
            let space = resolve_space(hub_url, token, space).await?;
            let conversation = conversation
                .or_else(run_conversation)
                .ok_or_else(|| CliError::Launch("pass --conversation <channel-id>".into()))?;
            let url = with_route(hub_url, &format!("/api/spaces/{}/page-links", enc(&space)));
            let _: serde_json::Value = http::request_json(
                &url,
                "POST",
                Some(token),
                Some(json!({
                    "conversationId": conversation,
                    "pageId": page,
                    "blockId": block,
                    "source": "reference",
                })),
            )
            .await?;
            println!(
                "{} Linked {} to this conversation",
                "✓".green().bold(),
                page
            );
            Ok(())
        }
        PageCommand::Claim {
            page,
            block,
            minutes,
            space,
        } => {
            let space = resolve_space(hub_url, token, space).await?;
            let url = with_route(hub_url, &format!("{}/claims", page_route(&space, &page)));
            let response: ClaimResponse = http::request_json(
                &url,
                "POST",
                Some(token),
                Some(json!({ "blockId": block.unwrap_or_default(), "minutes": minutes })),
            )
            .await?;
            println!(
                "{} Claimed {}",
                "✓".green().bold(),
                render_page_claim(&response.claim)
            );
            Ok(())
        }
        PageCommand::Release { page, claim, space } => {
            let space = resolve_space(hub_url, token, space).await?;
            let url = with_route(
                hub_url,
                &format!("{}/claims/{}", page_route(&space, &page), enc(&claim)),
            );
            let response: ReleaseResponse =
                http::request_json(&url, "DELETE", Some(token), None).await?;
            if response.released {
                println!("{} Released {claim}", "✓".green().bold());
                println!(
                    "If the work changed what the section says, update it with `xmatrix page edit`; otherwise run `xmatrix page done`."
                );
                Ok(())
            } else {
                Err(CliError::Http(format!(
                    "{claim} is not a claim you can release"
                )))
            }
        }
        PageCommand::Resolve {
            page: _,
            link,
            reopen,
            space,
        } => {
            let space = resolve_space(hub_url, token, space).await?;
            let url = with_route(
                hub_url,
                &format!(
                    "/api/spaces/{}/page-links/{}/resolution",
                    enc(&space),
                    enc(&link)
                ),
            );
            let _: serde_json::Value = http::request_json(
                &url,
                "PUT",
                Some(token),
                Some(json!({ "resolved": !reopen })),
            )
            .await?;
            println!(
                "{} {} {link}",
                "✓".green().bold(),
                if reopen { "Reopened" } else { "Resolved" }
            );
            Ok(())
        }
        PageCommand::Claims { page, space } => {
            let space = resolve_space(hub_url, token, space).await?;
            let url = with_route(hub_url, &format!("{}/claims", page_route(&space, &page)));
            let response: ClaimsResponse =
                http::request_json(&url, "GET", Some(token), None).await?;
            if response.claims.is_empty() {
                println!("(no claims)");
            }
            for claim in &response.claims {
                println!("{}", render_page_claim(claim));
            }
            for block in &response.competitive_blocks {
                println!("#{block} is open for competition");
            }
            Ok(())
        }
        PageCommand::PreReview { verdict, summary } => {
            let conversation = run_conversation().ok_or_else(|| {
                CliError::Launch("run this from the pull request's review conversation".into())
            })?;
            let url = with_route(
                hub_url,
                &format!("/api/channels/{}/pre-review", enc(&conversation)),
            );
            let response: PreReviewResponse = http::request_json(
                &url,
                "POST",
                Some(token),
                Some(json!({ "verdict": verdict, "summary": summary })),
            )
            .await?;
            println!(
                "{} Recorded pre-review {verdict} on {}",
                "✓".green().bold(),
                response.head_sha
            );
            Ok(())
        }
        PageCommand::Migration { command } => cmd_page_migration(hub_url, token, command).await,
        PageCommand::Automation { command } => {
            crate::page_automation::cmd_page_automation(hub_url, token, command).await
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMigrationView {
    pub state: String,
    pub version: u64,
    pub drafter: Option<PageAuthor>,
    pub draft: PageMigrationDraftView,
}

#[derive(Debug, Deserialize)]
pub struct PageMigrationDraftView {
    pub pages: Vec<PageMigrationDraftPageView>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMigrationDraftPageView {
    pub key: String,
    pub parent_key: Option<String>,
    pub title: String,
    pub sources: Vec<String>,
}

/// The drafted tree as an outline: each page's key, title and source count.
pub fn render_page_migration(view: &PageMigrationView) -> String {
    let mut out = format!("state: {} · version: {}", view.state, view.version);
    if let Some(drafter) = &view.drafter {
        out.push_str(&format!(" · drafted by {}", drafter.label));
    }
    out.push('\n');
    let mut depth: BTreeMap<&str, usize> = BTreeMap::new();
    for page in &view.draft.pages {
        let level = page
            .parent_key
            .as_deref()
            .and_then(|parent| depth.get(parent))
            .map_or(0, |parent| parent + 1);
        depth.insert(&page.key, level);
        out.push_str(&format!(
            "{}- {} [{}] · {} source(s)\n",
            "  ".repeat(level),
            page.title,
            page.key,
            page.sources.len()
        ));
    }
    out
}

async fn cmd_page_migration(
    hub_url: &str,
    token: &str,
    command: PageMigrationCommand,
) -> error::Result<()> {
    match command {
        PageMigrationCommand::Show { space, json } => {
            let space = resolve_space(hub_url, token, space).await?;
            let url = with_route(
                hub_url,
                &format!("/api/spaces/{}/page-migration", enc(&space)),
            );
            let response: serde_json::Value =
                http::request_json(&url, "GET", Some(token), None).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&response)?);
            } else {
                let view: PageMigrationView = serde_json::from_value(response)?;
                print!("{}", render_page_migration(&view));
            }
            Ok(())
        }
        PageMigrationCommand::Submit {
            input,
            replaces,
            space,
        } => {
            let space = resolve_space(hub_url, token, space).await?;
            let text = std::fs::read_to_string(&input)
                .map_err(|e| CliError::Launch(format!("read {}: {e}", input.display())))?;
            let draft: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| CliError::Launch(format!("{} is not JSON: {e}", input.display())))?;
            let url = with_route(
                hub_url,
                &format!("/api/spaces/{}/page-migration/draft", enc(&space)),
            );
            let view: PageMigrationView = http::request_json(
                &url,
                "PUT",
                Some(token),
                Some(json!({ "version": replaces, "draft": draft })),
            )
            .await?;
            println!(
                "{} Submitted draft version {} with {} page(s); a Space owner or admin reviews it in Pages",
                "✓".green().bold(),
                view.version,
                view.draft.pages.len()
            );
            Ok(())
        }
        PageMigrationCommand::Apply { version, space } => {
            let space = resolve_space(hub_url, token, space).await?;
            let url = with_route(
                hub_url,
                &format!("/api/spaces/{}/page-migration/apply", enc(&space)),
            );
            let view: PageMigrationView = http::request_json(
                &url,
                "POST",
                Some(token),
                Some(json!({ "version": version })),
            )
            .await?;
            println!(
                "{} The Space now runs on pages (state {}, version {})",
                "✓".green().bold(),
                view.state,
                view.version
            );
            Ok(())
        }
    }
}

#[derive(Deserialize)]
struct LinkedPagesResponse {
    pages: Vec<PageDocument>,
}

/// The pages a conversation is linked to, whole, as the mirror reader.
pub(crate) async fn linked_pages(
    hub_url: &str,
    token: &str,
    route: &str,
) -> error::Result<Vec<PageDocument>> {
    let url = with_route(hub_url, route);
    let response: LinkedPagesResponse = http::request_json(&url, "GET", Some(token), None).await?;
    Ok(response.pages)
}

/// A read-only, on-demand snapshot; no local files or persistent cache.
fn render_linked_pages(pages: &[PageDocument]) -> String {
    if pages.is_empty() {
        return "(no pages linked to this conversation)\n".into();
    }
    pages
        .iter()
        .map(render_page_document)
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod page_tests {
    use super::*;

    #[test]
    fn edit_reports_removed_sections_and_the_automations_it_moved() {
        let edited: EditResponse = serde_json::from_value(json!({
            "revision": 225, "kind": "edit", "headRevision": 225,
            "removedSections": ["Releases"],
            "detachedAutomations": [{ "automationId": "a-1", "name": "Dependency sweep" }],
            "attachedAutomations": [{ "automationId": "a-2", "name": "CI watch" }],
        }))
        .unwrap();
        assert_eq!(
            render_edit_effects("roadmap", 224, &edited),
            "⚠ Removed section \"Releases\" and everything under it. If that was not meant, see it with: xmatrix page read roadmap --revision 224\n\
             ⚠ Detached Automation \"Dependency sweep\" (a-1): its reference left the page, so it is paused. Put the reference back to resume it.\n\
             Resumed Automation \"CI watch\" (a-2): its reference is on the page again.\n"
        );
    }

    #[test]
    fn edit_from_an_older_hub_reports_nothing_more() {
        let edited: EditResponse =
            serde_json::from_value(json!({ "revision": 2, "kind": "edit", "headRevision": 2 }))
                .unwrap();
        assert_eq!(render_edit_effects("p", 1, &edited), "");
    }

    fn page(id: &str, parent: Option<&str>, position: &str) -> PageSummary {
        PageSummary {
            page_id: id.into(),
            parent_page_id: parent.map(Into::into),
            title: id.to_uppercase(),
            position: position.into(),
            access_mode: "open".into(),
            head_revision: 1,
            agent_suggest_only: false,
            can_edit: true,
            governance: false,
        }
    }

    #[test]
    fn tree_marks_the_governance_page() {
        let rules = PageSummary {
            governance: true,
            can_edit: false,
            ..page("rules", None, "V")
        };
        assert_eq!(
            render_page_tree(&[rules]),
            "- RULES (rules · r1) [governance] [read-only]\n"
        );
    }

    #[test]
    fn tree_lists_children_under_their_parent_in_sibling_order() {
        let rendered = render_page_tree(&[
            page("b", Some("root"), "W"),
            page("root", None, "V"),
            page("a", Some("root"), "V"),
            page("orphan", Some("hidden"), "V"),
        ]);
        assert_eq!(
            rendered,
            "- ROOT (root · r1)\n  - A (a · r1)\n  - B (b · r1)\n- ORPHAN (orphan · r1)\n"
        );
    }

    #[test]
    fn document_header_carries_the_revision_to_edit_against() {
        let doc = PageDocument {
            summary: page("p", None, "V"),
            body: "# P\n".into(),
            revision_info: PageRevision {
                revision: 1,
                kind: "edit".into(),
                authors: vec![PageAuthor {
                    kind: "user".into(),
                    label: "Yiming".into(),
                }],
                conversation_ids: vec![],
                created_at: "2026-09-26T00:00:00Z".into(),
            },
        };
        let rendered = render_page_document(&doc);
        assert!(rendered.starts_with("---\npageId: p\ntitle: P\nrevision: 1\nheadRevision: 1\ncanEdit: true\nlastEditedBy: Yiming\n---\n# P\n"));
    }

    #[test]
    fn linked_pages_render_the_body_and_revision_in_link_order() {
        let document = |id: &str, revision| PageDocument {
            summary: page(id, None, "V"),
            body: format!("# {id}\n"),
            revision_info: PageRevision {
                revision,
                kind: "edit".into(),
                authors: vec![],
                conversation_ids: vec![],
                created_at: "2026-09-30T00:00:00Z".into(),
            },
        };
        let rendered = render_linked_pages(&[document("second", 7), document("first", 3)]);
        assert!(rendered.find("pageId: second").unwrap() < rendered.find("pageId: first").unwrap());
        assert!(rendered.contains("revision: 7") && rendered.contains("revision: 3"));
        assert!(rendered.contains("# second\n") && rendered.contains("# first\n"));
        assert_eq!(
            render_linked_pages(&[]),
            "(no pages linked to this conversation)\n"
        );
    }

    #[test]
    fn each_run_has_its_own_writeback_marker() {
        let a = writeback_marker_for("/runs/a.status.json".into());
        let b = writeback_marker_for("/runs/b.status.json".into());
        assert_ne!(a, b);
        assert_eq!(a, PathBuf::from("/runs/a.status.json.page-writeback"));
    }

    #[test]
    fn a_claim_renders_where_who_until_and_its_id() {
        let claim = |block: &str| PageClaim {
            claim_id: "c1".into(),
            block_id: block.into(),
            holder: PageAuthor {
                kind: "agent".into(),
                label: "claude:1".into(),
            },
            expires_at: "2026-09-27T10:00:00Z".into(),
            conversation_id: None,
        };
        assert_eq!(
            render_page_claim(&claim("search")),
            "#search claude:1 until 2026-09-27T10:00:00Z · c1"
        );
        assert!(render_page_claim(&claim("")).starts_with("(whole page) "));
    }

    #[test]
    fn a_page_read_says_who_is_on_each_section_and_when_it_last_changed() {
        let awareness: PageAwareness = serde_json::from_value(json!({
            "pageId": "p", "headRevision": 12,
            "blocks": [
                { "blockId": "status", "updated": { "revision": 12, "authors": [{ "kind": "agent", "id": "a", "label": "claude:1" }],
                    "conversationIds": ["conv-1"], "createdAt": "2026-09-27T13:00:00.000Z" },
                  "claims": [{ "claimId": "c1", "blockId": "status", "holder": { "kind": "agent", "id": "b", "label": "codex:2" },
                    "expiresAt": "2026-09-27T16:00:00.000Z", "conversationId": "conv-2" }],
                  "present": [{ "name": "claude:3", "kind": "agent", "activity": "editing", "blockId": "status", "conversationId": "conv-3" },
                    { "name": "Yiming", "kind": "user", "activity": "viewing", "blockId": "status", "conversationId": null }],
                  "discussions": [{ "linkId": "l1", "conversationId": "conv-4", "quote": "Shipped \"today\"" }],
                  "owed": { "reason": "merged", "at": "2026-09-27T15:00:00.000Z", "holder": "codex:2", "conversationId": "conv-2",
                    "pullRequestUrl": "https://github.com/o/r/pull/7" } },
                { "blockId": "notes", "updated": null, "claims": [], "present": [] }
            ]
        }))
        .unwrap();
        assert_eq!(
            render_page_awareness(&awareness),
            "blocks:\n  status:\n    updated: r12 2026-09-27T13:00:00.000Z by claude:1 in conversation conv-1\n    claimed: codex:2 until 2026-09-27T16:00:00.000Z (claim c1) in conversation conv-2\n    editing: claude:3 (Agent) in conversation conv-3\n    viewing: Yiming\n    owed: an update — https://github.com/o/r/pull/7 merged at 2026-09-27T15:00:00.000Z (codex:2) in conversation conv-2\n    discussion: \"Shipped 'today'\" in conversation conv-4 (link l1; `xmatrix page resolve` once its outcome is in the page)\n"
        );
        assert_eq!(render_page_awareness(&PageAwareness { blocks: vec![] }), "");
    }

    #[test]
    fn a_page_read_names_the_agents_working_in_conversations_linked_to_a_section() {
        let awareness: PageAwareness = serde_json::from_value(json!({
            "pageId": "p", "headRevision": 3,
            "blocks": [
                { "blockId": "", "updated": null, "claims": [], "present": [],
                  "working": [{ "name": "codex:1", "status": "idle", "conversationId": "conv-9" }] },
                { "blockId": "release", "updated": null, "claims": [], "present": [],
                  "working": [{ "name": "claude:2", "status": "busy", "conversationId": "conv-5" }] }
            ]
        }))
        .unwrap();
        assert_eq!(
            render_page_awareness(&awareness),
            "blocks:\n  (top):\n    idle: codex:1 (Agent) in conversation conv-9\n  release:\n    working: claude:2 (Agent) in conversation conv-5\n"
        );
    }

    #[test]
    fn a_page_read_since_shows_the_revisions_after_it_and_a_diff() {
        let changes: PageChanges = serde_json::from_value(json!({
            "pageId": "p", "since": 3, "headRevision": 5,
            "revisions": [
                { "revision": 4, "kind": "edit", "authors": [{ "kind": "agent", "id": "a", "label": "claude:1" }],
                  "conversationIds": ["conv-1"], "createdAt": "2026-09-27T13:00:00.000Z" },
                { "revision": 5, "kind": "edit", "authors": [{ "kind": "user", "id": "u", "label": "Yiming" }],
                  "conversationIds": [], "createdAt": "2026-09-27T14:00:00.000Z" }
            ],
            "diff": [
                { "kind": "same", "lines": ["# P", "", "## Status", ""] },
                { "kind": "removed", "lines": ["In progress"] },
                { "kind": "added", "lines": ["Shipped"] },
                { "kind": "same", "lines": ["", "## Notes", "", "none"] }
            ]
        }))
        .unwrap();
        assert_eq!(
            render_page_changes(&changes),
            "---\npageId: p\nsince: 3\nheadRevision: 5\nrevisions:\n  r4 2026-09-27T13:00:00.000Z by claude:1 in conversation conv-1\n  r5 2026-09-27T14:00:00.000Z by Yiming\n---\n  …\n  \n- In progress\n+ Shipped\n  \n  …\n"
        );
    }

    #[test]
    fn a_drafted_migration_renders_as_an_outline() {
        let view: PageMigrationView = serde_json::from_value(json!({
            "state": "proposed", "version": 2,
            "drafter": { "kind": "agent", "id": "agent-1", "label": "claude" },
            "draft": { "pages": [
                { "key": "company", "parentKey": null, "title": "Company", "body": "", "sources": ["c1"] },
                { "key": "relay", "parentKey": "company", "title": "Relay", "body": "", "sources": [] }
            ] }
        }))
        .unwrap();
        assert_eq!(
            render_page_migration(&view),
            "state: proposed · version: 2 · drafted by claude\n- Company [company] · 1 source(s)\n  - Relay [relay] · 0 source(s)\n"
        );
    }
}
