use crate::config::non_empty_env as trimmed_env;
use crate::protocol::DEFAULT_HUB_URL;

/// The shared xMatrix channel contract for every runtime.
///
/// Keep this as the sole source for rules that affect what an agent reports
/// through a channel. Runtime adapters may deliver it through different native
/// mechanisms, but must not add, remove, or weaken behavioral instructions.
pub fn channel_collaboration_policy(channel_id: &str) -> String {
    render_prompt(CHANNEL_CONTRACT, &[("channel_id", channel_id)])
}

// The prompt text lives in `prompts/*.md` so it can be read and reviewed as
// documents; see `prompts/README.md` for the slots each one fills.
const BOOTSTRAP: &str = include_str!("../prompts/bootstrap.md");
const CHANNEL_CONTRACT: &str = include_str!("../prompts/channel-contract.md");
const GOAL_COMMAND: &str = include_str!("../prompts/goal-command.md");
const WORKING_MODE_AUTONOMOUS: &str = include_str!("../prompts/working-mode-autonomous.md");
const WORKING_MODE_CAUTIOUS: &str = include_str!("../prompts/working-mode-cautious.md");

/// How far an Agent carries work before it stops to ask a human. The Hub
/// sends the registration's choice as `XMATRIX_AGENT_WORKING_MODE`; a Run
/// launched without one works autonomously.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkingMode {
    Autonomous,
    Cautious,
}

impl WorkingMode {
    pub const ENV: &'static str = "XMATRIX_AGENT_WORKING_MODE";

    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim() {
            "autonomous" => Ok(Self::Autonomous),
            "cautious" => Ok(Self::Cautious),
            other => Err(format!(
                "{} must be `autonomous` or `cautious`, got `{other}`",
                Self::ENV
            )),
        }
    }

    fn from_env() -> Self {
        match trimmed_env(Self::ENV) {
            None => Self::Autonomous,
            Some(value) => Self::parse(&value).unwrap_or_else(|error| panic!("{error}")),
        }
    }

    fn prompt(self) -> &'static str {
        match self {
            Self::Autonomous => WORKING_MODE_AUTONOMOUS,
            Self::Cautious => WORKING_MODE_CAUTIOUS,
        }
    }
}

/// `supports_self_goal` gates the `xmatrix goal` line: only runtimes whose
/// wrapper drains the goal inbox can act on it, and advertising a command that
/// silently does nothing is worse than not advertising it.
pub fn bootstrap_prompt(
    launcher: &str,
    agent_name: &str,
    hub_url: &str,
    supports_self_goal: bool,
) -> Option<String> {
    if bootstrap_disabled() {
        return None;
    }

    if let Ok(custom) = std::env::var("XMATRIX_BOOTSTRAP_PROMPT") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    let identity_context = agent_identity_context();
    let channel_policy = channel_collaboration_policy("<channel-id>");

    Some(render_prompt(
        BOOTSTRAP,
        &[
            ("agent_name", agent_name),
            ("launcher", launcher),
            ("hub_url", normalize_hub_url(hub_url)),
            ("identity_context", &identity_context),
            ("goal_context", goal_command_context(supports_self_goal)),
            ("channel_collaboration_policy", &channel_policy),
            ("working_mode", WorkingMode::from_env().prompt()),
        ],
    ))
}

/// Fills `{slot}` placeholders in one pass, so a value that itself contains
/// `{...}` is never expanded. A slot alone on its line takes that line's
/// newline with it, so an empty value leaves no blank line behind. Anything
/// in braces that is not a slot (such as a JSON example) stays as written.
fn render_prompt(template: &str, slots: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len() + 1024);
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let slot = after.find('}').and_then(|close| {
            slots
                .iter()
                .find(|(name, _)| *name == &after[..close])
                .map(|(_, value)| (close, *value))
        });
        match slot {
            Some((close, value)) => {
                let at_line_start = out.is_empty() || out.ends_with('\n');
                out.push_str(value);
                rest = &after[close + 1..];
                if at_line_start && let Some(next_line) = rest.strip_prefix('\n') {
                    rest = next_line;
                }
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn goal_command_context(supports_self_goal: bool) -> &'static str {
    if !supports_self_goal {
        return "";
    }
    GOAL_COMMAND
}

fn bootstrap_disabled() -> bool {
    matches!(
        std::env::var("XMATRIX_DISABLE_BOOTSTRAP_PROMPT"),
        Ok(value) if matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")
    )
}

fn normalize_hub_url(hub_url: &str) -> &str {
    let trimmed = hub_url.trim();
    if trimmed.is_empty() {
        DEFAULT_HUB_URL
    } else {
        trimmed
    }
}

fn agent_identity_context() -> String {
    // The registration's own instructions. The env name predates the retired
    // Role feature and is kept for daemon/wrapper compatibility.
    let Some(identity) = trimmed_env("XMATRIX_AGENT_ROLE_INITIAL_PROMPT")
        .or_else(|| trimmed_env("XMATRIX_AGENT_PROFILE_IDENTITY"))
    else {
        return String::new();
    };
    format!("\nAgent instructions (trusted launch configuration):\n{identity}\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_default_prompt_for_any_launcher() {
        let prompt = bootstrap_prompt("node", "custom-demo", "https://xmatrix.sh", true).unwrap();
        assert!(prompt.contains("xMatrix is a multi-agent coordination tool"));
        assert!(prompt.contains("Agent name: custom-demo"));
        assert!(prompt.contains("/agent rename <name>"));
        assert!(prompt.contains("ask the human what name you should use"));
        assert!(prompt.contains("Launched via: node"));
        assert!(prompt.contains("`xmatrix list`"));
        assert!(prompt.contains("`xmatrix channel history <channel-id>`"));
        assert!(prompt.contains("also accepts a pasted xmatrix.sh channel URL"));
        assert!(prompt.contains("`xmatrix channel history <url>`"));
        assert!(prompt.contains("Do not open a browser"));
        assert!(prompt.contains("`xmatrix send <channel-id> \"<message>\"`"));
        assert!(prompt.contains("`xmatrix page automation list <page-id>`"));
        assert!(prompt.contains("You can control the lifecycle of any Agent Instance"));
        assert!(!prompt.contains("stop work complete"));
        assert!(
            prompt.contains("Editing an Automation never transfers its captured author identity")
        );
        assert!(prompt.contains("`xmatrix request secrets`"));
        assert!(
            prompt.contains(
                "`xmatrix secret exec [--secret <alias>[=<ENV_NAME>]] -- <cmd> [args...]`"
            )
        );
        assert!(prompt.contains(
            "`xmatrix request secret-add <secretRef> [--env <ENV_NAME>] --reason \"<why>\""
        ));
        assert!(prompt.contains("never ask the human to paste it into chat"));
        assert!(prompt.contains("messageId=<id>"));
        assert!(prompt.contains("replied to your message"));
        assert!(prompt.contains("xMatrix channel contract"));
        assert!(prompt.contains("Channel-visible replies are explicit"));
        assert!(prompt.contains("when you have something for someone"));
        assert!(prompt.contains("promptly send one short channel update"));
        assert!(prompt.contains("edit that same status message"));
        assert!(!prompt.contains("Do not narrate progress"));
        assert!(prompt.contains("plan or todo tool"));
        assert!(!prompt.contains("MUST first send a short channel update"));
        assert!(prompt.contains("--stdin"));
        assert!(prompt.contains("$OutputEncoding"));
        assert!(prompt.contains("plain `cd ...` as a failed workflow"));
        assert!(prompt.contains("(no reply)"));
        for retired in ["xmatrix request run", "--with-secret", "approval card"] {
            assert!(!prompt.contains(retired), "{retired} is retired");
        }
        assert!(prompt.contains("On Windows PowerShell 5.1"));
        assert!(prompt.contains("one complete argv"));
        assert!(prompt.contains("--reply-to <messageId>"));
        assert!(prompt.contains("only a reply carries your answer back"));
        assert!(prompt.contains("`xmatrix --help`"));
        for retired in [
            "channel thread",
            "xmatrix memory",
            "--parent",
            "channel delete ",
        ] {
            assert!(!prompt.contains(retired), "{retired} is retired");
        }
        assert!(prompt.contains("`xmatrix channel edit-message <channel-id> <messageId>"));
        assert!(prompt.contains("`xmatrix channel delete-message <channel-id> <messageId>"));
        assert!(prompt.contains("`xmatrix channel react <channel-id> <messageId> <emoji>`"));
        assert!(
            prompt.contains("works by default wherever both this Run and its owner have access")
        );
        assert!(prompt.contains("Kept for humans: approving cross-Space reads"));
        assert!(prompt.contains("use your own judgment"));
        assert!(prompt.contains("The page tree is the work index"));
        assert!(prompt.contains("It is not the work index"));
        assert!(!prompt.contains("see workspace channels"));
    }

    #[test]
    fn working_mode_defaults_to_autonomous_and_follows_the_env() {
        // SAFETY: test-only env mutation, as in the other bootstrap tests.
        unsafe { std::env::remove_var(WorkingMode::ENV) };
        let prompt = bootstrap_prompt("claude", "a", "", true).unwrap();
        assert!(prompt.ends_with(WORKING_MODE_AUTONOMOUS));
        assert!(prompt.contains("standing authorization to carry work through to its end"));
        assert!(prompt.contains("is not finished"));
        assert!(!prompt.contains("Working mode: cautious"));

        assert_eq!(WorkingMode::parse("cautious"), Ok(WorkingMode::Cautious));
        assert!(
            WorkingMode::Cautious
                .prompt()
                .contains("merging and releasing need a human's explicit approval")
        );
        let error = WorkingMode::parse("yolo").unwrap_err();
        assert!(error.contains(WorkingMode::ENV) && error.contains("yolo"));
    }

    #[test]
    fn render_prompt_fills_slots_once_and_drops_empty_slot_lines() {
        let rendered = render_prompt(
            "a {x}\n{empty}\n{y}\nkeep {\"json\": 1} {unknown}\n",
            &[("x", "{y}"), ("empty", ""), ("y", "line\n")],
        );
        assert_eq!(rendered, "a {y}\nline\nkeep {\"json\": 1} {unknown}\n");
    }

    #[test]
    fn channel_collaboration_policy_is_complete_and_targets_the_channel() {
        let policy = channel_collaboration_policy("channel-123");

        assert!(policy.contains("xmatrix send channel-123"));
        assert!(policy.contains("before ending the turn"));
        // Talk is for people; progress is recorded from the runtime's own plan
        // (docs/design/conversation-activity.md §5).
        for spoken in [
            "a question",
            "a decision you need",
            "a finding",
            "a blocker",
            "a result",
            "always your final answer",
        ] {
            assert!(policy.contains(spoken), "{spoken}");
        }
        assert!(policy.contains("promptly send one short channel update"));
        assert!(policy.contains("edit that same status message"));
        assert!(policy.contains("Follow the user\'s reporting preferences"));
        assert!(!policy.contains("Do not narrate progress"));
        assert!(policy.contains("plan or todo tool"));
        assert!(policy.contains("without waking anyone"));
        assert!(policy.contains("Do not end a turn on a promise"));
        assert!(policy.contains("merge conflicts runs no CI"));
        for retired in [
            "MUST first send a short channel update",
            "all channel progress must be sent",
            "before meaningful edits or risky commands",
        ] {
            assert!(!policy.contains(retired), "{retired} is retired");
        }
        assert!(policy.contains("channel-123 --stdin"));
        assert!(policy.contains("$OutputEncoding"));
        assert!(policy.contains("plain `cd ...` as a failed workflow"));
        assert!(policy.contains("(no reply)"));
    }
}
