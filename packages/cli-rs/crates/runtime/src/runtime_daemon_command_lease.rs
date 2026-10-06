// Daemon naming and the lease heartbeat that keeps a claimed daemon command alive.
fn build_daemon_name(host_id: &str) -> String {
    sanitize_agent_name(&format!("xmatrix-daemon-{host_id}"))
}

fn sanitize_agent_name(raw: &str) -> String {
    let sanitized: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();

    let trimmed = sanitized.trim_matches('-');
    let value = if trimmed.is_empty() {
        "xmatrix-agent"
    } else {
        trimmed
    };
    if value.len() > MAX_AGENT_NAME_LEN {
        value[..MAX_AGENT_NAME_LEN].to_string()
    } else {
        value.to_string()
    }
}

struct DaemonCommandLeaseHeartbeat {
    cancel_tx: Option<tokio::sync::oneshot::Sender<()>>,
    failure: Arc<Mutex<Option<String>>>,
    daemon_epoch: u64,
    hub_url: String,
    request_id: String,
    relay_lease: MachineDaemonCommandLease,
    requires_remote_confirmation: bool,
}

enum DaemonCommandLeaseRenewalError {
    FenceLost(String),
    Transient(String),
}

fn daemon_command_requires_final_remote_confirmation(
    initial_lease_renewed: bool,
    delivery: DaemonSpawnDelivery,
) -> bool {
    !initial_lease_renewed || delivery == DaemonSpawnDelivery::HttpFallback
}

impl std::fmt::Display for DaemonCommandLeaseRenewalError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FenceLost(message) | Self::Transient(message) => formatter.write_str(message),
        }
    }
}

async fn renew_daemon_command_lease_with_bounded_retry(
    hub_url: &str,
    machine_credential: &str,
    relay: &SharedMachineDaemonConnection,
    request_id: &str,
    relay_lease: &MachineDaemonCommandLease,
    phase: &str,
) -> error::Result<()> {
    let mut attempt = 0u32;
    loop {
        match renew_daemon_command_lease(
            hub_url,
            machine_credential,
            relay,
            request_id,
            relay_lease,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(DaemonCommandLeaseRenewalError::FenceLost(error)) => {
                return Err(CliError::Launch(error));
            }
            Err(DaemonCommandLeaseRenewalError::Transient(error)) => {
                let Some(delay) = initial_renew_retry_delay(attempt) else {
                    return Err(CliError::Launch(error));
                };
                eprintln!(
                    "{} command lease renewal failed transiently {phase}, retrying: {error}",
                    "⚠".yellow().bold(),
                );
                tokio::time::sleep(delay).await;
                if !relay.owns_connection_epoch(relay_lease.daemon_epoch) {
                    return Err(CliError::Launch(format!(
                        "daemon connection epoch changed {phase}",
                    )));
                }
                attempt += 1;
            }
        }
    }
}

impl DaemonCommandLeaseHeartbeat {
    async fn start(
        hub_url: &str,
        machine_credential: &str,
        relay: SharedMachineDaemonConnection,
        request_id: &str,
        relay_lease: &MachineDaemonCommandLease,
        initial_lease_renewed: bool,
        delivery: DaemonSpawnDelivery,
    ) -> error::Result<Self> {
        if !relay.owns_connection_epoch(relay_lease.daemon_epoch) {
            return Err(CliError::Launch(
                "command lease does not belong to this daemon connection epoch".into(),
            ));
        }
        // A lost fence fails the launch immediately, but a transport failure is
        // retried on a bounded schedule: the heartbeat below already tolerates
        // one, and a single blip at spawn time must not be the one thing that
        // kills the launch.
        if !initial_lease_renewed {
            renew_daemon_command_lease_with_bounded_retry(
                hub_url,
                machine_credential,
                &relay,
                request_id,
                relay_lease,
                "before launch",
            )
            .await?;
        }

        let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        let failure = Arc::new(Mutex::new(None));
        let task_failure = failure.clone();
        let task_hub_url = hub_url.to_string();
        let task_request_id = request_id.to_string();
        let task_relay_lease = relay_lease.clone();
        config::spawn_profile_task(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(
                DAEMON_COMMAND_LEASE_RENEW_INTERVAL_SECS,
            ));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // The initial synchronous renewal above owns the first interval.
            interval.tick().await;
            let mut last_success = Instant::now();
            loop {
                tokio::select! {
                    _ = &mut cancel_rx => return,
                    _ = interval.tick() => {
                        if !relay.owns_connection_epoch(task_relay_lease.daemon_epoch) {
                            set_daemon_command_lease_failure(
                                &task_failure,
                                "daemon connection epoch changed while executing the command".into(),
                            );
                            return;
                        }
                        let renewed = match relay.machine_credential() {
                            Ok(token) => renew_daemon_command_lease(
                                &task_hub_url,
                                &token,
                                &relay,
                                &task_request_id,
                                &task_relay_lease,
                            ).await,
                            Err(error) => Err(DaemonCommandLeaseRenewalError::FenceLost(
                                error.to_string(),
                            )),
                        };
                        match renewed {
                            Ok(()) => last_success = Instant::now(),
                            Err(DaemonCommandLeaseRenewalError::FenceLost(error)) => {
                                set_daemon_command_lease_failure(
                                    &task_failure,
                                    format!("command lease renewal lost its fence: {error}"),
                                );
                                return;
                            }
                            Err(DaemonCommandLeaseRenewalError::Transient(error))
                                if last_success.elapsed() >= Duration::from_secs(
                                DAEMON_COMMAND_LEASE_RENEW_FAILURE_WINDOW_SECS,
                            ) => {
                                set_daemon_command_lease_failure(
                                    &task_failure,
                                    format!("command lease renewal failed before its safety deadline: {error}"),
                                );
                                return;
                            }
                            Err(DaemonCommandLeaseRenewalError::Transient(error)) => {
                                eprintln!(
                                    "{} command lease renewal failed transiently: {error}",
                                    "⚠".yellow().bold(),
                                );
                            }
                        }
                    }
                }
            }
        });

        Ok(Self {
            cancel_tx: Some(cancel_tx),
            failure,
            daemon_epoch: relay_lease.daemon_epoch,
            hub_url: hub_url.to_string(),
            request_id: request_id.to_string(),
            relay_lease: relay_lease.clone(),
            // Socket delivery can rely on combined admission plus the local
            // connection epoch fence. HTTP fallback has no live socket signal,
            // so it must re-confirm PostgreSQL authority immediately before
            // Command::spawn. Legacy admission also needs that confirmation.
            requires_remote_confirmation: daemon_command_requires_final_remote_confirmation(
                initial_lease_renewed,
                delivery,
            ),
        })
    }

    fn ensure_locally_live(&self, relay: &SharedMachineDaemonConnection) -> error::Result<()> {
        if !relay.owns_connection_epoch(self.daemon_epoch) {
            return Err(CliError::Launch(
                "daemon connection epoch changed before provider launch".into(),
            ));
        }
        let failure = self
            .failure
            .lock()
            .map_err(|_| CliError::Launch("command lease heartbeat state is poisoned".into()))?;
        match failure.as_ref() {
            Some(error) => Err(CliError::Launch(error.clone())),
            None => Ok(()),
        }
    }

    async fn confirm_live(&self, relay: &SharedMachineDaemonConnection) -> error::Result<()> {
        self.ensure_locally_live(relay)?;
        if !self.requires_remote_confirmation {
            return Ok(());
        }
        let token = relay.machine_credential()?;
        renew_daemon_command_lease_with_bounded_retry(
            &self.hub_url,
            &token,
            relay,
            &self.request_id,
            &self.relay_lease,
            "immediately before provider launch",
        )
        .await?;
        self.ensure_locally_live(relay)
    }
}

impl Drop for DaemonCommandLeaseHeartbeat {
    fn drop(&mut self) {
        if let Some(cancel_tx) = self.cancel_tx.take() {
            let _ = cancel_tx.send(());
        }
    }
}

fn set_daemon_command_lease_failure(failure: &Arc<Mutex<Option<String>>>, error: String) {
    if let Ok(mut slot) = failure.lock()
        && slot.is_none() {
            *slot = Some(error);
        }
}
