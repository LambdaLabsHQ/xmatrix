/// Check a launch against its registration binding before workspace
/// preparation or process effects. Every Run is a Run of a registration; the
/// Hub maintains it and its harness preset, and the machine keeps no
/// installation record of its own.
fn resolve_registration_spawn(
    intent: &DaemonSpawnRequest,
    machine_id: &str,
) -> error::Result<DaemonSpawnRequest> {
    let binding = intent
        .registration
        .as_ref()
        .ok_or_else(|| CliError::Launch("Spawn command carries no registration binding".into()))?;
    binding
        .require_target(
            machine_id,
            &intent.space_id,
            intent.run_id.as_deref(),
            intent.instance_id.as_deref(),
        )
        .map_err(CliError::Launch)?;
    if intent.identity_id.as_deref() != Some(binding.instance_id.as_str()) {
        return Err(CliError::Launch(
            "Registered launch actor must be its exact Instance".into(),
        ));
    }
    if binding.key.owner_user_id != intent.workspace.owner_user_id
        || intent.workspace.machine_id != machine_id
    {
        return Err(CliError::Launch(
            "Registered workspace owner or machine does not match the launch".into(),
        ));
    }
    let workspace_reference = binding.resources.workspaces.first();
    // Only a launch with no registered workspace runs in a managed
    // directory, which the Hub places by its management Space key.
    if intent.management_space_id.is_some() && workspace_reference.is_some() {
        return Err(CliError::Launch(
            "Registered launch contains unadmitted workspace or execution overrides".into(),
        ));
    }
    let managed = intent
        .workspace
        .managed_key
        .as_deref()
        .filter(|key| !key.is_empty());
    match workspace_reference.map(|reference| reference.strip_prefix("repo:")) {
        None => {
            if managed.is_none()
                || intent.management_space_id.is_none()
                || intent.remote_repo.is_some()
                || intent.run_worktree
            {
                return Err(CliError::Launch(
                    "Registered launch without a workspace must use a private managed \
                     directory"
                        .into(),
                ));
            }
        }
        Some(Some(repo)) if !repo.is_empty() => {
            if intent.remote_repo.as_deref() != Some(repo)
                || !intent.run_worktree
                || managed.is_none()
            {
                return Err(CliError::Launch(
                    "Registered repository does not match its admitted workspace reference".into(),
                ));
            }
        }
        _ if intent.remote_repo.is_some()
            || intent.run_worktree
            || intent.workspace.managed_key.is_some() =>
        {
            return Err(CliError::Launch(
                "Registered directory cannot request a repository override".into(),
            ));
        }
        _ => {}
    }
    let harness = intent
        .harness
        .as_ref()
        .filter(|harness| harness.id == binding.key.harness)
        .ok_or_else(|| {
            CliError::Launch("Registered launch is missing the Hub's preset for its harness".into())
        })?;
    let mut resolved = intent.clone();
    if resolved.runtime_args.is_empty() {
        resolved.runtime_args = harness.default_args.clone();
    }
    resolved.agent_backend = resolved
        .agent_backend
        .clone()
        .or_else(|| Some(harness.backend.clone()));
    resolved.agent_preset_id = Some(harness.id.clone());
    // Absence is an intentional runtime-default selection. A supplied
    // override still resolves only to the admitted model binding.
    resolved.requested_model = intent
        .requested_model
        .as_ref()
        .and_then(|_| binding.runtime_model.clone());
    if resolved.requested_model.is_none() {
        resolved.requested_effort = None;
    }
    if resolved.agent_acp_args.is_empty() {
        resolved.agent_acp_args = harness.acp_args.clone().unwrap_or_default();
    }
    Ok(resolved)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DaemonSpawnDelivery {
    Socket,
    HttpFallback,
}

async fn handle_daemon_spawn_request(
    hub_url: &str,
    token_override: Option<&str>,
    session_state: Option<DaemonSessionState>,
    auth_broker: Option<DaemonAuthBroker>,
    request_broker: Option<DaemonRequestBroker>,
    relay: SharedMachineDaemonConnection,
    machine_id: &str,
    host_id: &str,
    intent: &DaemonSpawnRequest,
    initial_agent_token: Option<String>,
    delivery: DaemonSpawnDelivery,
    run_registry: &DaemonRunRegistry,
    failure_repo_pool_binding: &mut Option<DaemonRepoPoolBinding>,
) -> error::Result<SpawnedHeadlessAgent> {
    *failure_repo_pool_binding = None;
    let registered_intent = resolve_registration_spawn(intent, machine_id)?;
    let intent = &registered_intent;
    let registration = intent
        .registration
        .as_ref()
        .expect("a resolved spawn carries its registration");
    let relay_lease = intent.relay_lease.as_ref().ok_or_else(|| {
        CliError::Launch("spawn command is missing its exact command lease".into())
    })?;
    let daemon_epoch = relay_lease.daemon_epoch;
    if !relay.owns_connection_epoch(daemon_epoch) {
        return Err(CliError::Launch(
            "spawn command does not belong to this daemon connection epoch".into(),
        ));
    }
    let mut machine_credential = relay.machine_credential()?;
    let command_lease = DaemonCommandLeaseHeartbeat::start(
        hub_url,
        &machine_credential,
        relay.clone(),
        &intent.request_id,
        relay_lease,
        initial_agent_token.is_some(),
        delivery,
    )
    .await?;

    let mut workspace = intent.workspace.clone();
    let is_management_workspace = daemon_workspace_is_management(workspace.metadata.as_ref());

    if let Some(managed_workspace_key) = intent.management_space_id.as_deref() {
        if intent.run_worktree || intent.remote_repo.is_some() {
            return Err(CliError::Launch(
                "xMatrix-managed workspace runs cannot also request a repo or run worktree".into(),
            ));
        }
        if !workspace_belongs_to_daemon_machine(&workspace, machine_id, host_id) {
            return Err(CliError::Launch(
                "xMatrix-managed workspace run targeted a different machine".into(),
            ));
        }
        let cwd = if is_management_workspace {
            daemon_management_run_workspace_cwd(
                managed_workspace_key,
                intent.run_id.as_deref(),
                intent.execution_key.as_deref(),
            )?
        } else {
            daemon_managed_workspace_cwd(managed_workspace_key)?
        };
        std::fs::create_dir_all(&cwd)?;
        workspace.canonical_cwd = cwd.display().to_string();
        workspace.display_name = if is_management_workspace {
            "xMatrix management".to_string()
        } else {
            "xMatrix managed workspace".to_string()
        };
        workspace.repo_root = None;
        workspace.git_remote = None;
        workspace.git_branch = None;
    } else if intent.remote_repo.is_some() && workspace.managed_key.is_some() {
        // A repo summon without one unambiguous registered checkout carries a
        // synthetic workspace whose relative path is routing metadata, not an
        // already-authorized local directory. Resolve its server-issued,
        // bounded key under the daemon-owned root before remote materialization
        // instead of canonicalizing a path that cannot exist yet.
        if !workspace_belongs_to_daemon_machine(&workspace, machine_id, host_id) {
            return Err(CliError::Launch(
                "xMatrix-managed remote repo run targeted a different machine".into(),
            ));
        }
        let managed_workspace_key = workspace.managed_key.as_deref().ok_or_else(|| {
            CliError::Launch(
                "xMatrix-managed remote repo run is missing its managed workspace key".into(),
            )
        })?;
        workspace.canonical_cwd = daemon_managed_workspace_cwd(managed_workspace_key)?
            .display()
            .to_string();
    } else if initial_agent_token.is_some() {
        validate_daemon_workspace_path_isolated(&workspace)?;
        if !workspace_belongs_to_daemon_machine(&workspace, machine_id, host_id) {
            return Err(CliError::Launch(
                "Admitted workspace targeted a different machine daemon".into(),
            ));
        }
    } else {
        match validate_daemon_workspace_allowed(
            hub_url,
            &machine_credential,
            machine_id,
            host_id,
            &workspace,
        )
        .await
        {
            Ok(()) => {}
            Err(err) if token_override.is_none() && daemon_spawn_needs_remote_login(&err) => {
                eprintln!(
                    "{} daemon session needs browser login before spawning {} in {}",
                    "○".cyan().bold(),
                    intent.runtime,
                    workspace.display_name
                );
                machine_credential = recover_daemon_session_from_channel_login(
                    hub_url,
                    session_state.clone(),
                    relay.clone(),
                    &intent.request_id,
                    intent.run_id.as_deref(),
                    &intent.channel_id,
                    &intent.agent_name,
                    intent.identity_id.as_deref(),
                )
                .await?;
                validate_daemon_workspace_allowed(
                    hub_url,
                    &machine_credential,
                    machine_id,
                    host_id,
                    &workspace,
                )
                .await?;
            }
            Err(err) => return Err(err),
        }
    }

    let auth_context = match (
        intent.identity_id.as_deref(),
        intent.run_id.as_deref(),
        intent.execution_key.as_deref(),
    ) {
        (Some(agent_id), Some(run_id), Some(execution_key)) => Some(DaemonAgentAuthContext {
            agent_id: agent_id.to_string(),
            agent_name: intent.agent_name.clone(),
            space_id: intent.space_id.clone(),
            channel_id: intent.channel_id.clone(),
            run_id: run_id.to_string(),
            execution_key: execution_key.to_string(),
        }),
        _ => None,
    };
    let auth_grant = match (auth_broker.as_ref(), auth_context.clone()) {
        (Some(broker), Some(context)) => {
            // Prove the Hub accepts the exact immutable Run principal before
            // starting any provider process. The signed token stays in the
            // capability-protected loopback broker and serves the child's
            // first Agent Instance registration; later requests reuse it
            // briefly, then mint another short-lived token for the context.
            let initial_token = match initial_agent_token {
                Some(token) => token,
                None => {
                    mint_agent_run_token_with_machine_credential(
                        hub_url,
                        &machine_credential,
                        &context,
                    )
                    .await?
                }
            };
            Some(broker.issue_grant(context, initial_token))
        }
        (Some(_), None) => {
            return Err(CliError::Launch(
                "Agent run is missing immutable auth provenance".into(),
            ));
        }
        (None, Some(_)) => {
            return Err(CliError::Launch(
                "Agent run auth broker is unavailable".into(),
            ));
        }
        (None, None) => None,
    };

    // Select the execution workspace. Eligible interactive explicit-repo Runs
    // unconditionally use the fail-closed repo-key pool. The older run-* path
    // remains only for lifecycle-specific non-pool executors and historical
    // reborn without pool authority; it is never an eligible pool fallback.
    // Generated execution worktrees carry the base workspace id so the child
    // never registers its cwd as a selectable workspace.
    let mut spawn_workspace = workspace.clone();
    let mut run_worktree_env: Option<run_worktree::RunWorktreeSpawnEnv> = None;
    let mut repo_pool_binding: Option<DaemonRepoPoolBinding> = None;
    let mut repo_pool_layout: Option<repo_pool::RepoPoolLayout> = None;
    let mut repo_pool_request: Option<repo_pool::LeaseRequest> = None;
    let mut repo_pool_spawn_claim: Option<DaemonRepoPoolSpawnClaim> = None;
    let remote_repo_checkout_candidates = if intent.remote_repo.is_some() {
        daemon_local_workspace_cwds(
            hub_url,
            &machine_credential,
            machine_id,
            host_id,
            &workspace,
        )
        .await
    } else {
        Vec::new()
    };
    let adopted_intent = adopt_retained_repo_pool_authority(intent).await?;
    let intent = adopted_intent.as_ref().unwrap_or(intent);
    let has_resume_pool_authority = daemon_repo_pool_authority(intent)?;
    let repo_pool_eligible = daemon_repo_pool_spawn_eligible(
        intent.run_worktree,
        intent.remote_repo.is_some(),
        intent.resume,
        has_resume_pool_authority,
    );
    if repo_pool_eligible {
        let remote_repo = intent
            .remote_repo
            .as_deref()
            .expect("repo pool eligibility checked");
        let run_id = intent
            .run_id
            .as_deref()
            .ok_or_else(|| CliError::Launch("repo worktree pool spawn requires runId".into()))?;
        let instance_id = intent.instance_id.as_deref().ok_or_else(|| {
            CliError::Launch("repo worktree pool spawn requires instanceId".into())
        })?;
        let execution_key = intent.execution_key.as_deref().ok_or_else(|| {
            CliError::Launch("repo worktree pool spawn requires executionKey".into())
        })?;
        let session_key = intent.resume_session_key.as_deref().ok_or_else(|| {
            CliError::Launch("repo worktree pool spawn requires resumeSessionKey".into())
        })?;
        let canonical = repo_pool::canonical_repo_identity(remote_repo)
            .map_err(|error| CliError::Launch(format!("invalid repo pool identity ({error})")))?;
        let repo_key = repo_pool::repo_key_id(&canonical);
        if intent.resume
            && (intent.repo_identity.as_deref() != Some(canonical.as_str())
                || intent.repo_key_id.as_deref() != Some(repo_key.as_str()))
        {
            return Err(CliError::Launch(
                "reborn repo pool authority does not match repo identity".into(),
            ));
        }
        reclaim_worktree_storage_for_registry(run_registry).await;
        let pools_root = repo_pool::default_repo_pools_root()
            .map_err(|error| CliError::Launch(format!("repo pool root unavailable ({error})")))?;
        let layout = repo_pool::RepoPoolLayout::create(&pools_root, repo_key.clone())
            .map_err(|error| CliError::Launch(format!("repo pool layout unavailable ({error})")))?;
        // The child later receives a Space-scoped GitHub token. Issue that
        // grant now so the required origin fetch can use it; otherwise the
        // daemon fetch runs with GIT_TERMINAL_PROMPT=0 and whatever the host
        // happens to have, which is how Workstation :new leases fail closed
        // after `gh repo view` already succeeded.
        let git_capability = git_credential_grant_for_repo(
            auth_grant.as_ref(),
            canonical.as_str(),
            &intent.channel_id,
            Some(run_id),
            Some(execution_key),
        );
        let scoped_git_capability = match (
            git_capability.as_deref(),
            github_repository_of_pool_identity(canonical.as_str()),
        ) {
            (Some(_), Some(repository)) => {
                // A repo launch is authorized by the Space this Channel belongs
                // to, and that authorization is the Space's GitHub token. Falling
                // back to the host's own Git login here would let a run reach a
                // repository its Space was never granted, which is exactly the
                // boundary the per-repository mint exists to draw — so a mint
                // that fails ends the launch instead of widening it.
                mint_repository_token(
                    hub_url,
                    &relay,
                    &DaemonGitCredentialGrantState {
                        channel_id: intent.channel_id.clone(),
                        run_id: run_id.to_string(),
                        execution_key: execution_key.to_string(),
                        repository: repository.clone(),
                    },
                )
                .await
                .map_err(|error| {
                    CliError::Launch(format!(
                        "this Space's GitHub connector could not authorize {repository} ({error})"
                    ))
                })?;
                git_capability
            }
            _ => None,
        };
        // Base discovery has its own managed-checkout coordination. It must not
        // hold the manifest lock while doing remote access or cloning: an
        // unrelated slot launch for the same repo must remain independently
        // startable.
        let rehydrated = std::sync::atomic::AtomicBool::new(false);
        let spare_git_capability = scoped_git_capability.clone();
        let (base_repo, lease) =
            git_credential::with_scoped_capability(scoped_git_capability, async {
                let base_repo = run_worktree::prepare_repo_pool_base(remote_repo)
                    .await
                    .map_err(|error| {
                        CliError::Launch(format!("repo pool base unavailable ({error})"))
                    })?;
                let request = repo_pool::LeaseRequest {
                    session_key: session_key.to_string(),
                    instance_id: instance_id.to_string(),
                    run_id: run_id.to_string(),
                    execution_key: execution_key.to_string(),
                };
                if !intent.resume
                    && let Some(existing_slot) =
                        repo_pool::exact_bound_slot_for_request_at(&layout, &request)
                            .await
                            .map_err(|error| {
                                CliError::Launch(format!(
                                    "repo pool replay authority unavailable ({error})"
                                ))
                            })?
                {
                    // A previous daemon may have crashed after pre-spawn admission but
                    // before registry/ack persistence. Preserve the exact typed abandon
                    // route even if just-in-time sidecar recovery raced the first child
                    // heartbeat.
                    *failure_repo_pool_binding = Some(DaemonRepoPoolBinding {
                        canonical_repo_identity: canonical.as_str().to_string(),
                        repo_key_id: repo_key.as_str().to_string(),
                        slot_id: existing_slot.as_str().to_string(),
                        base_repo: base_repo.clone(),
                        resumed: false,
                    });
                }
                let lease = if intent.handoff_transfer {
                    let source_session = intent
                        .handoff_source_resume_session_key
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| {
                            CliError::Launch(
                                "handoff transfer is missing the predecessor resume session key"
                                    .into(),
                            )
                        })?;
                    let retained =
                        repo_pool::retained_binding_for_session_at(&layout, source_session)
                            .await
                            .map_err(|error| {
                                CliError::Launch(format!(
                                    "handoff retained repo pool binding unavailable ({error})"
                                ))
                            })?;
                    if retained.canonical_repo_identity != canonical.as_str()
                        || intent.handoff_source_instance_id.as_deref()
                            != Some(retained.authority.instance_id.as_str())
                        || intent.slot_id.as_deref() != Some(retained.authority.slot_id.as_str())
                    {
                        return Err(CliError::Launch(
                            "handoff repo pool authority does not match its retained binding"
                                .into(),
                        ));
                    }
                    repo_pool::transfer_retained_lease_at(
                        &layout,
                        &base_repo,
                        &retained.authority,
                        &request,
                    )
                    .await
                } else if intent.resume {
                    // A checkout removed behind the pool's back is recorded like a
                    // reclaimed one, so the rehydrate below recreates it in place.
                    repo_pool::record_lost_retained_checkout_at(&layout, &base_repo, session_key)
                        .await
                        .map_err(|error| {
                            CliError::Launch(format!(
                                "retained repo pool checkout could not be recovered ({error})"
                            ))
                        })?;
                    match repo_pool::retained_binding_for_session_at(&layout, session_key).await {
                        Ok(retained) => {
                            if retained.canonical_repo_identity != canonical.as_str()
                                || intent.resume_instance_id.as_deref()
                                    != Some(retained.authority.instance_id.as_str())
                                || intent.slot_id.as_deref()
                                    != Some(retained.authority.slot_id.as_str())
                            {
                                return Err(CliError::Launch(
                                    "reborn repo pool authority does not match its retained binding"
                                        .into(),
                                ));
                            }
                            repo_pool::rebind_retained_lease_at(
                                &layout,
                                &base_repo,
                                &retained.authority,
                                &request,
                            )
                            .await
                        }
                        // The sweep reclaimed the resting session's slot, or its tree
                        // was lost: recreate its checkout at the same path
                        // (docs/instance-sleep.md §6).
                        Err(retained_error) => {
                            let record =
                                repo_pool::rehydrate_record_for_session_at(&layout, session_key)
                                    .await
                                    .map_err(|error| {
                                        CliError::Launch(format!(
                                            "retained repo pool binding unavailable ({retained_error}; {error})"
                                        ))
                                    })?
                                    .filter(|record| {
                                        intent.resume_instance_id.as_deref()
                                            == Some(record.instance_id.as_str())
                                            && intent.slot_id.as_deref()
                                                == Some(record.slot_id.as_str())
                                    })
                                    .ok_or_else(|| {
                                        CliError::Launch(format!(
                                            "retained repo pool binding unavailable ({retained_error})"
                                        ))
                                    })?;
                            rehydrated.store(true, std::sync::atomic::Ordering::Relaxed);
                            repo_pool::rehydrate_retained_lease_at(
                                &layout, &base_repo, &record, &request,
                            )
                            .await
                        }
                    }
                } else {
                    repo_pool::lease_available_or_create_at(
                        &layout,
                        &base_repo,
                        canonical.as_str(),
                        &request,
                    )
                    .await
                }
                .map_err(|error| {
                    CliError::Launch(format!("repo pool lease unavailable ({error})"))
                })?;
                Ok::<_, CliError>((base_repo, lease))
            })
            .await?;
        let request = repo_pool::LeaseRequest {
            session_key: session_key.to_string(),
            instance_id: instance_id.to_string(),
            run_id: run_id.to_string(),
            execution_key: execution_key.to_string(),
        };
        eprintln!(
            "{} repo pool slot {} ({} from {})",
            "✓".green().bold(),
            lease.worktree_path.display(),
            if intent.handoff_transfer {
                "handoff"
            } else if rehydrated.load(std::sync::atomic::Ordering::Relaxed) {
                "rehydrated"
            } else if intent.resume {
                "reborn"
            } else if lease.reused_available {
                "reused"
            } else {
                "created"
            },
            lease.base_ref
        );
        if !intent.resume && !intent.handoff_transfer {
            // This lease may have taken the pool's spare; check out the next
            // one now so the next new session skips the full checkout. Its
            // fetch uses this launch's Space grant, never the machine's login.
            let (layout, base_repo, canonical) = (
                layout.clone(),
                base_repo.clone(),
                canonical.as_str().to_string(),
            );
            tokio::spawn(git_credential::with_scoped_capability(
                spare_git_capability,
                async move {
                    if let Err(error) =
                        repo_pool::ensure_warm_spare_at(&layout, &base_repo, &canonical).await
                    {
                        eprintln!("repo pool: warm spare not built ({error})");
                    }
                },
            ));
        }
        spawn_workspace.canonical_cwd = lease.worktree_path.display().to_string();
        run_worktree_env = Some(run_worktree::RunWorktreeSpawnEnv {
            base_machine_id: workspace.machine_id.clone(),
            base_canonical_cwd: workspace.canonical_cwd.clone(),
            base_ref: lease.base_ref,
        });
        repo_pool_binding = Some(DaemonRepoPoolBinding {
            canonical_repo_identity: canonical.as_str().to_string(),
            repo_key_id: repo_key.as_str().to_string(),
            slot_id: lease.slot_id.as_str().to_string(),
            base_repo,
            resumed: intent.resume,
        });
        repo_pool_spawn_claim = Some(DaemonRepoPoolSpawnClaim {
            canonical_repo_identity: canonical.as_str().to_string(),
            repo_key_id: repo_key.as_str().to_string(),
            slot_id: lease.slot_id.as_str().to_string(),
            session_key: request.session_key.clone(),
            instance_id: request.instance_id.clone(),
            run_id: request.run_id.clone(),
            execution_key: request.execution_key.clone(),
            spawn_claim_token: lease.spawn_claim_token,
        });
        // From this point onward every failure acknowledgement must retain the
        // exact pool authority. Provider startup or its compensating Git
        // transition can fail after the binding is already durable; losing the
        // authority would make a typed owner abandon impossible. A successful
        // rollback is still safe to report because its exact completed-return
        // receipt makes the later abandon idempotent.
        *failure_repo_pool_binding = repo_pool_binding.clone();
        repo_pool_layout = Some(layout);
        repo_pool_request = Some(request);
    }
    if !repo_pool_eligible && run_worktree::run_worktree_spawn_enabled(intent.run_worktree) {
        // Key the tree by the resume session key when present: it is minted
        // at first spawn and carried through reborn/resume unchanged, so a
        // resumed session lands back in the same tree (run ids churn per
        // spawn). Keyless spawns (e.g. Automations) fall back to run id.
        let worktree_key = intent
            .resume_session_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .or(intent.run_id.as_deref());
        if let Some(worktree_key) = worktree_key {
            let base_cwd = Path::new(&workspace.canonical_cwd);
            let reuse_only = run_worktree::resume_reuse_only(
                worktree_key,
                intent.resume,
                intent.resume_worktree_bootstrap,
            )
            .map_err(|error| {
                CliError::Launch(format!(
                    "cannot determine durable worktree binding ({error})"
                ))
            })?;
            if !reuse_only {
                reclaim_worktree_storage_for_registry(run_registry).await;
            }
            let materialized = if let Some(remote_repo) = intent.remote_repo.as_deref() {
                eprintln!(
                    "{} preparing remote repo worktree for {remote_repo} (streaming git fetch progress; stall only if download stops)",
                    "↓".cyan()
                );
                run_worktree::materialize_run_worktree_for_remote_with_candidates(
                    base_cwd,
                    &remote_repo_checkout_candidates,
                    remote_repo,
                    worktree_key,
                    reuse_only,
                )
                .await
            } else {
                run_worktree::materialize_run_worktree(base_cwd, worktree_key, reuse_only).await
            };
            match materialized {
                Ok(worktree) => {
                    eprintln!(
                        "{} run worktree {} ({} from {})",
                        "✓".green().bold(),
                        worktree.path.display(),
                        if worktree.reused { "reused" } else { "created" },
                        worktree.base_ref
                    );
                    spawn_workspace.canonical_cwd = worktree.path.display().to_string();
                    run_worktree_env = Some(run_worktree::RunWorktreeSpawnEnv {
                        base_machine_id: workspace.machine_id.clone(),
                        base_canonical_cwd: workspace.canonical_cwd.clone(),
                        base_ref: worktree.base_ref,
                    });
                }
                Err(err) => {
                    if intent.remote_repo.is_some() {
                        return Err(CliError::Launch(format!(
                            "remote repo worktree unavailable ({err}). If this mentions 'stalled', git made no download progress; if it mentions 'max fetch time', the transfer was still active but too slow overall."
                        )));
                    }
                    eprintln!(
                        "{} run worktree unavailable ({err}); spawning in base workspace {}",
                        "⚠".yellow().bold(),
                        workspace.display_name
                    );
                }
            }
        }
    }

    let spawn_result = if let Err(error) = command_lease.confirm_live(&relay).await {
        Err(error)
    } else if let Err(error) =
        daemon_claude_reborn_cwd_preflight(intent, Path::new(&spawn_workspace.canonical_cwd))
    {
        // Refused before any process starts; a leased pool slot is rolled back
        // to Retained below exactly like any other pre-spawn failure.
        Err(error)
    } else {
        spawn_headless_agent(HeadlessAgentSpawn {
            hub_url,
            registration,
            auth_grant,
            request_broker: request_broker.clone(),
            workspace: &spawn_workspace,
            space_id: &intent.space_id,
            channel_id: &intent.channel_id,
            runtime: &intent.runtime,
            runtime_args: &intent.runtime_args,
            agent_backend: intent.agent_backend.as_deref(),
            agent_preset_id: intent.agent_preset_id.as_deref(),
            agent_acp_args: &intent.agent_acp_args,
            agent_name: &intent.agent_name,
            identity_id: intent.identity_id.as_deref(),
            role_initial_prompt: intent.role_initial_prompt.as_deref(),
            resume: intent.resume,
            resume_instance_id: intent.resume_instance_id.as_deref(),
            resume_session_key: intent.resume_session_key.as_deref(),
            handoff_source_resume_session_key: intent.handoff_source_resume_session_key.as_deref(),
            goal: intent.goal.as_ref(),
            initial_message_source: intent.initial_message_source.as_ref(),
            requested_model: intent.requested_model.as_deref(),
            requested_effort: intent.requested_effort.as_deref(),
            requested_parameters: intent.requested_parameters.as_ref(),
            run_id: intent.run_id.as_deref(),
            launcher_id: intent.launcher_id.as_deref(),
            materializer_id: intent.materializer_id.as_deref(),
            execution_key: intent.execution_key.as_deref(),
            instance_id: intent.instance_id.as_deref(),
            prompt: &intent.prompt,
            source_message_id: intent.source_message_id(),
            attachments: intent.attachments(),
            // Direct daemon routing workspace (registered cwd or management
            // managed dir): hand the child Hub workspace id + display name so
            // cmd_external skips upsert_workspace git probing but still reports
            // workspaceName. Materialized run worktrees already carry base
            // workspace id + base ref via run_worktree_env; do not also pass a
            // routing workspace id or apply_spawn_workspace_env would drop
            // XMATRIX_RUN_WORKTREE_BASE_REF.
            routing_workspace: if run_worktree_env.is_some() {
                None
            } else {
                Some(DaemonRoutingWorkspace {
                    machine_id: workspace.machine_id.as_str(),
                    canonical_cwd: workspace.canonical_cwd.as_str(),
                    display_name: workspace.display_name.as_str(),
                })
            },
            run_worktree_env: run_worktree_env.as_ref(),
            repo_pool_binding: repo_pool_binding.as_ref(),
            repo_pool_spawn_claim: repo_pool_spawn_claim.as_ref(),
            daemon_relay: &relay,
            daemon_epoch,
        })
        .await
    };
    let mut child = match spawn_result {
        Ok(child) => child,
        Err(error) => {
            if let (Some(binding), Some(layout), Some(request)) = (
                repo_pool_binding.as_ref(),
                repo_pool_layout.as_ref(),
                repo_pool_request.as_ref(),
            ) {
                let rollback = if binding.resumed {
                    repo_pool::mark_retained_at(layout, request).await
                } else {
                    repo_pool::return_abandoned_slot_at(layout, &binding.base_repo, request).await
                };
                if let Err(rollback_error) = rollback {
                    return Err(CliError::Launch(format!(
                        "{error}; repo pool spawn rollback failed ({rollback_error})"
                    )));
                }
            }
            return Err(error);
        }
    };
    child.instance_id = intent.instance_id.clone();
    child.resume_session_key = intent.resume_session_key.clone();
    child.repo_pool_binding = repo_pool_binding;
    Ok(child)
}

async fn daemon_local_workspace_cwds(
    hub_url: &str,
    token: &str,
    machine_id: &str,
    _host_id: &str,
    selected_workspace: &protocol::DaemonSpawnWorkspace,
) -> Vec<PathBuf> {
    let mut cwds = Vec::new();
    push_unique_workspace_cwd(&mut cwds, &selected_workspace.canonical_cwd);

    match list_machine_daemon_workspaces(hub_url, token).await {
        Ok(workspaces) => {
            for workspace in workspaces {
                if workspace.machine_id == selected_workspace.machine_id
                    && workspace_cwd_key(Path::new(&workspace.canonical_cwd))
                        == workspace_cwd_key(Path::new(&selected_workspace.canonical_cwd))
                {
                    continue;
                }
                if workspace.owner_user_id != selected_workspace.owner_user_id
                    || workspace.machine_id != machine_id
                {
                    continue;
                }
                push_unique_workspace_cwd(&mut cwds, &workspace.canonical_cwd);
            }
        }
        Err(err) => {
            eprintln!(
                "{} could not list registered workspaces while resolving remote repo checkout: {err}",
                "⚠".yellow().bold()
            );
        }
    }

    cwds
}

fn workspace_belongs_to_daemon_machine(
    workspace: &protocol::DaemonSpawnWorkspace,
    machine_id: &str,
    host_id: &str,
) -> bool {
    let _ = host_id;
    workspace.machine_id == machine_id
}

fn daemon_management_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(config::config_dir)
        .join(".xmatrix-management")
}

/// Remove up to 64 daemon-owned directories under the management root that no
/// registered Run works in. A spawn recreates its directory, so this only
/// reclaims what finished Runs left behind.
async fn remove_idle_management_workspaces(registry: &DaemonRunRegistry) {
    let root = daemon_management_root();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    // Compare leaf names: a Run's recorded cwd may be spelled differently
    // above the management root.
    let in_use: HashSet<std::ffi::OsString> = registry
        .lock()
        .await
        .values()
        .filter_map(|run| {
            run.cwd
                .as_deref()
                .and_then(Path::file_name)
                .map(ToOwned::to_owned)
        })
        .collect();
    let idle = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter(|entry| !in_use.contains(&entry.file_name()))
        .map(|entry| entry.path())
        .take(64);
    for path in idle {
        if let Err(err) = std::fs::remove_dir_all(&path) {
            eprintln!(
                "{} idle management workspace {} could not be removed: {err}",
                "⚠".yellow().bold(),
                path.display()
            );
        }
    }
}

/// Resolve the daemon-owned on-disk directory for one managed workspace key.
/// The digest leaf is required so long Space/Agent keys fit Windows path budgets.
pub(crate) fn daemon_managed_workspace_cwd(key: &str) -> error::Result<PathBuf> {
    let normalized = xmatrix_cli_core::config::normalized_management_workspace_key(key)
        .ok_or_else(|| CliError::Launch("invalid xMatrix managed workspace key".into()))?;
    // The key is a composite of Space, Agent and profile ids and reaches ~88
    // characters, which every path below it pays for against the Windows
    // 260-character budget. Digest it instead. This also sidesteps `:` in
    // historical message:profile keys, which Windows rejects in a path segment
    // (ERROR_INVALID_NAME). 128 bits leave ample headroom while making a
    // collision negligible as machines accumulate workspace keys.
    let dir_name = lowercase_hex(&Sha256::digest(normalized.as_bytes())[..16]);
    Ok(daemon_management_root().join(dir_name))
}

pub(crate) fn daemon_management_run_workspace_cwd(
    space_key: &str,
    run_id: Option<&str>,
    execution_key: Option<&str>,
) -> error::Result<PathBuf> {
    let base = daemon_managed_workspace_cwd(space_key)?;
    let run_id = run_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliError::Launch("management Run is missing its Run id".into()))?;
    let execution_key = execution_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliError::Launch("management Run is missing its execution key".into()))?;
    if run_id.len() > 200 || execution_key.len() > 200 {
        return Err(CliError::Launch(
            "management Run identity exceeds its path-isolation bound".into(),
        ));
    }
    let material = format!("management-run\0{space_key}\0{run_id}\0{execution_key}");
    let dir_name = lowercase_hex(&Sha256::digest(material.as_bytes())[..16]);
    let root = base
        .parent()
        .ok_or_else(|| CliError::Launch("management workspace root is unavailable".into()))?;
    Ok(root.join(dir_name))
}

fn daemon_workspace_is_management(metadata: Option<&Value>) -> bool {
    metadata
        .and_then(|value| value.get("syntheticManagementWorkspace"))
        .and_then(Value::as_bool)
        == Some(true)
}

fn push_unique_workspace_cwd(cwds: &mut Vec<PathBuf>, cwd: &str) {
    let path = PathBuf::from(cwd);
    let key = workspace_cwd_key(&path);
    if cwds
        .iter()
        .any(|existing| workspace_cwd_key(existing) == key)
    {
        return;
    }
    cwds.push(path);
}

fn workspace_cwd_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        value.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        value
    }
}

async fn record_daemon_spawn_result(
    result: error::Result<SpawnedHeadlessAgent>,
    failure_repo_pool_binding: Option<&DaemonRepoPoolBinding>,
    run_registry: &DaemonRunRegistry,
    identity_id: Option<String>,
    log: Option<DaemonSpawnLog<'_>>,
) -> DaemonSpawnResultParts {
    match result {
        Ok(child) => {
            let pid = child.pid;
            let spawned_at = child.spawned_at.clone();
            let mut metadata = serde_json::Map::new();
            if let Some(Value::Object(repo_pool)) =
                daemon_repo_pool_spawn_metadata(child.repo_pool_binding.as_ref())
            {
                metadata.extend(repo_pool);
            }
            #[cfg(windows)]
            if let Some(evidence) = child.adoption_evidence.as_ref() {
                metadata.insert(
                    "continuity".into(),
                    serde_json::json!({
                        "schemaVersion": 2,
                        "protocolMajor": evidence.protocol_major,
                        "adoptionKeyHash": evidence.adoption_key_hash,
                        "wrapperNonce": evidence.wrapper_nonce,
                        "processBirthId": evidence.process_birth_id.to_string(),
                        "executableSha256": evidence.executable_sha256,
                    }),
                );
            }
            let metadata = (!metadata.is_empty()).then_some(Value::Object(metadata));
            if let Err(error) = register_daemon_child(run_registry, child, identity_id, None).await
            {
                return DaemonSpawnResultParts {
                    ok: false,
                    spawned_at: Some(spawned_at),
                    pid: None,
                    error: Some(error.to_string()),
                    // A failed acknowledgement does not prove that the child
                    // tree or its lease was rolled back. Preserve exact pool
                    // authority so Authority can later issue a typed abandon rather
                    // than losing the only durable route to a live/retained
                    // slot. An exact completed-return receipt makes the same
                    // authority safely idempotent when rollback did finish.
                    metadata,
                };
            }
            if let Some(log) = log {
                println!(
                    "{} spawned {} in {} as {} (pid {})",
                    "✓".green().bold(),
                    log.runtime,
                    log.workspace_name,
                    log.agent_name,
                    pid
                );
            }
            // The child monitor reports the new Run's progress as it changes;
            // a spawn no longer resends every Run on this machine.
            if run_worktree::gc_sweep_enabled() {
                // Opportunistic LRU sweep of ended-run worktrees; live runs
                // (any cwd in the registry) are protected. Runs detached so
                // it never delays the spawn ack.
                let live_cwds: HashSet<PathBuf> = run_registry
                    .lock()
                    .await
                    .values()
                    .filter_map(|child| child.cwd.clone())
                    .collect();
                config::spawn_profile_task(async move {
                    let outcome = run_worktree::gc_run_worktrees(live_cwds).await;
                    run_worktree::log_gc_outcome(&outcome);
                });
            }
            DaemonSpawnResultParts {
                ok: true,
                spawned_at: Some(spawned_at),
                pid: Some(pid),
                error: None,
                metadata,
            }
        }
        Err(err) => {
            if let Some(log) = log {
                eprintln!(
                    "{} failed to spawn {} in {}: {err}",
                    "⚠".yellow().bold(),
                    log.runtime,
                    log.workspace_name
                );
            }
            daemon_spawn_failure_parts(err.to_string(), failure_repo_pool_binding)
        }
    }
}

fn daemon_spawn_failure_parts(
    error: String,
    failure_repo_pool_binding: Option<&DaemonRepoPoolBinding>,
) -> DaemonSpawnResultParts {
    DaemonSpawnResultParts {
        ok: false,
        spawned_at: None,
        pid: None,
        error: Some(error),
        metadata: daemon_repo_pool_spawn_metadata(failure_repo_pool_binding),
    }
}

fn daemon_spawn_needs_remote_login(err: &CliError) -> bool {
    let message = err.to_string().to_ascii_lowercase();
    message.contains("invalid or expired auth token")
        || message.contains("session expired")
        || message.contains("not logged in")
        || message.contains("saved session cannot be refreshed")
}

async fn recover_daemon_session_from_channel_login(
    hub_url: &str,
    session_state: Option<DaemonSessionState>,
    relay: SharedMachineDaemonConnection,
    request_id: &str,
    run_id: Option<&str>,
    channel_id: &str,
    agent_name: &str,
    identity_id: Option<&str>,
) -> error::Result<String> {
    let session_state = session_state.ok_or_else(|| {
        CliError::Auth(
            "Daemon was started with an explicit token; run xmatrix login on the host and restart the daemon"
                .into(),
        )
    })?;
    let expected_user = {
        let guard = session_state.read().await;
        guard.session.user.clone()
    };
    let device_login = auth::start_device_login(hub_url).await?;

    send_daemon_spawn_auth_required(
        &relay,
        request_id,
        run_id,
        channel_id,
        agent_name,
        identity_id,
        &device_login,
    )
    .await?;

    let response = auth::poll_device_login(hub_url, &device_login).await?;
    if response.user.id != expected_user.id {
        return Err(CliError::Auth(format!(
            "Remote login completed for {}, but this daemon belongs to {}; sign in as {} to start remote agents",
            response.user.email, expected_user.email, expected_user.email
        )));
    }

    let previous_machine_credential = relay.machine_credential()?;
    config::save_session(
        response.token,
        response.refresh_token,
        response.user,
        response.hub_url,
        response.relay_url,
        None,
    )
    .await?;
    reload_daemon_session_from_saved_session(hub_url, &session_state, &relay).await?;
    relay
        .wait_for_machine_credential_change(&previous_machine_credential)
        .await
}

async fn send_daemon_spawn_auth_required(
    relay: &SharedMachineDaemonConnection,
    request_id: &str,
    run_id: Option<&str>,
    channel_id: &str,
    agent_name: &str,
    identity_id: Option<&str>,
    device_login: &auth::DeviceLoginStartResponse,
) -> error::Result<()> {
    let relay = relay.clone();
    relay.send_report(MachineDaemonReport::MachineSpawnAuthRequired {
        request_id: request_id.to_string(),
        run_id: run_id.map(str::to_string),
        channel_id: channel_id.to_string(),
        agent_name: agent_name.to_string(),
        identity_id: identity_id.map(str::to_string),
        verification_uri_complete: device_login.verification_uri_complete.clone(),
        user_code: device_login.user_code.clone(),
        expires_in: device_login.expires_in,
    })
}

async fn poll_daemon_control(
    hub_url: &str,
    token: &str,
    machine_id: &str,
    _hostname: &str,
    connection_epoch: u64,
) -> error::Result<Vec<MachineDaemonCommand>> {
    let route = format!(
        "{}?machineId={}&connectionEpoch={}&waitMs={}&waitMode=signal_v1&replyRecovery=1",
        HubRoutes::DAEMON_CONTROL,
        urlencoding::encode(machine_id),
        connection_epoch,
        DAEMON_CONTROL_LONG_POLL_WAIT_MS
    );
    let response: DaemonControlResponse = tokio::time::timeout(
        Duration::from_millis(DAEMON_CONTROL_REQUEST_TIMEOUT_MS),
        http::request_json(&with_route(hub_url, &route), "GET", Some(token), None),
    )
    .await
    .map_err(|_| {
        CliError::Launch(format!(
            "daemon control request timed out after {}ms",
            DAEMON_CONTROL_REQUEST_TIMEOUT_MS
        ))
    })??;
    if response.commands.len() > DAEMON_CONTROL_FALLBACK_BATCH_MAX_COMMANDS {
        return Err(CliError::Launch(format!(
            "daemon control returned {} commands; maximum is {}",
            response.commands.len(),
            DAEMON_CONTROL_FALLBACK_BATCH_MAX_COMMANDS,
        )));
    }
    Ok(response.commands)
}

async fn renew_daemon_command_lease(
    hub_url: &str,
    token: &str,
    relay: &SharedMachineDaemonConnection,
    request_id: &str,
    relay_lease: &MachineDaemonCommandLease,
) -> Result<(), DaemonCommandLeaseRenewalError> {
    match relay
        .renew_command_lease_over_socket(request_id, relay_lease)
        .await
    {
        Ok(_) => return Ok(()),
        Err(error) if command_lease_renewal_falls_back_to_http(&error) => {
            eprintln!(
                "{} command lease renewal falling back to HTTP: {error}",
                "⚠".yellow().bold(),
            );
        }
        Err(error) => {
            return Err(DaemonCommandLeaseRenewalError::FenceLost(error.to_string()));
        }
    }
    renew_daemon_command_lease_http(hub_url, token, request_id, relay_lease).await
}

async fn renew_daemon_command_lease_http(
    hub_url: &str,
    token: &str,
    request_id: &str,
    relay_lease: &MachineDaemonCommandLease,
) -> Result<(), DaemonCommandLeaseRenewalError> {
    let url = with_route(hub_url, HubRoutes::DAEMON_COMMAND_LEASE_RENEW);
    let client = http::client()
        .map_err(|error| DaemonCommandLeaseRenewalError::FenceLost(error.to_string()))?;
    let request = client
        .post(&url)
        .bearer_auth(token)
        .json(&serde_json::json!({
            "requestId": request_id,
            "relayLease": relay_lease,
        }));
    let request = http::with_access_header(request, &url)
        .map_err(|error| DaemonCommandLeaseRenewalError::FenceLost(error.to_string()))?
        .send();
    let response = tokio::time::timeout(
        Duration::from_secs(DAEMON_COMMAND_LEASE_RENEW_REQUEST_TIMEOUT_SECS),
        request,
    )
    .await
    .map_err(|_| {
        DaemonCommandLeaseRenewalError::Transient(format!(
            "command lease renewal timed out after {}s",
            DAEMON_COMMAND_LEASE_RENEW_REQUEST_TIMEOUT_SECS,
        ))
    })?
    .map_err(|error| DaemonCommandLeaseRenewalError::Transient(describe_error_chain(&error)))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let message = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| format!("Hub returned HTTP {status}"));
        if status == reqwest::StatusCode::UPGRADE_REQUIRED {
            return Err(DaemonCommandLeaseRenewalError::FenceLost(message));
        }
        if status.is_server_error()
            || status == reqwest::StatusCode::REQUEST_TIMEOUT
            || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        {
            return Err(DaemonCommandLeaseRenewalError::Transient(message));
        }
        return Err(DaemonCommandLeaseRenewalError::FenceLost(message));
    }
    let payload = serde_json::from_str::<serde_json::Value>(&body).map_err(|error| {
        DaemonCommandLeaseRenewalError::FenceLost(format!(
            "Hub returned an invalid command lease renewal response: {error}",
        ))
    })?;
    if payload.get("ok").and_then(Value::as_bool) != Some(true)
        || payload.get("leaseUntil").and_then(Value::as_str).is_none()
    {
        return Err(DaemonCommandLeaseRenewalError::FenceLost(
            "Hub did not confirm the renewed command lease".into(),
        ));
    }
    Ok(())
}

async fn admit_daemon_command_http(
    hub_url: &str,
    token: &str,
    command: &MachineDaemonCommand,
) -> error::Result<()> {
    let payload = daemon_command_http_admission_payload(command_admission_report(command)?)?;
    let response: Value = with_daemon_command_admission_timeout(
        "HTTP Machine Command admission",
        Duration::from_secs(DAEMON_COMMAND_ADMISSION_REQUEST_TIMEOUT_SECS),
        http::request_json(
            &with_route(hub_url, HubRoutes::DAEMON_COMMAND_LEASE_RENEW),
            "POST",
            Some(token),
            Some(payload),
        ),
    )
    .await?;
    if response.get("ok").and_then(Value::as_bool) != Some(true)
        || response.get("leaseUntil").and_then(Value::as_str).is_none()
    {
        return Err(CliError::RelayTransient(
            "Hub did not acknowledge HTTP Machine Command admission".into(),
        ));
    }
    Ok(())
}

/// Admit a pushed command on the control socket, falling back to the HTTP
/// lease route when that socket cannot complete the round trip.
///
/// The polled path already admits these commands over HTTP; the push path had
/// no second chance, so one stalled socket round trip dropped the command with
/// no process, no report and no retry. Commands that carry no Launch row --
/// a reborn spawn, its predecessor stop, handoff, management -- are exactly the
/// ones that cannot use the combined preflight, so they were the ones lost.
async fn admit_pushed_daemon_command(
    hub_url: &str,
    relay: &SharedMachineDaemonConnection,
    command: &MachineDaemonCommand,
) -> error::Result<()> {
    let report = command_admission_report(command)?;
    let socket_error = match classify_socket_command_admission(relay.admit_command(report).await) {
        DaemonAdmissionOutcome::Admitted => return Ok(()),
        DaemonAdmissionOutcome::FallBackToHttp(error) => error,
        DaemonAdmissionOutcome::Failed(error) => return Err(error),
    };
    eprintln!(
        "{} command admission falling back to HTTP: {socket_error}",
        "⚠".yellow().bold(),
    );
    let credential = relay.machine_credential()?;
    admit_daemon_command_http(hub_url, &credential, command).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonSpawnAdmissionResponse {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    terminal: bool,
    #[serde(default)]
    token: Option<String>,
    lease_until: String,
    #[serde(default)]
    error: Option<String>,
}

enum DaemonSpawnAdmission {
    Authorized(String),
    Rejected(String),
}

async fn admit_and_authorize_daemon_spawn_http(
    hub_url: &str,
    token: &str,
    command: &MachineDaemonCommand,
) -> error::Result<DaemonSpawnAdmission> {
    let payload = daemon_spawn_admission_payload(command)?;
    let response: DaemonSpawnAdmissionResponse = with_daemon_command_admission_timeout(
        "combined spawn admission",
        Duration::from_secs(DAEMON_COMMAND_ADMISSION_REQUEST_TIMEOUT_SECS),
        http::request_json(
            &with_route(hub_url, HubRoutes::DAEMON_COMMAND_ADMIT_AUTHORIZE),
            "POST",
            Some(token),
            Some(payload),
        ),
    )
    .await?;
    if response.lease_until.trim().is_empty() {
        return Err(CliError::RelayTransient(
            "Hub returned an invalid combined spawn admission".into(),
        ));
    }
    if response.ok {
        let token = response
            .token
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                CliError::RelayTransient(
                    "Hub returned combined admission without a Run token".into(),
                )
            })?;
        return Ok(DaemonSpawnAdmission::Authorized(token));
    }
    if response.terminal {
        return Ok(DaemonSpawnAdmission::Rejected(
            response
                .error
                .unwrap_or_else(|| "Machine spawn admission was rejected".into()),
        ));
    }
    Err(CliError::RelayTransient(
        "Hub returned an invalid combined spawn admission".into(),
    ))
}

async fn with_daemon_command_admission_timeout<T>(
    label: &str,
    timeout: Duration,
    request: impl std::future::Future<Output = error::Result<T>>,
) -> error::Result<T> {
    tokio::time::timeout(timeout, request)
        .await
        .map_err(|_| CliError::RelayTransient(format!("{label} timed out after {timeout:?}")))?
}

/// A Run is admitted only by this lease-proving preflight of its registration
/// binding; its token route is a continuation. A reborn successor carries the
/// binding but no Launch, so the binding, not the Launch, selects this path.
fn daemon_spawn_has_combined_admission_authority(command: &MachineDaemonCommand) -> bool {
    matches!(
        command,
        MachineDaemonCommand::MachineSpawnAgent {
            run_id: Some(_),
            instance_id: Some(_),
            execution_key: Some(_),
            identity_id: Some(_),
            relay_lease: Some(_),
            registration: Some(_),
            ..
        }
    )
}

fn daemon_spawn_admission_payload(command: &MachineDaemonCommand) -> error::Result<Value> {
    let MachineDaemonCommand::MachineSpawnAgent {
        request_id,
        launch_id,
        run_id: Some(run_id),
        instance_id: Some(instance_id),
        execution_key: Some(execution_key),
        identity_id: Some(agent_id),
        registration: Some(registration),
        space_id,
        channel_id,
        workspace,
        management_space_id,
        remote_repo,
        relay_lease: Some(relay_lease),
        ..
    } = command
    else {
        return Err(CliError::Launch(
            "Spawn command is missing immutable admission authority".into(),
        ));
    };
    let mut payload = serde_json::json!({
        "requestId": request_id,
        "admittedAt": daemon_event_at_rfc3339(),
        "runId": run_id,
        "instanceId": instance_id,
        "executionKey": execution_key,
        "agentId": agent_id,
        "spaceId": space_id,
        "channelId": channel_id,
        "workspace": workspace,
        "managementSpaceId": management_space_id,
        "remoteRepo": remote_repo,
        "relayLease": relay_lease,
    });
    if let Some(launch_id) = launch_id {
        payload["launchId"] = Value::from(launch_id.as_str());
    }
    payload["registration"] = serde_json::to_value(registration)?;
    Ok(payload)
}

fn daemon_command_http_admission_payload(report: MachineDaemonReport) -> error::Result<Value> {
    let MachineDaemonReport::MachineCommandAdmitted {
        control_id,
        launch_id,
        channel_id,
        admitted_at,
        relay_lease,
        ..
    } = report
    else {
        return Err(CliError::Launch(
            "Daemon command admission produced an invalid report".into(),
        ));
    };
    let mut payload = serde_json::json!({
        "requestId": control_id,
        "admittedAt": admitted_at,
        "relayLease": relay_lease,
    });
    if let (Some(launch_id), Some(channel_id)) = (launch_id, channel_id) {
        payload["launchId"] = Value::String(launch_id);
        payload["channelId"] = Value::String(channel_id);
    }
    Ok(payload)
}

async fn report_daemon_control_result_http(
    hub_url: &str,
    token: &str,
    message: MachineDaemonReport,
) -> error::Result<()> {
    let url = with_route(hub_url, HubRoutes::DAEMON_CONTROL_RESULT);
    let body = serde_json::to_value(message)?;
    let mut retry = 0;
    loop {
        let client = http::client()?;
        let request =
            http::with_access_header(client.post(&url).bearer_auth(token).json(&body), &url)?;
        let response = match tokio::time::timeout(
            Duration::from_secs(DAEMON_CONTROL_RESULT_REQUEST_TIMEOUT_SECS),
            request.send(),
        )
        .await
        {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                let error = CliError::Request(error);
                let Some(delay) = control_result_retry_delay(retry) else {
                    return Err(error);
                };
                eprintln!(
                    "{} daemon HTTP completion transport failed; retrying in {}ms: {}",
                    "⚠".yellow().bold(),
                    delay.as_millis(),
                    describe_error_chain(&error),
                );
                retry += 1;
                tokio::time::sleep(delay).await;
                continue;
            }
            Err(_) => {
                let error = CliError::RelayTransient(format!(
                    "daemon HTTP completion timed out after {}s",
                    DAEMON_CONTROL_RESULT_REQUEST_TIMEOUT_SECS,
                ));
                let Some(delay) = control_result_retry_delay(retry) else {
                    return Err(error);
                };
                eprintln!(
                    "{} daemon HTTP completion timed out; retrying in {}ms",
                    "⚠".yellow().bold(),
                    delay.as_millis(),
                );
                retry += 1;
                tokio::time::sleep(delay).await;
                continue;
            }
        };
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if status.is_success() {
            let _: Value = serde_json::from_str(&text)?;
            return Ok(());
        }
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| format!("Hub returned HTTP {status}"));
        let error = if status == reqwest::StatusCode::UPGRADE_REQUIRED {
            CliError::UpgradeRequired(message)
        } else {
            CliError::Http(message)
        };
        if !control_result_status_is_retryable(status) {
            return Err(error);
        }
        let Some(delay) = control_result_retry_delay(retry) else {
            return Err(error);
        };
        eprintln!(
            "{} daemon HTTP completion received {status}; retrying in {}ms: {error}",
            "⚠".yellow().bold(),
            delay.as_millis(),
        );
        retry += 1;
        tokio::time::sleep(delay).await;
    }
}

async fn report_polled_command_effect_result_http(
    hub_url: &str,
    token: &str,
    relay: &SharedMachineDaemonConnection,
    journal: &DaemonEffectJournal,
    stable_id: &str,
    control_id: &str,
    message: MachineDaemonReport,
) -> error::Result<()> {
    let message = relay.bind_claimed_command_registry_causality(message)?;
    commit_command_effect_result(journal, stable_id, &message)?;
    report_daemon_control_result_http(hub_url, token, message).await?;
    journal
        .lock()
        .map_err(|_| CliError::Launch("Daemon command effect journal is poisoned".into()))?
        .acknowledge(control_id)
        .map_err(|error| {
            CliError::Launch(format!("Daemon command completion ack failed: {error}"))
        })?;
    Ok(())
}

fn daemon_repo_pool_spawn_metadata(binding: Option<&DaemonRepoPoolBinding>) -> Option<Value> {
    binding.map(|binding| {
        serde_json::json!({
            "repoPool": {
                "repoIdentity": binding.canonical_repo_identity,
                "repoKeyId": binding.repo_key_id,
                "slotId": binding.slot_id,
            }
        })
    })
}

async fn daemon_run_existing_spawn(
    registry: &DaemonRunRegistry,
    intent: &DaemonSpawnRequest,
) -> Option<DaemonSpawnClaim> {
    let key = daemon_spawn_claim_key(intent.run_id.as_deref(), intent.execution_key.as_deref())?;
    let guard = registry.lock().await;
    let managed = guard.get(&key)?;
    if managed.stop_in_progress {
        return Some(DaemonSpawnClaim::Conflict);
    }
    if !crate::process_tree::process_alive(managed.pid) {
        return None;
    }
    if managed.run_id != intent.run_id
        || managed.execution_key != intent.execution_key
        || managed
            .instance_id
            .as_ref()
            .is_some_and(|instance_id| Some(instance_id) != intent.instance_id.as_ref())
        || managed
            .resume_session_key
            .as_ref()
            .is_some_and(|session_key| Some(session_key) != intent.resume_session_key.as_ref())
    {
        return Some(DaemonSpawnClaim::Conflict);
    }
    Some(DaemonSpawnClaim::Existing(DaemonSpawnResultParts {
        ok: true,
        spawned_at: None,
        pid: Some(managed.pid),
        error: None,
        metadata: daemon_repo_pool_spawn_metadata(managed.repo_pool_binding.as_ref()),
    }))
}

fn daemon_spawn_claim_key(run_id: Option<&str>, execution_key: Option<&str>) -> Option<String> {
    run_id
        .map(|value| daemon_run_key("run", value))
        .or_else(|| execution_key.map(|value| daemon_run_key("execution", value)))
}

async fn claim_daemon_spawn(
    registry: &DaemonRunRegistry,
    inflight: &DaemonSpawnInflight,
    intent: &DaemonSpawnRequest,
    auth_broker: Option<&DaemonAuthBroker>,
    request_broker: Option<&DaemonRequestBroker>,
) -> DaemonSpawnClaim {
    let Some(key) =
        daemon_spawn_claim_key(intent.run_id.as_deref(), intent.execution_key.as_deref())
    else {
        return DaemonSpawnClaim::Claimed(None);
    };

    // A previous daemon can crash after pre-spawn pool admission but before the
    // global registry commit. Recover its exact durable sidecar at command
    // replay time, not only on the 30-second monitor tick.
    let _ = recover_daemon_run_registry_from_sidecars_in_dir(
        registry,
        &daemon_run_log_dir(),
        auth_broker,
        request_broker,
        true,
    )
    .await;
    if let Some(existing) = daemon_run_existing_spawn(registry, intent).await {
        return existing;
    }

    let mut guard = inflight.lock().await;
    if !guard.insert(key.clone()) {
        return DaemonSpawnClaim::Inflight;
    }
    DaemonSpawnClaim::Claimed(Some(key))
}

async fn release_daemon_spawn_claim(inflight: &DaemonSpawnInflight, key: Option<String>) {
    if let Some(key) = key {
        inflight.lock().await.remove(&key);
    }
}

fn daemon_spawn_result_message(
    ok: bool,
    spawned_at: Option<String>,
    pid: Option<u32>,
    error: Option<String>,
    metadata: Option<Value>,
    intent: &DaemonSpawnRequest,
) -> MachineDaemonReport {
    MachineDaemonReport::MachineSpawnResult {
        request_id: intent.request_id.clone(),
        launch_id: intent.launch_id.clone(),
        run_id: intent.run_id.clone(),
        execution_key: intent.execution_key.clone(),
        instance_id: intent.instance_id.clone(),
        machine_id: intent.workspace.machine_id.clone(),
        canonical_cwd: intent.workspace.canonical_cwd.clone(),
        channel_id: intent.channel_id.clone(),
        agent_name: intent.agent_name.clone(),
        identity_id: intent.identity_id.clone(),
        ok,
        // New daemons capture this at Command::spawn success. The fallback
        // preserves replay compatibility for pre-field journal entries.
        spawned_at: ok.then(|| spawned_at.unwrap_or_else(daemon_event_at_rfc3339)),
        registry_connection_epoch: None,
        registry_sequence: None,
        pid,
        error,
        metadata,
        relay_lease: intent.relay_lease.clone(),
    }
}

fn daemon_event_at_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// A Claude reborn resumes its session only in the directory that session was
/// recorded in. The stream session enforces that before `--resume`, but only
/// after the wrapper registered, joined and accepted a turn -- so a diverged
/// cwd surfaced as three refused turns and a 30s response timeout. Ask the
/// same question here, before any process starts, and fail the spawn with the
/// refusal itself. The check is never looser than the runtime guard: a cwd is
/// accepted if either its literal or its resolved spelling owns the session.
fn daemon_claude_reborn_cwd_preflight(
    intent: &DaemonSpawnRequest,
    cwd: &Path,
) -> error::Result<()> {
    if !intent.resume || !daemon_spawn_uses_claude_print(&intent.runtime, &intent.runtime_args) {
        return Ok(());
    }
    let Some(session_id) = crate::runtime_claude_turn::load_claude_resume_session_id(
        intent.resume_session_key.as_deref(),
    ) else {
        return Ok(());
    };
    let Some(refusal) = crate::runtime_claude_turn::claude_reborn_resume_refusal(&session_id, cwd)
    else {
        return Ok(());
    };
    let resolved_accepts = std::fs::canonicalize(cwd).is_ok_and(|resolved| {
        crate::runtime_claude_turn::claude_reborn_resume_refusal(&session_id, &resolved).is_none()
    });
    if resolved_accepts {
        return Ok(());
    }
    Err(CliError::Launch(refusal))
}

/// A repo reborn that arrives without Hub-issued pool authority is still the
/// same harness session. When this machine retained a pool slot for that
/// session, the slot is the only directory the session can resume in, so the
/// reborn leases it back through the ordinary pooled-reborn checks (exact
/// Instance, repo identity, ownership) instead of cutting a fresh run-* tree
/// the harness would refuse. A session this machine never pooled keeps the
/// historical path; a pooled session whose slot cannot be reborn fails here,
/// before any process starts.
async fn adopt_retained_repo_pool_authority(
    intent: &DaemonSpawnRequest,
) -> error::Result<Option<DaemonSpawnRequest>> {
    if !intent.resume
        || intent.handoff_transfer
        || !intent.run_worktree
        || intent.repo_identity.is_some()
        || intent.repo_key_id.is_some()
        || intent.slot_id.is_some()
    {
        return Ok(None);
    }
    let (Some(remote_repo), Some(session_key)) = (
        intent.remote_repo.as_deref(),
        intent
            .resume_session_key
            .as_deref()
            .filter(|key| !key.trim().is_empty()),
    ) else {
        return Ok(None);
    };
    let Ok(canonical) = repo_pool::canonical_repo_identity(remote_repo) else {
        return Ok(None);
    };
    let repo_key = repo_pool::repo_key_id(&canonical);
    let pools_root = repo_pool::default_repo_pools_root()
        .map_err(|error| CliError::Launch(format!("repo pool root unavailable ({error})")))?;
    let retained =
        repo_pool::retained_binding_for_unissued_reborn_at(&pools_root, &repo_key, session_key)
            .await
            .map_err(|error| {
                CliError::Launch(format!(
                    "Refusing to reborn: this Instance's retained repo worktree cannot be resumed \
                     ({error}). Its session only resumes in that directory; start a new Instance \
                     instead."
                ))
            })?;
    let Some(retained) = retained else {
        return Ok(None);
    };
    let mut adopted = intent.clone();
    adopted.repo_identity = Some(canonical.as_str().to_string());
    adopted.repo_key_id = Some(repo_key.as_str().to_string());
    adopted.slot_id = Some(retained.authority.slot_id);
    Ok(Some(adopted))
}

// One repository, one pool. Run lifecycle is not part of this decision: a
// Run takes a lease and retains its workspace on exit. Explicit abandon uses
// the ordinary snapshot-preserving return path.

/// Whether the spawn carries an exact retained repo-pool slot. Only a reborn
/// (which resumes the slot) and a same-machine handoff (which transfers it to
/// a new Instance) may name one; anything else must lease a fresh slot.
fn daemon_repo_pool_authority(intent: &DaemonSpawnRequest) -> error::Result<bool> {
    let field_count = [
        intent.repo_identity.as_ref(),
        intent.repo_key_id.as_ref(),
        intent.slot_id.as_ref(),
    ]
    .iter()
    .filter(|value| value.is_some())
    .count();
    if field_count != 0 && field_count != 3 {
        return Err(CliError::Launch(
            "repo worktree pool resume authority is partial".into(),
        ));
    }
    let has_authority = field_count == 3;
    if has_authority && !intent.resume && !intent.handoff_transfer {
        return Err(CliError::Launch(
            "repo worktree pool authority is only valid for reborn or handoff".into(),
        ));
    }
    if has_authority && (!intent.run_worktree || intent.remote_repo.is_none()) {
        return Err(CliError::Launch(
            "repo worktree pool reborn is incompatible with this spawn mode".into(),
        ));
    }
    Ok(has_authority)
}

fn daemon_repo_pool_spawn_eligible(
    run_worktree: bool,
    has_remote_repo: bool,
    resume: bool,
    has_resume_pool_authority: bool,
) -> bool {
    run_worktree && has_remote_repo && (!resume || has_resume_pool_authority)
}

fn daemon_isolated_runtime_args(
    runtime: &str,
    runtime_args: &[String],
) -> error::Result<Vec<String>> {
    let mut args = runtime_args.to_vec();
    if !is_grok_tool(runtime) {
        return Ok(args);
    }
    if args.iter().any(|arg| arg == "--leader") {
        return Err(CliError::Launch(
            "daemon-managed Grok Runs cannot share a leader process".into(),
        ));
    }
    if !args.iter().any(|arg| arg == "--no-leader") {
        args.push("--no-leader".to_string());
    }
    Ok(args)
}

fn select_headless_wrapper_executable(
    current_exe: PathBuf,
    exact_process_image: Option<&Path>,
) -> error::Result<PathBuf> {
    if current_exe.is_file() {
        return Ok(current_exe);
    }
    if let Some(process_image) = exact_process_image.filter(|path| path.is_file()) {
        return Ok(process_image.to_path_buf());
    }
    Err(CliError::Launch(
        "xMatrix daemon executable is no longer available; restart the daemon before launching another Agent"
            .into(),
    ))
}

fn headless_wrapper_executable() -> error::Result<PathBuf> {
    let current_exe = std::env::current_exe()
        .map_err(|err| CliError::Launch(format!("Failed to locate xMatrix executable: {err}")))?;
    #[cfg(target_os = "linux")]
    let exact_process_image = Some(Path::new("/proc/self/exe"));
    #[cfg(not(target_os = "linux"))]
    let exact_process_image = None;
    select_headless_wrapper_executable(current_exe, exact_process_image)
}
fn apply_authoritative_agent_execution_env(
    mut env: BTreeMap<String, String>,
    backend: Option<&str>,
    preset_id: Option<&str>,
    acp_args: &[String],
) -> error::Result<BTreeMap<String, String>> {
    let backend = backend.map(str::trim).filter(|value| !value.is_empty());
    if let Some(backend) = backend {
        if !matches!(
            backend,
            "codex-app" | "claude-print" | "zcode-app" | "grok-acp" | "acp" | "pty"
        ) {
            return Err(CliError::Launch(
                "spawn request contains an invalid Agent backend".into(),
            ));
        }
        // Once the server supplies an execution adapter, it is authoritative:
        // do not let a stale local profile contribute a different preset or
        // ACP argv. Local profile secrets and ordinary env still remain local.
        env.remove("XMATRIX_AGENT_PRESET_ID");
        env.remove("XMATRIX_ACP_ARGS");
        env.insert("XMATRIX_AGENT_BACKEND".to_string(), backend.to_string());
    } else if preset_id.is_some() || !acp_args.is_empty() {
        return Err(CliError::Launch(
            "spawn request execution details require an Agent backend".into(),
        ));
    }

    if let Some(preset_id) = preset_id.map(str::trim).filter(|value| !value.is_empty()) {
        if preset_id.len() > 128
            || preset_id
                .chars()
                .any(|value| value.is_control() || value == '\0')
        {
            return Err(CliError::Launch(
                "spawn request contains an invalid Agent preset id".into(),
            ));
        }
        env.insert("XMATRIX_AGENT_PRESET_ID".to_string(), preset_id.to_string());
    }

    if !acp_args.is_empty() {
        if backend != Some("acp")
            || acp_args.len() > 32
            || acp_args.iter().any(|value| {
                value.is_empty() || value.len() > 1024 || value.chars().any(|char| char == '\0')
            })
        {
            return Err(CliError::Launch(
                "spawn request contains invalid Agent ACP arguments".into(),
            ));
        }
        env.insert(
            "XMATRIX_ACP_ARGS".to_string(),
            serde_json::to_string(acp_args).map_err(|error| {
                CliError::Launch(format!("Agent ACP arguments could not be encoded: {error}"))
            })?,
        );
    }
    Ok(env)
}

struct HeadlessAgentSpawn<'a> {
    hub_url: &'a str,
    registration: &'a xmatrix_cli_core::agent_registration::RegistrationLaunchBinding,
    auth_grant: Option<DaemonAuthGrant>,
    request_broker: Option<DaemonRequestBroker>,
    workspace: &'a protocol::DaemonSpawnWorkspace,
    space_id: &'a str,
    channel_id: &'a str,
    runtime: &'a str,
    runtime_args: &'a [String],
    agent_backend: Option<&'a str>,
    agent_preset_id: Option<&'a str>,
    agent_acp_args: &'a [String],
    agent_name: &'a str,
    identity_id: Option<&'a str>,
    role_initial_prompt: Option<&'a str>,
    resume: bool,
    resume_instance_id: Option<&'a str>,
    resume_session_key: Option<&'a str>,
    handoff_source_resume_session_key: Option<&'a str>,
    goal: Option<&'a protocol::AgentGoalStatus>,
    initial_message_source: Option<&'a protocol::AgentRuntimeMessageSource>,
    requested_model: Option<&'a str>,
    requested_effort: Option<&'a str>,
    requested_parameters: Option<&'a BTreeMap<String, String>>,
    run_id: Option<&'a str>,
    launcher_id: Option<&'a str>,
    materializer_id: Option<&'a str>,
    execution_key: Option<&'a str>,
    instance_id: Option<&'a str>,
    prompt: &'a str,
    source_message_id: Option<&'a str>,
    attachments: Option<&'a [protocol::ChannelAttachment]>,
    routing_workspace: Option<DaemonRoutingWorkspace<'a>>,
    run_worktree_env: Option<&'a run_worktree::RunWorktreeSpawnEnv>,
    repo_pool_binding: Option<&'a DaemonRepoPoolBinding>,
    repo_pool_spawn_claim: Option<&'a DaemonRepoPoolSpawnClaim>,
    daemon_relay: &'a SharedMachineDaemonConnection,
    daemon_epoch: u64,
}

async fn spawn_headless_agent(
    spawn: HeadlessAgentSpawn<'_>,
) -> error::Result<SpawnedHeadlessAgent> {
    let HeadlessAgentSpawn {
        hub_url,
        registration,
        auth_grant,
        request_broker,
        workspace,
        space_id,
        channel_id,
        runtime,
        runtime_args,
        agent_backend,
        agent_preset_id,
        agent_acp_args,
        agent_name,
        identity_id,
        role_initial_prompt,
        resume,
        resume_instance_id,
        resume_session_key,
        handoff_source_resume_session_key,
        goal,
        initial_message_source,
        requested_model,
        requested_effort,
        requested_parameters,
        run_id,
        launcher_id,
        materializer_id,
        execution_key,
        instance_id,
        prompt,
        source_message_id,
        attachments,
        routing_workspace,
        run_worktree_env,
        repo_pool_binding,
        repo_pool_spawn_claim,
        daemon_relay,
        daemon_epoch,
    } = spawn;
    // Registry-defined update controls apply only to this preset's xMatrix launches.
    let auto_update = runtime_daemon_harness_policy::spawn_auto_update_overrides(
        agent_preset_id,
        agent_backend,
        &daemon_isolated_runtime_args(runtime, runtime_args)?,
        agent_acp_args,
    );
    let runtime_args = auto_update.runtime_args;
    let mut local_env = apply_authoritative_agent_execution_env(
        apply_spawn_initial_prompt(BTreeMap::new(), role_initial_prompt),
        agent_backend,
        agent_preset_id,
        &auto_update.acp_args,
    )?;
    local_env.extend(auto_update.env);
    local_env.insert(
        "XMATRIX_AGENT_REGISTRATION".into(),
        serde_json::to_string(&registration.key)?,
    );
    let request_grant = request_broker.as_ref().map(|broker| {
        broker.issue_agent_grant(DaemonRequestAgentContext {
            agent_id: identity_id.map(str::to_string),
            agent_name: agent_name.to_string(),
            space_id: space_id.to_string(),
            approval_channel_id: Some(channel_id.to_string()),
            channel_id: channel_id.to_string(),
            run_id: run_id.map(str::to_string),
            execution_key: execution_key.map(str::to_string),
            workspace_cwd: workspace.canonical_cwd.clone(),
            admitted_secrets: Some(registration.resources.secrets.clone()),
        })
    });
    // An external Unix update may atomically replace the installed CLI while
    // an older daemon still owns work. Linux keeps that running image
    // executable through /proc/self/exe even when current_exe points at the
    // now-unlinked inode, so launches remain exact and never search PATH.
    let exe = headless_wrapper_executable()?;
    let attachment_file = write_initial_message_attachments_file(attachments)?;
    let run_files = prepare_daemon_run_files(run_id, execution_key, agent_name);
    if repo_pool_binding.is_some() && (repo_pool_spawn_claim.is_none() || run_files.is_none()) {
        return Err(CliError::Launch(
            "repo pool spawn requires durable pre-spawn authority and sidecar".into(),
        ));
    }
    let mut provisional_sidecar =
        match (repo_pool_binding, repo_pool_spawn_claim, run_files.as_ref()) {
            (Some(binding), Some(_claim), Some(files)) => Some(PersistedDaemonRun {
                #[cfg(windows)]
                handoff: None,
                pid: 0,
                profile_id: config::active_profile_context()
                    .map(|profile| profile.id.as_str().to_string()),
                cwd: Some(PathBuf::from(&workspace.canonical_cwd)),
                run_id: run_id.map(str::to_string),
                execution_key: execution_key.map(str::to_string),
                instance_id: instance_id.map(str::to_string),
                resume_session_key: resume_session_key.map(str::to_string),
                repo_pool_binding: Some(binding.clone()),
                agent_id: identity_id.map(str::to_string),
                agent_name: Some(agent_name.to_string()),
                // Only the one-way key goes to disk, as every later
                // registry write does; the raw capability stays in the child.
                auth_capability: auth_grant
                    .as_ref()
                    .map(|grant| grant.capability_key.clone()),
                request_capability: request_grant
                    .as_ref()
                    .map(|grant| grant.capability_key.clone()),
                request_context: request_grant.as_ref().map(|grant| grant.context.clone()),
                status_file_path: Some(files.status_file_path.clone()),
                stdout_log_path: Some(files.stdout_log_path.clone()),
                stderr_log_path: Some(files.stderr_log_path.clone()),
                updated_at: config::unix_now_secs().to_string(),
            }),
            (None, None, _) => None,
            _ => {
                return Err(CliError::Launch(
                    "repo pool spawn claim and binding must be complete".into(),
                ));
            }
        };
    let mut command = std::process::Command::new(&exe);
    apply_windows_utf8_env(&mut command);
    for key in [
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_MODEL",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "AIDER_MODEL",
        "AIDER_OPENAI_API_BASE",
        "CODEX_HOME",
        "GROK_HOME",
        "XMATRIX_GROK_MODEL",
        "XMATRIX_AGENT_IDENTITY_ID_OVERRIDE",
        "XMATRIX_AGENT_BACKEND",
        "XMATRIX_AGENT_NAME_OVERRIDE",
        "XMATRIX_AGENT_PRESET_ID",
        "XMATRIX_AUTO_JOIN_CHANNEL_ID",
        "XMATRIX_ACP",
        "XMATRIX_ACP_ARGS",
        "XMATRIX_ACTIVE_CHANNEL_DIR",
        "XMATRIX_CHANNEL_MIRROR_DIR",
        "XMATRIX_CLAUDE_PRINT",
        "XMATRIX_CODEX_APP",
        "XMATRIX_GROK_APP",
        "XMATRIX_ZCODE_APP",
        DAEMON_AUTH_CAPABILITY_ENV,
        DAEMON_AUTH_URL_ENV,
        DAEMON_REQUEST_CAPABILITY_ENV,
        DAEMON_REQUEST_URL_ENV,
        "XMATRIX_EXECUTION_KEY",
        "XMATRIX_HEADLESS",
        "XMATRIX_INITIAL_MESSAGE",
        "XMATRIX_INITIAL_MESSAGE_ATTACHMENTS_FILE",
        "XMATRIX_INITIAL_MESSAGE_ATTACHMENTS_JSON",
        "XMATRIX_INITIAL_MESSAGE_ID",
        "XMATRIX_LAUNCHER_ID",
        "XMATRIX_MATERIALIZER_ID",
        "XMATRIX_RESUME_REQUESTED",
        "XMATRIX_RESUME_INSTANCE_ID",
        "XMATRIX_RESUME_SESSION_KEY",
        "XMATRIX_HANDOFF_SESSION_DIR",
        "XMATRIX_INITIAL_CONTEXT_JSON",
        "XMATRIX_INITIAL_GOAL_JSON",
        "XMATRIX_RUN_ID",
        "XMATRIX_PROFILE",
        "XMATRIX_RUN_PROFILE_ID",
        run_worktree::RUN_WORKTREE_BASE_REF_ENV,
        run_worktree::SPAWN_WORKSPACE_MACHINE_ID_ENV,
        run_worktree::SPAWN_WORKSPACE_CWD_ENV,
        run_worktree::SPAWN_WORKSPACE_NAME_ENV,
        "XMATRIX_RUN_STATUS_FILE",
        runtime_wake_metrics::RUN_SPAWNED_AT_ENV,
        "XMATRIX_RUN_STDERR_LOG",
        "XMATRIX_RUN_STDOUT_LOG",
        "XMATRIX_SPAWN_CWD",
        "XMATRIX_SPAWN_RUNTIME",
        "XMATRIX_TOKEN",
        "XMATRIX_OWNER_USER_ID",
    ]
    .into_iter()
    .chain(RETIRED_ROLE_ENV)
    {
        command.env_remove(key);
    }
    command
        .arg(runtime)
        .args(&runtime_args)
        .current_dir(&workspace.canonical_cwd)
        .env("XMATRIX_HUB_URL", hub_url)
        .env_remove("XMATRIX_ENVIRONMENT")
        .env("XMATRIX_HEADLESS", "1")
        .env("XMATRIX_AGENT_NAME_OVERRIDE", agent_name)
        .env("XMATRIX_AGENT_NAME", agent_name)
        .env("XMATRIX_AUTO_JOIN_CHANNEL_ID", channel_id)
        .env("XMATRIX_INITIAL_MESSAGE", prompt)
        .env(
            "XMATRIX_INITIAL_MESSAGE_ID",
            source_message_id.unwrap_or_default(),
        )
        .env("XMATRIX_SPAWN_CWD", &workspace.canonical_cwd)
        .env("XMATRIX_SPAWN_RUNTIME", runtime)
        .stdin(std::process::Stdio::null())
        .stdout(daemon_run_log_stdio(
            run_files
                .as_ref()
                .map(|files| files.stdout_log_path.as_path()),
        ))
        .stderr(daemon_run_log_stdio(
            run_files
                .as_ref()
                .map(|files| files.stderr_log_path.as_path()),
        ));
    if let Some(profile) = config::active_profile_context() {
        command.env("XMATRIX_RUN_PROFILE_ID", profile.id.as_str());
    }
    if let Some(files) = run_files.as_ref() {
        command
            .env(
                "XMATRIX_RUN_STATUS_FILE",
                files.status_file_path.display().to_string(),
            )
            .env(
                "XMATRIX_RUN_STDOUT_LOG",
                files.stdout_log_path.display().to_string(),
            )
            .env(
                "XMATRIX_RUN_STDERR_LOG",
                files.stderr_log_path.display().to_string(),
            );
    }
    if let Some(path) = attachment_file.as_ref() {
        command.env("XMATRIX_INITIAL_MESSAGE_ATTACHMENTS_FILE", path);
    }
    if let Some(identity_id) = identity_id {
        command.env("XMATRIX_AGENT_IDENTITY_ID_OVERRIDE", identity_id);
        command.env("XMATRIX_AGENT_ID", identity_id);
    }
    if let Some(instance_id) = instance_id {
        command.env("XMATRIX_AGENT_INSTANCE_ID", instance_id);
    }
    if resume {
        command.env("XMATRIX_RESUME_REQUESTED", "1");
    }
    if let Some(resume_instance_id) = resume_instance_id {
        command.env("XMATRIX_RESUME_INSTANCE_ID", resume_instance_id);
    }
    if let Some(resume_session_key) = resume_session_key {
        command.env("XMATRIX_RESUME_SESSION_KEY", resume_session_key);
    }
    if let Some(source_session_key) = handoff_source_resume_session_key
        && let Some(dir) = materialize_handoff_session_snapshot(source_session_key) {
            command.env("XMATRIX_HANDOFF_SESSION_DIR", dir.display().to_string());
        }
    if goal.is_some()
        || initial_message_source.is_some()
        || requested_model.is_some()
        || requested_effort.is_some()
        || requested_parameters.is_some()
    {
        let context = InitialSpawnContext {
            requested_model: requested_model.map(str::to_owned),
            requested_effort: requested_effort.map(str::to_owned),
            requested_parameters: requested_parameters.cloned(),
            goal: goal.cloned(),
            initial_message_source: initial_message_source
                .filter(|source| {
                    source.channel_id == channel_id
                        && Some(source.message_id.as_str()) == source_message_id
                })
                .cloned(),
        };
        if let Ok(encoded) = serde_json::to_string(&context) {
            command.env(INITIAL_SPAWN_CONTEXT_ENV, encoded);
        }
    }
    if let Some(run_id) = run_id {
        command.env("XMATRIX_RUN_ID", run_id);
    }
    if let Some(launcher_id) = launcher_id {
        command.env("XMATRIX_LAUNCHER_ID", launcher_id);
    }
    if let Some(materializer_id) = materializer_id {
        command.env("XMATRIX_MATERIALIZER_ID", materializer_id);
    }
    apply_spawn_workspace_env(&mut command, routing_workspace, run_worktree_env);
    if let Some(execution_key) = execution_key {
        command.env("XMATRIX_EXECUTION_KEY", execution_key);
    }
    for key in &auto_update.remove_env {
        command.env_remove(key);
    }
    command.envs(&local_env);
    command.env_remove("XMATRIX_TOKEN");
    command.env(
        "XMATRIX_OWNER_USER_ID",
        &registration.key.owner_user_id,
    );
    if let Some(grant) = auth_grant.as_ref() {
        command
            .env(DAEMON_AUTH_URL_ENV, &grant.url)
            .env(DAEMON_AUTH_CAPABILITY_ENV, &grant.capability);
    } else {
        command.env_remove(DAEMON_AUTH_URL_ENV);
        command.env_remove(DAEMON_AUTH_CAPABILITY_ENV);
    }
    // A Git credential capability only exists once we know which repository this
    // run is for, and only for repositories a connector can actually speak for.
    // Runs without one keep whatever Git already did on this host.
    match git_credential_grant_for_spawn(
        auth_grant.as_ref(),
        repo_pool_binding,
        channel_id,
        run_id,
        execution_key,
    ) {
        Some(capability) => {
            command.env(git_credential::GIT_CREDENTIAL_CAPABILITY_ENV, capability);
        }
        None => {
            command.env_remove(git_credential::GIT_CREDENTIAL_CAPABILITY_ENV);
        }
    }
    if let (Some(broker), Some(grant)) = (request_broker.as_ref(), request_grant.as_ref()) {
        command
            .env(DAEMON_REQUEST_URL_ENV, &broker.url)
            .env(DAEMON_REQUEST_CAPABILITY_ENV, &grant.capability);
    } else {
        command.env_remove(DAEMON_REQUEST_URL_ENV);
        command.env_remove(DAEMON_REQUEST_CAPABILITY_ENV);
    }
    apply_agent_spawn_path(&mut command, &local_env);
    xmatrix_cli_agent::apply_agent_cli_binary(&mut command, &exe);
    match local_env.get("XMATRIX_AGENT_BACKEND").map(String::as_str) {
        Some("codex-app") => {
            command.env("XMATRIX_CODEX_APP", "1");
        }
        Some("claude-print") => {
            command.env("XMATRIX_CLAUDE_PRINT", "1");
        }
        Some("zcode-app") => {
            command.env("XMATRIX_ZCODE_APP", "1");
        }
        Some("grok-acp") => {
            command.env("XMATRIX_GROK_APP", "1");
        }
        Some(backend) if acp_backend_matches(backend) => {
            // Generic ACP (e.g. Kimi Code via `kimi acp`). The preset's
            // acpArgs already travel in local_env as XMATRIX_ACP_ARGS.
            command.env("XMATRIX_ACP", "1");
        }
        _ => {
            if is_codex_tool(runtime) {
                command.env("XMATRIX_CODEX_APP", "1");
            }
            if is_zcode_tool(runtime) {
                command.env("XMATRIX_ZCODE_APP", "1");
            }
            if is_grok_tool(runtime) {
                command.env("XMATRIX_GROK_APP", "1");
            }
            if daemon_spawn_uses_claude_print(runtime, &runtime_args) {
                command.env("XMATRIX_CLAUDE_PRINT", "1");
            }
        }
    }

    if let Some(sidecar) = provisional_sidecar.as_ref()
        && !persist_daemon_run_sidecar(sidecar)
    {
        return Err(CliError::Launch(
            "failed to persist repo pool pre-spawn sidecar".into(),
        ));
    }
    // This is the final online-authority fence before any local pool claim or
    // provider side effect. A reconnect or competing daemon has already
    // changed the shared epoch and must make this task fail closed.
    if !daemon_relay.owns_connection_epoch(daemon_epoch) {
        if let Some(sidecar) = provisional_sidecar.as_ref() {
            let _ = remove_daemon_run_sidecar(sidecar);
        }
        return Err(CliError::Launch(
            "daemon connection epoch changed before agent spawn".into(),
        ));
    }
    if let (Some(binding), Some(claim), Some(sidecar)) = (
        repo_pool_binding,
        repo_pool_spawn_claim,
        provisional_sidecar.as_ref(),
    ) {
        let exact_binding = binding.canonical_repo_identity == claim.canonical_repo_identity
            && binding.repo_key_id == claim.repo_key_id
            && binding.slot_id == claim.slot_id;
        if !exact_binding {
            let _ = remove_daemon_run_sidecar(sidecar);
            return Err(CliError::Launch(
                "repo pool pre-spawn authority mismatch".into(),
            ));
        }
        let layout = match daemon_repo_pool_layout(binding) {
            Ok(layout) => layout,
            Err(error) => {
                let _ = remove_daemon_run_sidecar(sidecar);
                return Err(error);
            }
        };
        if let Err(error) = repo_pool::claim_starting_lease_at(
            &layout,
            &claim.authority(),
            &claim.spawn_claim_token,
            Path::new(&workspace.canonical_cwd),
        )
        .await
        {
            let _ = remove_daemon_run_sidecar(sidecar);
            return Err(CliError::Launch(format!(
                "repo pool daemon claim rejected ({error})"
            )));
        }
    }
    #[cfg(windows)]
    let (mut run_bootstrap, run_bootstrap_nonce) =
        match (run_id, execution_key, instance_id, run_files.as_ref()) {
            (Some(_), Some(_), Some(_), Some(_)) => {
                let nonce = uuid::Uuid::new_v4().simple().to_string();
                let control = xmatrix_windows_continuity::InheritedControlPipe::create().map_err(
                    |error| {
                        CliError::Launch(format!("Run bootstrap pipe creation failed: {error}"))
                    },
                )?;
                (Some(control), Some(nonce))
            }
            _ => (None, None),
        };
    #[cfg(windows)]
    if let (Some(control), Some(nonce)) = (run_bootstrap.as_ref(), run_bootstrap_nonce.as_ref()) {
        control
            .child_handles()
            .map_err(|error| {
                CliError::Launch(format!(
                    "Run bootstrap child handles are unavailable: {error}"
                ))
            })?
            .apply(&mut command);
        command.env("XMATRIX_RUN_BOOTSTRAP_NONCE", nonce);
    }
    detach_daemon_child_process(&mut command);
    // Wake metrics measure the first response from this moment.
    command.env(
        runtime_wake_metrics::RUN_SPAWNED_AT_ENV,
        unix_millis_now().to_string(),
    );

    let child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            if let Some(sidecar) = provisional_sidecar.as_ref() {
                let _ = remove_daemon_run_sidecar(sidecar);
            }
            return Err(CliError::Launch(format!(
                "Failed to spawn headless agent: {err}"
            )));
        }
    };
    let spawned_at = daemon_event_at_rfc3339();
    #[cfg(windows)]
    if let Some(control) = run_bootstrap.as_mut() {
        control.release_child_handles();
    }
    // Do not bind the wrapper to a daemon-owned kill-on-close Job: automatic
    // daemon replacement must leave active runs alive. The wrapper owns its own
    // descendant lifetime guard, while this PID-backed tracker preserves exact
    // explicit stop/reborn cleanup and is intentionally inert when dropped.
    let mut process_tree = process_tree::track_detached_std_child(&child);
    let pid = child.id();
    #[cfg(windows)]
    let adoption_evidence = match (
        run_bootstrap.take(),
        run_bootstrap_nonce.as_deref(),
        run_id,
        execution_key,
        instance_id,
        run_files.as_ref(),
    ) {
        (
            Some(control),
            Some(nonce),
            Some(run_id),
            Some(execution_key),
            Some(instance_id),
            Some(files),
        ) => {
            match runtime_windows_run_adoption::authorize_spawned_wrapper(
                control,
                nonce,
                pid,
                run_id,
                execution_key,
                instance_id,
                &files.status_file_path,
            ) {
                Ok(evidence) => Some(evidence),
                Err(error) => {
                    let _ = process_tree.terminate();
                    return Err(error);
                }
            }
        }
        _ => None,
    };
    if let Some(sidecar) = provisional_sidecar.as_mut() {
        sidecar.pid = pid;
        sidecar.updated_at = config::unix_now_secs().to_string();
        if !persist_daemon_run_sidecar(sidecar) {
            let terminated = process_tree.terminate().is_ok();
            if terminated {
                let _ = remove_daemon_run_sidecar(sidecar);
            }
            return Err(CliError::Launch(if terminated {
                "failed to persist repo pool child sidecar; spawned process was terminated".into()
            } else {
                "failed to persist repo pool child sidecar and terminate the spawned process".into()
            }));
        }
    }
    Ok(SpawnedHeadlessAgent {
        child,
        process_tree,
        cwd: PathBuf::from(&workspace.canonical_cwd),
        run_id: run_id.map(str::to_string),
        execution_key: execution_key.map(str::to_string),
        instance_id: instance_id.map(str::to_string),
        resume_session_key: resume_session_key.map(str::to_string),
        repo_pool_binding: repo_pool_binding.cloned(),
        agent_id: identity_id.map(str::to_string),
        agent_name: agent_name.to_string(),
        spawned_at,
        pid,
        status_file_path: run_files
            .as_ref()
            .map(|files| files.status_file_path.clone()),
        stdout_log_path: run_files
            .as_ref()
            .map(|files| files.stdout_log_path.clone()),
        stderr_log_path: run_files
            .as_ref()
            .map(|files| files.stderr_log_path.clone()),
        #[cfg(windows)]
        adoption_evidence,
        _auth_grant: auth_grant,
        _request_grant: request_grant,
    })
}

async fn reclaim_worktree_storage_for_registry(run_registry: &DaemonRunRegistry) {
    let live_cwds: HashSet<PathBuf> = run_registry
        .lock()
        .await
        .values()
        .filter_map(|child| child.cwd.clone())
        .collect();
    let pool_liveness = live_repo_pool_state(run_registry).await;
    run_worktree::log_gc_outcome(
        &run_worktree::reclaim_worktree_storage_if_needed(&live_cwds, &pool_liveness).await,
    );
}
