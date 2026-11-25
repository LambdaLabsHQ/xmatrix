// `xmatrix channel subscribe --wait`: subscribe, then stay until what was
// subscribed to reports in the conversation. The report comes from the Hub's
// GitHub webhook, so this reads only the conversation on the Hub and never
// GitHub. An Agent runs it with its harness's own wait (a background or
// long-running command), and the harness's open wait is what shows its
// Instance as waiting (`runtime_waiting.rs`); the subscription itself stays
// on the Hub, so the report still wakes the Instance if this process dies.

use std::time::{Duration, Instant};

use colored::Colorize;
use xmatrix_cli_core::error::{self, CliError};
use xmatrix_cli_core::protocol;

use crate::{Subscribed, cmd_channel_subscribe, fetch_channel_chat_history};

/// How often the conversation is read for the report.
const READ_INTERVAL: Duration = Duration::from_secs(10);
/// How often a line says the wait goes on, so a harness that cuts a silent
/// command sees output.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(300);
/// Messages read per pass.
const READ_LIMIT: u32 = 200;

/// What a subscription waits on, from its URL.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WaitTarget {
    /// A workflow run, by id: its verdict message has a fixed id.
    Run { run_id: String },
    /// A pull request: any GitHub message that links it.
    PullRequest { link: String },
}

pub(crate) fn wait_target(url: &str) -> Option<WaitTarget> {
    let path = url.trim().strip_prefix("https://github.com/")?;
    let parts: Vec<&str> = path.split(['/', '?', '#']).collect();
    match parts.as_slice() {
        [owner, repo, "actions", "runs", run_id, ..]
            if !owner.is_empty() && !repo.is_empty() && is_number(run_id) =>
        {
            Some(WaitTarget::Run {
                run_id: (*run_id).to_string(),
            })
        }
        [owner, repo, "pull", number, ..]
            if !owner.is_empty() && !repo.is_empty() && is_number(number) =>
        {
            Some(WaitTarget::PullRequest {
                link: format!("github.com/{owner}/{repo}/pull/{number}").to_lowercase(),
            })
        }
        _ => None,
    }
}

fn is_number(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

/// Whether this message is the report the wait is for.
pub(crate) fn is_report(
    target: &WaitTarget,
    channel_id: &str,
    message: &protocol::ChannelMessage,
) -> bool {
    match target {
        WaitTarget::Run { run_id } => {
            message.message_id == format!("app:github:run:{run_id}:{channel_id}")
        }
        WaitTarget::PullRequest { link } => {
            message.message_id.starts_with("app:github:")
                && !message.message_id.starts_with("app:github:follow:")
                && !message.message_id.starts_with("app:github:run:")
                && message.body.to_lowercase().contains(&format!("{link})"))
        }
    }
}

/// A report that says something failed: a run's verdict other than passed,
/// or a pull request's failed CI.
pub(crate) fn report_failed(target: &WaitTarget, body: &str) -> bool {
    let body = body.trim_end();
    match target {
        WaitTarget::Run { .. } => !body.ends_with(" passed."),
        WaitTarget::PullRequest { .. } => body.starts_with("CI failed"),
    }
}

pub(crate) async fn cmd_channel_subscribe_wait(
    hub_url: &str,
    token: &str,
    channel_id: &str,
    url: &str,
    timeout: Duration,
) -> error::Result<()> {
    let target = wait_target(url).ok_or_else(|| {
        CliError::Launch(format!(
            "--wait needs a pull request or workflow run URL on github.com, not {url}"
        ))
    })?;
    // Read where the conversation stands first, so a report that lands while
    // subscribing is not missed.
    let recent = fetch_channel_chat_history(hub_url, token, channel_id, READ_LIMIT, None).await?;
    let mut after = recent
        .iter()
        .filter_map(|message| message.sequence)
        .max()
        .unwrap_or(0);
    if let Subscribed::Completed(conclusion) =
        cmd_channel_subscribe(hub_url, token, channel_id, url).await?
    {
        return match conclusion.as_str() {
            "success" | "skipped" | "neutral" => Ok(()),
            _ => Err(CliError::Launch(format!(
                "The run already ended: {conclusion}."
            ))),
        };
    }
    // A run's verdict has one fixed id, so one already here is the answer.
    if let WaitTarget::Run { .. } = target
        && let Some(report) = recent
            .iter()
            .find(|message| is_report(&target, channel_id, message))
    {
        return reported(&target, report);
    }
    println!(
        "Waiting up to {} min for it to report in this conversation…",
        timeout.as_secs() / 60
    );
    let started = Instant::now();
    let mut said = Instant::now();
    loop {
        let mut messages =
            match fetch_channel_chat_history(hub_url, token, channel_id, READ_LIMIT, Some(after))
                .await
            {
                Ok(messages) => messages,
                // A failed read is retried on the next pass; the subscription
                // itself is safe on the Hub.
                Err(error) => {
                    eprintln!("Reading the conversation failed, retrying: {error}");
                    Vec::new()
                }
            };
        messages.sort_by(protocol::compare_channel_messages);
        if let Some(report) = messages
            .iter()
            .find(|message| is_report(&target, channel_id, message))
        {
            return reported(&target, report);
        }
        if let Some(through) = messages.iter().filter_map(|message| message.sequence).max() {
            after = after.max(through);
        }
        let waited = started.elapsed();
        if waited >= timeout {
            return Err(CliError::Launch(format!(
                "Nothing reported within {} min. The subscription stays, so the report still arrives in this conversation.",
                timeout.as_secs() / 60
            )));
        }
        if said.elapsed() >= HEARTBEAT_INTERVAL {
            println!("Still waiting ({} min so far)…", waited.as_secs() / 60);
            said = Instant::now();
        }
        tokio::time::sleep(READ_INTERVAL.min(timeout - waited)).await;
    }
}

fn reported(target: &WaitTarget, report: &protocol::ChannelMessage) -> error::Result<()> {
    println!("{} {}", "Reported:".bold(), report.body.trim());
    if report_failed(target, &report.body) {
        Err(CliError::Launch("It reported a failure.".into()))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, body: &str) -> protocol::ChannelMessage {
        serde_json::from_value(serde_json::json!({
            "messageId": id,
            "channelId": "c1",
            "from": { "kind": "app", "label": "GitHub", "userId": "", "email": "" },
            "body": body,
            "sentAt": "2026-11-25T00:00:00Z",
        }))
        .expect("message")
    }

    #[test]
    fn reads_targets_from_urls() {
        assert_eq!(
            wait_target("https://github.com/O/R/actions/runs/123"),
            Some(WaitTarget::Run {
                run_id: "123".into()
            })
        );
        assert_eq!(
            wait_target("https://github.com/O/R/actions/runs/123/job/9"),
            Some(WaitTarget::Run {
                run_id: "123".into()
            })
        );
        assert_eq!(
            wait_target("https://github.com/O/R/pull/42#issuecomment-1"),
            Some(WaitTarget::PullRequest {
                link: "github.com/o/r/pull/42".into()
            })
        );
        assert_eq!(wait_target("https://gitlab.com/O/R/pull/42"), None);
        assert_eq!(wait_target("https://github.com/O/R/pull/x"), None);
    }

    #[test]
    fn matches_only_its_report() {
        let run = WaitTarget::Run {
            run_id: "123".into(),
        };
        assert!(is_report(
            &run,
            "c1",
            &message("app:github:run:123:c1", "x passed.")
        ));
        assert!(!is_report(
            &run,
            "c1",
            &message("app:github:run:1234:c1", "x passed.")
        ));
        assert!(!is_report(
            &run,
            "c2",
            &message("app:github:run:123:c1", "x passed.")
        ));

        let pr = WaitTarget::PullRequest {
            link: "github.com/o/r/pull/42".into(),
        };
        let ci = "CI passed on [O/R#42](https://github.com/O/R/pull/42) at abc.";
        assert!(is_report(
            &pr,
            "c1",
            &message("app:github:ci:abc:42:t:c1", ci)
        ));
        assert!(!is_report(
            &pr,
            "c1",
            &message("app:github:follow:x:c1", ci)
        ));
        assert!(!is_report(
            &pr,
            "c1",
            &message(
                "app:github:ci:abc:420:t:c1",
                "CI passed on [O/R#420](https://github.com/O/R/pull/420) at abc."
            )
        ));
        assert!(!is_report(&pr, "c1", &message("user-message", ci)));
    }

    #[test]
    fn tells_failures() {
        let run = WaitTarget::Run { run_id: "1".into() };
        assert!(!report_failed(&run, "Workflow run [x](u) in o/r passed."));
        assert!(report_failed(&run, "Workflow run [x](u) in o/r failed."));
        assert!(report_failed(&run, "Workflow run [x](u) in o/r cancelled."));
        let pr = WaitTarget::PullRequest { link: "l".into() };
        assert!(report_failed(&pr, "CI failed on [O/R#1](u) at abc."));
        assert!(!report_failed(&pr, "Merged [O/R#1](u)"));
    }
}
