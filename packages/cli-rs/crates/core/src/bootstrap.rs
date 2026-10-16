use crate::bootstrap_prompts::BootstrapPrompts;
use crate::config::non_empty_env as trimmed_env;
use crate::protocol::DEFAULT_HUB_URL;

/// The shared xMatrix channel contract for every runtime.
///
/// Keep this as the sole source for rules that affect what an agent reports
/// through a channel. Runtime adapters may deliver it through different native
/// mechanisms, but must not add, remove, or weaken behavioral instructions.
pub fn channel_collaboration_policy(channel_id: &str) -> String {
    render_prompt(
        &BootstrapPrompts::from_env().channel_contract,
        &[("channel_id", channel_id)],
    )
}

/// A short trusted reminder for runtimes that need an explicit native reply
/// instruction on each turn. The complete contract is delivered at launch.
pub fn channel_turn_policy(channel_id: &str) -> String {
    render_prompt(
        &BootstrapPrompts::from_env().channel_turn,
        &[("channel_id", channel_id)],
    )
}

/// The Space's rules page, set by the daemon from the Hub's launch data.
pub const SPACE_RULES_PAGE_ENV: &str = "XMATRIX_SPACE_RULES_PAGE_ID";

/// The Space's connected apps, one name per line, set by the daemon from the
/// Hub's launch data.
pub const CONNECTED_APPS_ENV: &str = "XMATRIX_CONNECTED_APPS";

/// An app name sits in the prompt as written: one short line of text.
pub fn is_app_name(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 80 && !value.chars().any(char::is_control)
}

fn connected_apps_context(template: &str) -> String {
    let Some(apps) = trimmed_env(CONNECTED_APPS_ENV) else {
        return String::new();
    };
    let names: Vec<&str> = apps
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect();
    if let Some(name) = names.iter().find(|name| !is_app_name(name)) {
        panic!("{CONNECTED_APPS_ENV} names `{name}`, which is not a short single-line name");
    }
    render_prompt(template, &[("apps", &names.join(", "))])
}

/// A page id is opaque: letters, digits and dashes only, so it can sit in
/// the prompt and in the `xmatrix page read` command it names.
pub fn is_opaque_page_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn space_rules_context(template: &str) -> String {
    match trimmed_env(SPACE_RULES_PAGE_ENV) {
        Some(page_id) if is_opaque_page_id(&page_id) => {
            render_prompt(template, &[("page_id", &page_id)])
        }
        Some(page_id) => panic!("{SPACE_RULES_PAGE_ENV} is not an opaque page id: `{page_id}`"),
        None => String::new(),
    }
}

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

    fn prompt(self, prompts: &BootstrapPrompts) -> &str {
        match self {
            Self::Autonomous => &prompts.working_mode_autonomous,
            Self::Cautious => &prompts.working_mode_cautious,
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

    let prompts = BootstrapPrompts::from_env();
    let identity_context = agent_identity_context();
    let channel_id =
        trimmed_env("XMATRIX_AUTO_JOIN_CHANNEL_ID").unwrap_or_else(|| "<channel-id>".into());
    let channel_policy = render_prompt(&prompts.channel_contract, &[("channel_id", &channel_id)]);

    Some(render_prompt(
        &prompts.bootstrap,
        &[
            ("agent_name", agent_name),
            ("launcher", launcher),
            ("hub_url", normalize_hub_url(hub_url)),
            ("identity_context", &identity_context),
            (
                "goal_context",
                goal_command_context(supports_self_goal, &prompts),
            ),
            ("channel_collaboration_policy", &channel_policy),
            ("space_rules", &space_rules_context(&prompts.space_rules)),
            (
                "connected_apps",
                &connected_apps_context(&prompts.connected_apps),
            ),
            ("working_mode", WorkingMode::from_env().prompt(&prompts)),
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

fn goal_command_context(supports_self_goal: bool, prompts: &BootstrapPrompts) -> &str {
    if !supports_self_goal {
        return "";
    }
    &prompts.goal_command
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
    static LAUNCH_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    // Every bootstrap test owns and restores launch state, including when an
    // assertion fails. Templates and their rendered output are protocol bytes.
    struct LaunchEnv(Vec<(&'static str, Option<std::ffi::OsString>)>);
    impl LaunchEnv {
        fn clean() -> Self {
            let keys = [
                crate::bootstrap_prompts::ENV,
                CONNECTED_APPS_ENV,
                SPACE_RULES_PAGE_ENV,
                WorkingMode::ENV,
                "XMATRIX_BOOTSTRAP_PROMPT",
                "XMATRIX_DISABLE_BOOTSTRAP_PROMPT",
                "XMATRIX_AGENT_ROLE_INITIAL_PROMPT",
                "XMATRIX_AGENT_PROFILE_IDENTITY",
                "XMATRIX_AUTO_JOIN_CHANNEL_ID",
            ];
            let saved = keys
                .into_iter()
                .map(|key| (key, std::env::var_os(key)))
                .collect();
            // SAFETY: all bootstrap tests serialize process env access.
            for key in keys {
                unsafe { std::env::remove_var(key) };
            }
            Self(saved)
        }
        fn set(&self, key: &str, value: &str) {
            unsafe { std::env::set_var(key, value) };
        }
    }
    impl Drop for LaunchEnv {
        fn drop(&mut self) {
            for (key, value) in &self.0 {
                unsafe {
                    match value {
                        Some(value) => std::env::set_var(key, value),
                        None => std::env::remove_var(key),
                    }
                }
            }
        }
    }

    #[test]
    fn standalone_and_old_hub_launches_keep_the_compact_contract() {
        let _lock = LAUNCH_ENV.lock().unwrap();
        let _env = LaunchEnv::clean();
        let prompt = bootstrap_prompt("node", "demo", "", true).unwrap();
        assert!(prompt.contains("Agent name: demo"));
        assert!(prompt.contains("Launched via: node"));
        assert!(prompt.contains(DEFAULT_HUB_URL));
        assert!(prompt.contains("xmatrix <command> --help"));
        assert!(prompt.contains("xMatrix channel contract:"));
        assert!(prompt.contains("xmatrix send <channel-id>"));
        assert!(prompt.contains("Working mode: autonomous"));
        assert!(prompt.contains("xmatrix goal --help"));
        assert!(
            !bootstrap_prompt("node", "demo", "", false)
                .unwrap()
                .contains("xmatrix goal --help")
        );
        // Launch token budget: keep the full command reference out of context.
        assert!(
            prompt.len() < 9_000,
            "launch prompt has {} bytes",
            prompt.len()
        );
    }

    #[test]
    fn hub_templates_replace_compiled_text_and_render_values_once() {
        let _lock = LAUNCH_ENV.lock().unwrap();
        let env = LaunchEnv::clean();
        env.set("XMATRIX_AUTO_JOIN_CHANNEL_ID", "channel-1");
        env.set(CONNECTED_APPS_ENV, "Gmail\nSentry");
        env.set(SPACE_RULES_PAGE_ENV, "page-1");
        env.set(WorkingMode::ENV, "cautious");
        let mut templates = BootstrapPrompts {
            bootstrap: "Hub alpha {agent_name}\n{connected_apps}\n{space_rules}\n{working_mode}\n{channel_collaboration_policy}\n".into(),
            ..BootstrapPrompts::default()
        };
        env.set(
            crate::bootstrap_prompts::ENV,
            &serde_json::to_string(&templates).unwrap(),
        );
        let prompt = bootstrap_prompt("node", "{working_mode}", "", false).unwrap();
        assert!(prompt.starts_with("Hub alpha {working_mode}"));
        assert!(prompt.contains("Apps connected to this Space: Gmail, Sentry"));
        assert!(prompt.contains("xmatrix connector list"));
        assert!(prompt.contains("xmatrix page read page-1"));
        assert!(prompt.contains("Working mode: cautious"));
        assert!(prompt.contains("xmatrix send channel-1"));
        assert!(!prompt.contains("Working mode: autonomous"));
        templates.bootstrap = "Hub beta {agent_name}".into();
        env.set(
            crate::bootstrap_prompts::ENV,
            &serde_json::to_string(&templates).unwrap(),
        );
        assert_eq!(
            bootstrap_prompt("node", "demo", "", false).unwrap(),
            "Hub beta demo"
        );
        assert!(channel_turn_policy("channel-1").contains("xmatrix send channel-1"));
        assert!(channel_turn_policy("channel-1").len() < 400);
    }

    #[test]
    fn malformed_supplied_templates_never_become_a_compatibility_fallback() {
        let mut templates = BootstrapPrompts::default();
        templates.validate().unwrap();
        templates.schema_version = 2;
        assert!(templates.validate().is_err());
        templates.schema_version = 1;
        templates.bootstrap.clear();
        assert!(templates.validate().is_err());
        templates.bootstrap = "bad\0text".into();
        assert!(templates.validate().is_err());
        templates.bootstrap = "x".repeat(32 * 1024);
        assert!(templates.validate().is_err());
        for bad in ["", "{}", "null", r#"{"schemaVersion":1}"#] {
            assert!(BootstrapPrompts::from_json(bad).is_err());
        }
    }

    #[test]
    fn render_prompt_fills_slots_once_and_drops_empty_slot_lines() {
        assert_eq!(
            render_prompt(
                "a {x}\n{empty}\n{y}\nkeep {\"json\": 1} {unknown}\n",
                &[("x", "{y}"), ("empty", ""), ("y", "line\n")]
            ),
            "a {y}\nline\nkeep {\"json\": 1} {unknown}\n"
        );
    }
}
