// Native settings bindings are discovered from the installed app-server schema.
impl CodexAppSession {
    fn install_parameter_schemas(
        &mut self,
        schemas: crate::harness_parameters::CodexParameterSchemas,
    ) {
        self.native_parameter_schema = schemas.turn;
        self.native_settings_schema = schemas.settings;
        self.settings_update_supported = schemas.settings_update;
        self.schema_parameters =
            crate::harness_parameters::schema_parameters(&self.native_parameter_schema);
    }

    fn observe_parameter_snapshot(&mut self, snapshot: &Value) {
        let Some(object) = snapshot.as_object() else {
            return;
        };
        for (id, value) in object {
            if id == "serviceTier"
                && (value.is_null() || value.as_str().is_some_and(|v| v.len() <= 160))
                || crate::harness_parameters::parameter_id(id)
                    && self.schema_parameters.iter().any(|p| p.id == *id)
                    && (value.is_null()
                        || self
                            .schema_parameters
                            .iter()
                            .any(|p| p.id == *id && self.parameter_value_supported(p, value)))
            {
                self.observed_parameters.insert(id.clone(), value.clone());
            }
        }
    }

    fn observe_parameter_notification(&mut self, message: &Value) -> bool {
        if message.get("method").and_then(Value::as_str) != Some("thread/settings/updated") {
            return false;
        }
        if message.pointer("/params/threadId").and_then(Value::as_str) == self.thread_id.as_deref()
            && self.thread_id.is_some()
            && let Some(snapshot) = message
                .pointer("/params/threadSettings")
                .filter(|v| v.is_object())
        {
            self.observed_parameters.clear();
            self.observe_parameter_snapshot(snapshot);
            self.settings_revision = self.settings_revision.saturating_add(1);
        }
        true
    }

    fn native_setting_confirmed(&self, id: &str, value: &Value) -> bool {
        self.observed_parameters.get(id).is_some_and(|observed| {
            observed == value
                || id == "serviceTier" && value.is_null() && observed.as_str() == Some("default")
        })
    }

    async fn apply_selected_settings(&mut self, model: Option<&str>) -> Result<(), String> {
        if !self.settings_update_supported {
            return Ok(());
        }
        if self.settings_uncertain {
            return Err("Native parameter state is unconfirmed".into());
        }
        // Consume already queued observations before establishing the request's
        // confirmation boundary. Preserve unrelated provider events for turns.
        for _ in 0..128 {
            let Some(message) = self.inbox.try_recv() else {
                break;
            };
            self.observe_graceful_interrupt(&message);
            if !self.observe_parameter_notification(&message) {
                self.inbox.defer(message).map_err(|e| e.to_string())?;
            }
        }
        let mut settings: serde_json::Map<String, Value> = self
            .selected_parameters
            .iter()
            .filter(|(id, _)| {
                self.native_settings_schema
                    .pointer(&format!("/properties/{id}"))
                    .is_some()
            })
            .filter(|(id, value)| !self.native_setting_confirmed(id, value))
            .map(|(id, value)| (id.clone(), value.clone()))
            .collect();
        if self.reset_service_tier && !self.native_setting_confirmed("serviceTier", &Value::Null) {
            settings.insert("serviceTier".into(), Value::Null);
        }
        if settings.is_empty() {
            self.reset_service_tier = false;
            return Ok(());
        }
        let thread_id = self
            .thread_id
            .clone()
            .ok_or("Provider thread is unavailable")?;
        let revision = self.settings_revision;
        // Codex omits unchanged settings notifications, and start/resume does
        // not expose every scalar setting. Its RPC success only queues the op.
        // Unknown old values may therefore remain pending without being unsafe;
        // do not invent an observation or close a healthy unchanged session.
        let unknown_only = !self.reset_service_tier
            && settings
                .keys()
                .all(|id| id != "serviceTier" && !self.observed_parameters.contains_key(id));
        let confirmation_window = if unknown_only {
            Duration::from_millis(500)
        } else {
            Duration::from_secs(10)
        };
        let mut params = settings.clone();
        params.insert("threadId".into(), Value::String(thread_id));
        if let Some(model) = model {
            params.insert("model".into(), Value::String(model.into()));
        }
        let outcome = async {
            self.request("thread/settings/update", Value::Object(params))
                .await
                .map_err(|e| e.to_string())?;
            tokio::time::timeout(confirmation_window, async {
                loop {
                    if self.settings_revision > revision {
                        return if settings
                            .iter()
                            .all(|(id, value)| self.native_setting_confirmed(id, value))
                        {
                            Ok(())
                        } else {
                            Err("Provider did not confirm the requested parameter values".into())
                        };
                    }
                    let message = self
                        .inbox
                        .recv()
                        .await
                        .ok_or_else(|| self.inbox.error().to_string())?;
                    self.observe_graceful_interrupt(&message);
                    if !self.observe_parameter_notification(&message) {
                        self.inbox.defer(message).map_err(|e| e.to_string())?;
                    }
                }
            })
            .await
            .unwrap_or_else(|_| {
                if unknown_only {
                    Ok(())
                } else {
                    Err("Provider did not report a fresh settings confirmation".into())
                }
            })
        }
        .await;
        if outcome.is_err() {
            self.settings_uncertain = true;
            self.observed_parameters.clear();
            self.shutdown().await;
        } else {
            self.reset_service_tier = false;
        }
        outcome
    }

    async fn apply_parameter(
        &mut self,
        parameters: &[protocol::HarnessParameter],
        model: Option<&str>,
        id: &str,
        value: &str,
    ) -> Result<String, String> {
        let previous = self.selected_parameters.clone();
        self.select_parameter(parameters, model, id, value)?;
        if let Err(error) = self.apply_selected_settings(model).await {
            self.selected_parameters = previous;
            return Err(error);
        }
        let binding = if id == "fast" { "serviceTier" } else { id };
        let applied = self
            .selected_parameters
            .get(binding)
            .is_some_and(|value| self.native_setting_confirmed(binding, value));
        Ok(if applied {
            format!("{id}: {value}")
        } else if self.settings_update_supported {
            format!("Selected {id}: {value}; provider has not reported its current value")
        } else {
            format!(
                "Selected {id}: {value} for subsequent turns (provider lacks immediate settings control)"
            )
        })
    }
}
