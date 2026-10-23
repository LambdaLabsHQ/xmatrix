/// Child CLI commands inherit only a Run's broker capabilities and routing.
/// Reading/creating the Human registry here both violates isolation and fails
/// under Seatbelt. The wrapper/daemon still use normal registry admission.
fn admit_agent_cli_hub(cli: &Cli) -> error::Result<String> {
    let inherited = std::env::var("XMATRIX_HUB_URL").ok();
    let pinned = std::env::var("XMATRIX_RUN_PROFILE_ID").ok();
    let hub = validate_agent_cli_target(
        inherited.as_deref(),
        pinned.as_deref(),
        cli.profile.as_deref(),
        cli.hub_url.as_deref(),
    )?;
    config::install_agent_cli_hub(hub.clone())?;
    Ok(hub)
}

fn validate_agent_cli_target(
    inherited_hub: Option<&str>,
    pinned_profile: Option<&str>,
    selected_profile: Option<&str>,
    hub_override: Option<&str>,
) -> error::Result<String> {
    let inherited = inherited_hub
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            CliError::Auth("Agent command is missing its inherited Hub binding".into())
        })?;
    let hub = resolve_target_hub(inherited)?;
    if let Some(pinned) = pinned_profile {
        xmatrix_cli_core::profile::ProfileId::parse(pinned)?;
    }
    if selected_profile.is_some() && selected_profile != pinned_profile {
        return Err(CliError::Auth(
            "Agent command cannot select another installation profile".into(),
        ));
    }
    if let Some(url) = hub_override
        && resolve_target_hub(url)? != hub
    {
        return Err(CliError::Auth(
            "Agent command cannot override its inherited Hub".into(),
        ));
    }
    Ok(hub)
}

#[cfg(test)]
mod agent_cli_admission_tests {
    use super::*;
    const PROFILE: &str = "profile:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    const CUSTOM_HUB: &str = "https://hub.example";

    #[test]
    fn run_routing_cannot_select_a_sibling_profile_or_hub() {
        assert_eq!(
            validate_agent_cli_target(Some(CUSTOM_HUB), Some(PROFILE), Some(PROFILE), None)
                .unwrap(),
            CUSTOM_HUB
        );
        assert_eq!(
            validate_agent_cli_target(Some(CUSTOM_HUB), Some(PROFILE), None, Some(CUSTOM_HUB))
                .unwrap(),
            CUSTOM_HUB
        );
        assert!(
            validate_agent_cli_target(
                Some(CUSTOM_HUB),
                Some(PROFILE),
                Some("profile:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
                None
            )
            .is_err()
        );
        assert!(
            validate_agent_cli_target(Some(CUSTOM_HUB), Some(PROFILE), None, Some(DEFAULT_HUB_URL))
                .is_err()
        );
    }

    #[test]
    fn run_routing_has_no_ambient_profile_or_hub_fallback() {
        for hub in [
            None,
            Some(""),
            Some("https://hub.invalid/path"),
            Some("https://secret@hub.invalid"),
        ] {
            assert!(validate_agent_cli_target(hub, Some(PROFILE), None, None).is_err());
        }
        assert!(
            validate_agent_cli_target(Some(DEFAULT_HUB_URL), Some("bad-profile"), None, None)
                .is_err()
        );
        assert!(
            validate_agent_cli_target(Some(DEFAULT_HUB_URL), None, Some(PROFILE), None).is_err()
        );
        assert_eq!(
            validate_agent_cli_target(Some(DEFAULT_HUB_URL), None, None, None).unwrap(),
            DEFAULT_HUB_URL
        );
    }
}
