// --- repository checkouts a running Agent asks for (`xmatrix repo checkout`) ---
//
// A Run summoned without `repo:` starts in its xMatrix-managed working
// directory and decides itself when its work needs a repository, and which.
// It then asks its daemon for a checkout: a slot of the same repo-key pool a
// `repo:` launch leases, bound to the Run's session (repo_pool_checkout.rs).
// The fetch is authorized by the Space's GitHub connection exactly like a
// `repo:` launch's: a repository the Space cannot mint for is refused.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonRepoCheckoutPayload {
    repository: String,
}

/// One checkout at a time on this machine: two requests of one session for
/// one repository must not both find it unbound and lease twice.
fn repo_checkout_gate() -> &'static AsyncMutex<()> {
    static GATE: std::sync::OnceLock<AsyncMutex<()>> = std::sync::OnceLock::new();
    GATE.get_or_init(|| AsyncMutex::new(()))
}

async fn serve_repo_checkout(
    broker: &DaemonRequestBroker,
    context: &DaemonRequestAgentContext,
    payload: DaemonRepoCheckoutPayload,
) -> error::Result<String> {
    let (Some(run_id), Some(execution_key)) =
        (context.run_id.as_deref(), context.execution_key.as_deref())
    else {
        return Err(CliError::Launch(
            "only an Agent Run started by this machine's daemon can check out a repository".into(),
        ));
    };
    let (instance_id, session_key) = broker
        .run_registry
        .lock()
        .await
        .values()
        .find(|child| {
            child.run_id.as_deref() == Some(run_id)
                && child.execution_key.as_deref() == Some(execution_key)
        })
        .and_then(|child| Some((child.instance_id.clone()?, child.resume_session_key.clone()?)))
        .ok_or_else(|| {
            CliError::Launch("this Run has no resumable session on this machine to bind a checkout to".into())
        })?;
    let repository = payload.repository.trim();
    let canonical = repo_pool::canonical_repo_identity(repository).map_err(|error| {
        CliError::Launch(format!("{repository} is not a repository reference ({error}); write owner/repo"))
    })?;
    let pools_root = repo_pool::default_repo_pools_root()
        .map_err(|error| CliError::Launch(format!("repo pool root unavailable ({error})")))?;
    let layout = repo_pool::RepoPoolLayout::for_session(
        &pools_root,
        repo_pool::repo_key_id(&canonical),
        &[session_key.as_str()],
    )
    .map_err(|error| CliError::Launch(format!("repo pool layout unavailable ({error})")))?;
    // The same grant a `repo:` launch's fetch uses: the Space's connector, or
    // for a repository that is not on GitHub, the machine's own Git login.
    let scoped_capability = match (
        broker.git_credentials.as_ref(),
        broker.relay.as_ref(),
        broker.hub_url.as_deref(),
        github_repository_of_pool_identity(canonical.as_str()),
    ) {
        (Some(grants), Some(relay), Some(hub_url), Some(github)) => {
            let grant = DaemonGitCredentialGrantState {
                channel_id: context.channel_id.clone(),
                run_id: run_id.to_string(),
                execution_key: execution_key.to_string(),
                repository: github.clone(),
            };
            mint_repository_token(hub_url, relay, &grant).await.map_err(|error| {
                CliError::Launch(format!(
                    "this Space's GitHub connector could not authorize {github} ({error})"
                ))
            })?;
            issue_git_credential_grant(grants, grant)
        }
        _ => None,
    };
    let request = repo_pool::LeaseRequest {
        session_key,
        instance_id,
        run_id: run_id.to_string(),
        execution_key: execution_key.to_string(),
    };
    let _gate = repo_checkout_gate().lock().await;
    let checkout = git_credential::with_scoped_capability(scoped_capability, async {
        let base_repo = run_worktree::prepare_repo_pool_base(repository)
            .await
            .map_err(|error| CliError::Launch(format!("{repository} could not be fetched ({error})")))?;
        repo_pool::checkout_for_session_at(&layout, &base_repo, canonical.as_str(), &request)
            .await
            .map_err(|error| CliError::Launch(format!("{repository} could not be checked out ({error})")))
    })
    .await?;
    append_daemon_registry_audit(&format!(
        "repo_checkout run={run_id} repo={} slot={} outcome={}",
        canonical.as_str(),
        checkout.slot_id.as_str(),
        checkout.outcome.label()
    ));
    Ok(serde_json::json!({
        "repository": repository,
        "path": checkout.worktree_path.display().to_string(),
        "outcome": checkout.outcome.label(),
    })
    .to_string())
}

/// What happens to the checkouts a Run asked for when it ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RunCheckoutsSettle {
    /// The Run ended or was stopped: its checkouts wait for its session's next Run.
    Retain,
    /// The Instance is gone: every checkout its session holds is returned.
    Abandon,
}

/// Settle the checkouts beyond the launch slot (`launch_slot`) that this Run
/// (or, on abandon, its session) holds. The launch slot keeps its own typed
/// path. Returns how many were settled; the first failure is returned after
/// the rest were tried.
async fn settle_run_checkouts(
    run_id: Option<&str>,
    session_key: Option<&str>,
    launch_slot: Option<&str>,
    settle: RunCheckoutsSettle,
) -> error::Result<usize> {
    let Ok(pools_root) = repo_pool::default_repo_pools_root() else {
        return Ok(0);
    };
    let held = repo_pool::bindings_where_at(&pools_root, |authority| {
        Some(authority.slot_id.as_str()) != launch_slot
            && match settle {
                RunCheckoutsSettle::Retain => Some(authority.run_id.as_str()) == run_id,
                RunCheckoutsSettle::Abandon => {
                    Some(authority.session_key.as_str()) == session_key
                        || Some(authority.run_id.as_str()) == run_id
                }
            }
    })
    .await;
    let mut first_error = None;
    let count = held.len();
    for (layout, authority) in held {
        // Its Run has stopped by now, so a Leased checkout is retained first:
        // a return consumes only a retained binding (the stop evidence).
        let retained = repo_pool::retain_exited_at(&layout, &repo_pool::LeaseRequest {
            session_key: authority.session_key.clone(),
            instance_id: authority.instance_id.clone(),
            run_id: authority.run_id.clone(),
            execution_key: authority.execution_key.clone(),
        })
        .await
        .map(|_| ());
        let result = match (settle, retained) {
            (RunCheckoutsSettle::Abandon, Ok(())) => {
                repo_pool::return_retained_authority_without_base_at(&layout, &authority).await
            }
            (_, retained) => retained,
        };
        if let Err(error) = result {
            append_daemon_registry_audit(&format!(
                "repo_checkout_settle_failed slot={} settle={settle:?} error={error}",
                authority.slot_id
            ));
            first_error.get_or_insert(error);
        }
    }
    match first_error {
        Some(error) => Err(CliError::Launch(format!("repo checkout could not be settled ({error})"))),
        None => Ok(count),
    }
}
