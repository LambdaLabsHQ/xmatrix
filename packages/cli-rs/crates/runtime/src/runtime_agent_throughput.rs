//! Real output-token throughput. Claude supplies API time; Codex supplies
//! exact token counters and lifecycle events, so its tool intervals are
//! removed from turn time. Unknown/malformed/failed turns produce no sample.
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde_json::Value;
use xmatrix_harness::usage::AgentThroughputObservation;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Scope {
    model: String,
    effort: Option<String>,
}

struct Turn {
    id: String,
    started: u64,
    baseline: Option<u64>,
    output: Option<u64>,
    tools: HashSet<String>,
    paused_at: Option<u64>,
    paused_ms: u64,
    valid: bool,
}

struct Sample {
    output: u64,
    inference_ms: u64,
    at: u64,
}

#[derive(Default)]
struct Observer {
    scope: Option<Scope>,
    thread: Option<String>,
    turns: HashMap<String, Turn>,
    totals: HashMap<String, u64>,
    samples: VecDeque<Sample>,
    last_claude_result: Option<String>,
}

impl Observer {
    fn bind_thread(&mut self, thread: Option<&str>) {
        self.thread = thread
            .filter(|thread| !thread.is_empty() && thread.len() <= 256)
            .map(str::to_string);
        self.turns.clear();
        self.totals.clear();
    }

    fn scope(&mut self, model: Option<&str>, effort: Option<&str>) {
        let Some(model) = model.filter(|model| !model.is_empty()) else {
            return;
        };
        if model.len() > 160 || effort.is_some_and(|effort| effort.is_empty() || effort.len() > 80)
        {
            self.scope = None;
            self.samples.clear();
            self.turns.clear();
            return;
        }
        let scope = Scope {
            model: model.to_string(),
            effort: effort.map(str::to_string),
        };
        if self.scope.as_ref() != Some(&scope) {
            self.scope = Some(scope);
            self.samples.clear();
            // A change mid-turn cannot attribute that turn to either model.
            self.turns.clear();
        }
    }

    fn push(&mut self, output: u64, inference_ms: u64, at: u64) {
        if self.scope.is_none()
            || output < 32
            || !(100..=600_000).contains(&inference_ms)
            || output > 100_000_000
            || output as f64 / inference_ms as f64 > 1000.0
        {
            return;
        }
        while self
            .samples
            .front()
            .is_some_and(|sample| at.saturating_sub(sample.at) > 1_800_000)
        {
            self.samples.pop_front();
        }
        if self.samples.len() == 8 {
            self.samples.pop_front();
        }
        self.samples.push_back(Sample {
            output,
            inference_ms,
            at,
        });
    }

    fn observation(&self) -> Option<AgentThroughputObservation> {
        let scope = self.scope.as_ref()?;
        let latest = self.samples.back()?;
        let at = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(latest.at) * 1_000_000)
            .ok()?;
        Some(AgentThroughputObservation {
            model: scope.model.clone(),
            effort: scope.effort.clone(),
            observed_at: at
                .format(&time::format_description::well_known::Rfc3339)
                .ok()?,
            output_tokens: self.samples.iter().map(|sample| sample.output).sum(),
            inference_ms: self.samples.iter().map(|sample| sample.inference_ms).sum(),
            samples: self.samples.len() as u64,
        })
    }

    fn claude(&mut self, value: &Value, at: u64) {
        if value.get("type").and_then(Value::as_str) != Some("result")
            || crate::runtime_claude_turn::claude_result_is_cli_originated(value)
            || value.get("is_error").and_then(Value::as_bool) == Some(true)
            || value.get("subtype").and_then(Value::as_str) != Some("success")
        {
            return;
        }
        if value
            .get("modelUsage")
            .and_then(Value::as_object)
            .is_some_and(|models| {
                models.len() != 1
                    || !self
                        .scope
                        .as_ref()
                        .is_some_and(|scope| models.contains_key(&scope.model))
            })
        {
            return;
        }
        let Some(id) = value.get("uuid").and_then(Value::as_str) else {
            return;
        };
        if id.len() > 256 {
            return;
        }
        if self.last_claude_result.as_deref() == Some(id) {
            return;
        }
        self.last_claude_result = Some(id.to_string());
        if let (Some(output), Some(duration)) = (
            value
                .pointer("/usage/output_tokens")
                .and_then(Value::as_u64),
            value.get("duration_api_ms").and_then(Value::as_u64),
        ) {
            self.push(output, duration, at);
        }
    }

    fn codex(&mut self, value: &Value, now: u64, at: u64) {
        let Some(method) = value.get("method").and_then(Value::as_str) else {
            return;
        };
        let Some(params) = value.get("params") else {
            return;
        };
        let Some(thread) = params.get("threadId").and_then(Value::as_str) else {
            return;
        };
        if self.thread.as_deref() != Some(thread) {
            return;
        }
        let id = params
            .get("turnId")
            .or_else(|| params.pointer("/turn/id"))
            .and_then(Value::as_str);
        if id.is_some_and(|id| id.len() > 256) {
            return;
        }
        match method {
            "turn/started" => {
                let Some(id) = id else {
                    return;
                };
                if self.turns.len() >= 8 {
                    self.turns.clear();
                }
                self.turns.insert(
                    thread.to_string(),
                    Turn {
                        id: id.to_string(),
                        started: now,
                        baseline: self.totals.get(thread).copied(),
                        output: None,
                        tools: HashSet::new(),
                        paused_at: None,
                        paused_ms: 0,
                        valid: self.scope.is_some(),
                    },
                );
            }
            "thread/tokenUsage/updated" => {
                let Some(total) = params
                    .pointer("/tokenUsage/total/outputTokens")
                    .and_then(Value::as_u64)
                else {
                    return;
                };
                if self.totals.len() >= 16 && !self.totals.contains_key(thread) {
                    self.totals.clear();
                }
                self.totals.insert(thread.to_string(), total);
                let Some(turn) = self
                    .turns
                    .get_mut(thread)
                    .filter(|turn| Some(turn.id.as_str()) == id)
                else {
                    return;
                };
                if turn.baseline.is_none() {
                    turn.baseline = params
                        .pointer("/tokenUsage/last/outputTokens")
                        .and_then(Value::as_u64)
                        .and_then(|last| total.checked_sub(last));
                }
                turn.output = turn
                    .baseline
                    .and_then(|baseline| total.checked_sub(baseline));
                if turn.output.is_none() {
                    turn.valid = false;
                }
            }
            "item/started" | "item/completed" => {
                let Some(turn) = self
                    .turns
                    .get_mut(thread)
                    .filter(|turn| Some(turn.id.as_str()) == id)
                else {
                    return;
                };
                let Some(kind) = params.pointer("/item/type").and_then(Value::as_str) else {
                    return;
                };
                if !matches!(
                    kind,
                    "commandExecution"
                        | "fileChange"
                        | "mcpToolCall"
                        | "dynamicToolCall"
                        | "webSearch"
                        | "imageGeneration"
                        | "collabAgentToolCall"
                ) {
                    return;
                }
                let Some(item) = params.pointer("/item/id").and_then(Value::as_str) else {
                    turn.valid = false;
                    return;
                };
                if item.len() > 256 {
                    turn.valid = false;
                    return;
                }
                if method == "item/started" {
                    if turn.tools.len() >= 64 {
                        turn.valid = false;
                        return;
                    }
                    if turn.tools.is_empty() {
                        turn.paused_at = Some(now);
                    }
                    turn.tools.insert(item.to_string());
                } else {
                    if !turn.tools.remove(item) {
                        // A completion with a missing start leaves inference time unknown.
                        turn.valid = false;
                    } else if turn.tools.is_empty() {
                        turn.paused_ms = turn.paused_ms.saturating_add(
                            now.saturating_sub(turn.paused_at.take().unwrap_or(now)),
                        );
                    }
                }
            }
            "turn/completed" => {
                if self
                    .turns
                    .get(thread)
                    .is_none_or(|turn| Some(turn.id.as_str()) != id)
                {
                    return;
                }
                let turn = self.turns.remove(thread).unwrap();
                if turn.valid
                    && turn.tools.is_empty()
                    && params.pointer("/turn/status").and_then(Value::as_str) == Some("completed")
                    && let Some(output) = turn.output
                {
                    self.push(
                        output,
                        now.saturating_sub(turn.started)
                            .saturating_sub(turn.paused_ms),
                        at,
                    );
                }
            }
            _ => {}
        }
    }
}

fn observer() -> &'static Mutex<Observer> {
    static OBSERVER: OnceLock<Mutex<Observer>> = OnceLock::new();
    OBSERVER.get_or_init(|| Mutex::new(Observer::default()))
}

/// The app session, not a provider notification, identifies its main thread.
pub(crate) fn bind_thread(thread: Option<&str>) {
    if cfg!(test) {
        return;
    }
    observer()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .bind_thread(thread);
}

pub(crate) fn record_provider(value: &Value) {
    if cfg!(test) {
        return;
    }
    static START: OnceLock<Instant> = OnceLock::new();
    let now = START.get_or_init(Instant::now).elapsed().as_millis() as u64;
    observer()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .codex(value, now, crate::unix_millis_now());
}

pub(crate) fn record_claude(value: &Value) {
    if cfg!(test) {
        return;
    }
    observer()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .claude(value, crate::unix_millis_now());
}

pub(crate) fn decorate(presentation: &mut crate::AgentPresentationSnapshot) {
    if cfg!(test) {
        return;
    }
    let mut observer = observer()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    observer.scope(
        presentation.model.as_deref(),
        presentation.effort.as_deref(),
    );
    if let Some(usage) = presentation.usage.as_mut() {
        usage.throughput = observer.observation();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn observer() -> Observer {
        let mut observer = Observer::default();
        observer.scope(Some("model-a"), Some("high"));
        observer.bind_thread(Some("thread"));
        observer
    }

    fn event(method: &str, extra: Value) -> Value {
        let mut params = json!({"threadId":"thread", "turnId":"turn"});
        params
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        json!({"method":method,"params":params})
    }

    fn usage(total: u64, last: u64) -> Value {
        event(
            "thread/tokenUsage/updated",
            json!({"tokenUsage":{
            "total":{"outputTokens":total}, "last":{"outputTokens":last}}}),
        )
    }

    fn tool(method: &str, id: &str, kind: &str) -> Value {
        event(method, json!({"item":{"id":id,"type":kind}}))
    }

    fn done(status: &str) -> Value {
        event(
            "turn/completed",
            json!({"turn":{"id":"turn","status":status}}),
        )
    }

    #[test]
    fn codex_child_thread_events_never_become_main_model_throughput() {
        let mut observer = observer();
        for (method, extra, at) in [
            ("turn/started", json!({}), 0),
            (
                "thread/tokenUsage/updated",
                json!({"tokenUsage":{"total":{"outputTokens":8000},"last":{"outputTokens":8000}}}),
                1000,
            ),
            (
                "turn/completed",
                json!({"turn":{"id":"turn","status":"completed"}}),
                2000,
            ),
        ] {
            let mut value = event(method, extra);
            value["params"]["threadId"] = json!("child-thread");
            observer.codex(&value, at, at + 1000);
        }
        assert!(observer.observation().is_none());
        assert!(observer.turns.is_empty());
        assert!(observer.totals.is_empty());
    }

    #[test]
    fn codex_uses_actual_token_delta_and_excludes_overlapping_tool_time_once() {
        let mut observer = observer();
        observer.codex(&usage(1000, 1000), 0, 1000); // historical session counter
        observer.codex(
            &event("turn/started", json!({"turn":{"id":"turn"}})),
            100,
            1100,
        );
        observer.codex(
            &tool("item/started", "tool-a", "commandExecution"),
            1100,
            2100,
        );
        observer.codex(&tool("item/started", "tool-b", "fileChange"), 2100, 3100);
        observer.codex(
            &tool("item/completed", "tool-a", "commandExecution"),
            3100,
            4100,
        );
        observer.codex(
            &tool("item/completed", "tool-b", "fileChange"),
            10100,
            11100,
        );
        observer.codex(&usage(1240, 240), 11100, 12100);
        observer.codex(&usage(1240, 240), 11101, 12101); // replay is not extra tokens
        observer.codex(&done("completed"), 12100, 13100);
        observer.codex(&done("completed"), 12101, 13101);
        let sample = observer.observation().unwrap();
        assert_eq!(
            (sample.output_tokens, sample.inference_ms, sample.samples),
            (240, 3000, 1)
        );
        assert_eq!(sample.model, "model-a");
        assert_eq!(sample.effort.as_deref(), Some("high"));
    }

    #[test]
    fn first_codex_turn_uses_last_usage_but_failed_or_incomplete_turns_are_unknown() {
        for failure in [
            "failed",
            "counter_reset",
            "missing_tool_start",
            "missing_usage",
            "model_change",
        ] {
            let mut observer = observer();
            observer.codex(&event("turn/started", json!({})), 0, 1000);
            if failure != "missing_usage" {
                observer.codex(&usage(5000, 120), 2000, 3000);
            }
            match failure {
                "counter_reset" => observer.codex(&usage(10, 10), 2100, 3100),
                "missing_tool_start" => observer.codex(
                    &tool("item/completed", "lost", "commandExecution"),
                    2100,
                    3100,
                ),
                "model_change" => observer.scope(Some("model-b"), Some("high")),
                _ => {}
            }
            observer.codex(
                &done(if failure == "failed" {
                    "failed"
                } else {
                    "completed"
                }),
                3000,
                4000,
            );
            assert!(observer.observation().is_none(), "{failure}");
        }
        let mut observer = observer();
        observer.codex(&event("turn/started", json!({})), 0, 1000);
        observer.codex(&usage(5000, 120), 2000, 3000);
        observer.codex(&done("completed"), 3000, 4000);
        assert_eq!(observer.observation().unwrap().output_tokens, 120);
    }

    #[test]
    fn claude_uses_api_duration_not_total_tool_time_and_never_refreshes_an_old_reading() {
        let mut observer = observer();
        let result = json!({"type":"result","subtype":"success","uuid":"result-1",
            "duration_ms":100_000,"duration_api_ms":2000,"usage":{"output_tokens":160}});
        observer.claude(&result, 5000);
        let first = observer.observation().unwrap();
        assert_eq!((first.output_tokens, first.inference_ms), (160, 2000));
        observer.claude(&result, 9000);
        let repeated = observer.observation().unwrap();
        assert_eq!(repeated.samples, 1);
        assert_eq!(repeated.observed_at, first.observed_at);
        observer.scope(Some("model-a"), Some("low"));
        assert!(
            observer.observation().is_none(),
            "efforts never share an aggregate"
        );
        observer.claude(
            &json!({"type":"result","subtype":"success","uuid":"result-2",
            "duration_ms":100_000,"usage":{"output_tokens":160}}),
            10000,
        );
        assert!(
            observer.observation().is_none(),
            "wall time cannot stand in for API time"
        );
    }

    #[test]
    fn throughput_window_is_bounded_and_mixed_model_or_error_results_do_not_enter_it() {
        let mut observer = observer();
        for index in 0..12 {
            observer.push(80, 1000, index * 1000);
        }
        assert_eq!(observer.observation().unwrap().samples, 8);
        observer.push(120, 2000, 2_000_000);
        assert_eq!(observer.observation().unwrap().samples, 1);
        for extra in [
            json!({"is_error":true}),
            json!({"modelUsage":{"model-b":{}}}),
            json!({"modelUsage":{"model-a":{},"model-b":{}}}),
        ] {
            let mut result = json!({"type":"result","subtype":"success","uuid":"bad",
                "duration_api_ms":2000,"usage":{"output_tokens":160}});
            result
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            observer.claude(&result, 2_001_000);
        }
        assert_eq!(observer.observation().unwrap().samples, 1);
    }
}
