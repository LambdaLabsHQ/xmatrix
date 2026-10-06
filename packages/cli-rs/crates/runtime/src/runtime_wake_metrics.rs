//! Per-harness wake metrics (docs/instance-sleep.md §8).
//!
//! The wrapper observes its provider's own stream and keeps one `wake` block in
//! its status sidecar: the harness, whether the Run resumed a session, when the
//! daemon spawned it, when the first model output of its first turn arrived,
//! the tokens that first turn consumed, and how many times the provider
//! compacted its context. The daemon turns that block into one JSONL record
//! when the Run ends (sleeps, exits or is stopped) and classifies it as a
//! `wake` (a resumed Run whose predecessor on this machine slept), a `resume`
//! (any other resumed Run) or a `cold` start. `xmatrix daemon wake-metrics`
//! aggregates the records per harness.
//!
//! Only counts, durations, timestamps and hashed keys are recorded: never
//! message text, tool input, model output, session ids or credentials.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use xmatrix_cli_core::hex::lowercase_hex;

/// Set by the daemon on every wrapper it spawns: the spawn time in Unix ms.
pub(crate) const RUN_SPAWNED_AT_ENV: &str = "XMATRIX_RUN_SPAWNED_AT_MILLIS";

const METRICS_FILE: &str = "wake-metrics.jsonl";
/// The active file rotates to `<file>.1` past this size; the previous `.1` is
/// dropped. At most twice this many bytes are ever kept.
pub(crate) const METRICS_FILE_MAX_BYTES: u64 = 512 * 1024;
/// Distinct turns whose compactions are kept apart for de-duplication.
const COMPACTION_TURNS_TRACKED: usize = 64;
const RECORD_SCHEMA_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Sidecar block (written by the wrapper)
// ---------------------------------------------------------------------------

/// The wrapper's wake facts, persisted as `wake` in its status sidecar.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunWakeMetrics {
    /// `claude_code`, `codex`, `grok`, or the runtime id the daemon spawned.
    pub harness: String,
    /// The daemon asked this Run to resume a saved session.
    pub resumed: bool,
    /// The Run started with input (a summon, a waking message, or a resume
    /// continuation), so its first turn began at spawn.
    pub started_with_input: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub spawned_at_millis: Option<u64>,
    /// First model output of the first turn (see `docs/instance-sleep.md` §8).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub first_response_at_millis: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub first_turn: Option<FirstTurnUsage>,
    /// Context compactions the provider reported during the Run; `None` when
    /// the harness does not report compactions.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub compactions: Option<u32>,
}

/// Tokens the first turn consumed, as the provider reported them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FirstTurnUsage {
    /// Input tokens that were neither read from nor written to a prompt cache.
    pub input_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cache_read_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cache_creation_input_tokens: Option<u64>,
    /// Every input token the provider processed: uncached + cache read +
    /// cache creation.
    pub total_input_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub output_tokens: Option<u64>,
}

/// The harness name recorded for a wrapper runtime id.
pub(crate) fn harness_for_runtime(runtime: &str) -> String {
    match runtime.trim().to_ascii_lowercase().as_str() {
        "claude" | "claude_code" | "claude-code" => "claude_code".into(),
        "" => "other".into(),
        other => other.chars().take(32).collect(),
    }
}

// ---------------------------------------------------------------------------
// Observer (pure state machine over provider frames)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct CodexTokens {
    input: u64,
    cached: u64,
    cache_write: u64,
    output: u64,
}

impl CodexTokens {
    fn parse(value: &Value) -> Option<Self> {
        let field = |name: &str| value.get(name).and_then(Value::as_u64);
        Some(Self {
            input: field("inputTokens")?,
            cached: field("cachedInputTokens").unwrap_or(0),
            cache_write: field("cacheWriteInputTokens").unwrap_or(0),
            output: field("outputTokens").unwrap_or(0),
        })
    }

    fn minus(self, earlier: Self) -> Self {
        Self {
            input: self.input.saturating_sub(earlier.input),
            cached: self.cached.saturating_sub(earlier.cached),
            cache_write: self.cache_write.saturating_sub(earlier.cache_write),
            output: self.output.saturating_sub(earlier.output),
        }
    }

    /// Codex reports `inputTokens` including its cached part.
    fn usage(self) -> FirstTurnUsage {
        FirstTurnUsage {
            input_tokens: self.input.saturating_sub(self.cached),
            cache_read_input_tokens: Some(self.cached),
            cache_creation_input_tokens: (self.cache_write > 0).then_some(self.cache_write),
            total_input_tokens: self.input.saturating_add(self.cache_write),
            output_tokens: Some(self.output),
        }
    }
}

/// Accumulates one Run's wake facts from its provider's frames.
#[derive(Debug)]
pub(crate) struct WakeObserver {
    metrics: RunWakeMetrics,
    /// Codex: the first turn's id and the cumulative usage before it.
    codex_first_turn: Option<String>,
    codex_last_total: Option<CodexTokens>,
    codex_baseline: Option<CodexTokens>,
    /// Codex reports one compaction twice on some versions (the deprecated
    /// `thread/compacted` and the `contextCompaction` item); per turn the
    /// larger of the two counts is the number of compactions.
    codex_compactions: VecDeque<(String, (u32, u32))>,
    codex_compactions_folded: u32,
    /// ACP: a prompt was sent, so session updates are this Run's output rather
    /// than a `session/load` history replay.
    acp_prompt_sent: bool,
}

impl WakeObserver {
    pub(crate) fn new(
        harness: String,
        resumed: bool,
        started_with_input: bool,
        spawned_at_millis: Option<u64>,
    ) -> Self {
        Self {
            metrics: RunWakeMetrics {
                harness,
                resumed,
                started_with_input,
                spawned_at_millis,
                ..RunWakeMetrics::default()
            },
            codex_first_turn: None,
            codex_last_total: None,
            codex_baseline: None,
            codex_compactions: VecDeque::new(),
            codex_compactions_folded: 0,
            acp_prompt_sent: false,
        }
    }

    pub(crate) fn metrics(&self) -> &RunWakeMetrics {
        &self.metrics
    }

    fn first_response(&mut self, now_millis: u64) -> bool {
        if self.metrics.first_response_at_millis.is_some() {
            return false;
        }
        self.metrics.first_response_at_millis = Some(now_millis);
        true
    }

    /// One Claude stream-json frame of the main agent (subagent frames are
    /// filtered out before this). Returns whether anything changed.
    pub(crate) fn observe_claude(&mut self, frame: &Value, now_millis: u64) -> bool {
        let frame_type = frame.get("type").and_then(Value::as_str);
        let subtype = frame.get("subtype").and_then(Value::as_str);
        match frame_type {
            Some("system") if subtype == Some("compact_boundary") => {
                self.metrics.compactions = Some(self.metrics.compactions.unwrap_or(0) + 1);
                true
            }
            Some("assistant" | "stream_event") => self.first_response(now_millis),
            Some("result") if self.metrics.first_turn.is_none() => {
                // A turn Claude started by itself (a finished background task)
                // is not the Run's first turn.
                if crate::runtime_claude_turn::claude_result_is_cli_originated(frame) {
                    return false;
                }
                let Some(usage) = frame.get("usage") else {
                    return false;
                };
                let field = |name: &str| usage.get(name).and_then(Value::as_u64);
                let Some(input) = field("input_tokens") else {
                    return false;
                };
                let cache_read = field("cache_read_input_tokens");
                let cache_creation = field("cache_creation_input_tokens");
                self.metrics.first_turn = Some(FirstTurnUsage {
                    input_tokens: input,
                    cache_read_input_tokens: cache_read,
                    cache_creation_input_tokens: cache_creation,
                    total_input_tokens: input
                        .saturating_add(cache_read.unwrap_or(0))
                        .saturating_add(cache_creation.unwrap_or(0)),
                    output_tokens: field("output_tokens"),
                });
                true
            }
            _ => false,
        }
    }

    /// The ACP client sent `session/prompt`.
    pub(crate) fn note_acp_prompt_sent(&mut self) {
        self.acp_prompt_sent = true;
    }

    /// One message from a Codex app-server or ACP provider. Returns whether
    /// anything changed.
    pub(crate) fn observe_provider(&mut self, message: &Value, now_millis: u64) -> bool {
        let params = message.get("params").unwrap_or(&Value::Null);
        match message.get("method").and_then(Value::as_str) {
            Some("session/update") => self.observe_acp_update(params, now_millis),
            Some(method) => self.observe_codex(method, params, now_millis),
            None => self.observe_acp_response(message),
        }
    }

    fn observe_codex(&mut self, method: &str, params: &Value, now_millis: u64) -> bool {
        let turn_id = params
            .get("turnId")
            .or_else(|| params.pointer("/turn/id"))
            .and_then(Value::as_str);
        let item_type = params.pointer("/item/type").and_then(Value::as_str);
        match method {
            "turn/started" => {
                if self.codex_first_turn.is_none() {
                    self.codex_first_turn = Some(turn_id.unwrap_or_default().to_string());
                    self.codex_baseline = self.codex_last_total;
                    // A Codex harness reports compactions; start counting.
                    self.metrics.compactions.get_or_insert(0);
                    return true;
                }
                false
            }
            "thread/tokenUsage/updated" => {
                let Some(total) = params
                    .pointer("/tokenUsage/total")
                    .and_then(CodexTokens::parse)
                else {
                    return false;
                };
                let last = params
                    .pointer("/tokenUsage/last")
                    .and_then(CodexTokens::parse);
                self.codex_last_total = Some(total);
                if turn_id.is_none() || self.codex_first_turn.as_deref() != turn_id {
                    return false;
                }
                // Without a usage snapshot from before the turn, the turn's
                // first update carries the only request it contains so far.
                let baseline = *self
                    .codex_baseline
                    .get_or_insert_with(|| last.map(|last| total.minus(last)).unwrap_or_default());
                let usage = total.minus(baseline).usage();
                if self.metrics.first_turn.as_ref() == Some(&usage) {
                    return false;
                }
                self.metrics.first_turn = Some(usage);
                true
            }
            "thread/compacted" => self.codex_compaction(turn_id, false),
            "item/completed" if item_type == Some("contextCompaction") => {
                self.codex_compaction(turn_id, true)
            }
            _ if self.codex_first_turn.is_some()
                && (method.starts_with("item/") || method.starts_with("rawResponseItem/"))
                && !matches!(item_type, Some("userMessage" | "contextCompaction")) =>
            {
                self.first_response(now_millis)
            }
            _ => false,
        }
    }

    fn codex_compaction(&mut self, turn_id: Option<&str>, item: bool) -> bool {
        let key = turn_id.unwrap_or_default();
        let index = match self
            .codex_compactions
            .iter()
            .position(|(turn, _)| turn == key)
        {
            Some(index) => index,
            None => {
                // The oldest turn's count folds into the total once the
                // window is full.
                if self.codex_compactions.len() >= COMPACTION_TURNS_TRACKED
                    && let Some((_, (items, notices))) = self.codex_compactions.pop_front()
                {
                    self.codex_compactions_folded += items.max(notices);
                }
                self.codex_compactions.push_back((key.to_string(), (0, 0)));
                self.codex_compactions.len() - 1
            }
        };
        let counts = &mut self.codex_compactions[index].1;
        if item {
            counts.0 += 1;
        } else {
            counts.1 += 1;
        }
        let total = self.codex_compactions_folded
            + self
                .codex_compactions
                .iter()
                .map(|(_, (items, notices))| *items.max(notices))
                .sum::<u32>();
        if self.metrics.compactions == Some(total) {
            return false;
        }
        self.metrics.compactions = Some(total);
        true
    }

    fn observe_acp_update(&mut self, params: &Value, now_millis: u64) -> bool {
        if !self.acp_prompt_sent {
            return false;
        }
        match params
            .pointer("/update/sessionUpdate")
            .and_then(Value::as_str)
        {
            Some(
                "agent_message_chunk"
                | "agent_thought_chunk"
                | "tool_call"
                | "tool_call_update"
                | "plan",
            ) => self.first_response(now_millis),
            _ => false,
        }
    }

    fn observe_acp_response(&mut self, message: &Value) -> bool {
        if !self.acp_prompt_sent || self.metrics.first_turn.is_some() {
            return false;
        }
        let Some(result) = message.get("result") else {
            return false;
        };
        if result.get("stopReason").is_none() {
            return false;
        }
        let usage = [
            result.get("usage"),
            result.pointer("/_meta/usage"),
            result.get("_meta"),
        ]
        .into_iter()
        .flatten()
        .find_map(acp_usage);
        let Some(usage) = usage else {
            return false;
        };
        self.metrics.first_turn = Some(usage);
        true
    }
}

fn acp_usage(value: &Value) -> Option<FirstTurnUsage> {
    let field = |names: &[&str]| names.iter().find_map(|name| value.get(*name)?.as_u64());
    let input = field(&["inputTokens", "input_tokens", "promptTokens"])?;
    let cache_read = field(&[
        "cachedReadTokens",
        "cacheReadInputTokens",
        "cache_read_input_tokens",
    ]);
    let cache_creation = field(&[
        "cachedWriteTokens",
        "cacheCreationInputTokens",
        "cache_creation_input_tokens",
    ]);
    Some(FirstTurnUsage {
        input_tokens: input,
        cache_read_input_tokens: cache_read,
        cache_creation_input_tokens: cache_creation,
        total_input_tokens: input
            .saturating_add(cache_read.unwrap_or(0))
            .saturating_add(cache_creation.unwrap_or(0)),
        output_tokens: field(&["outputTokens", "output_tokens"]),
    })
}

// ---------------------------------------------------------------------------
// The wrapper's process-wide recorder
// ---------------------------------------------------------------------------

fn recorder() -> Option<&'static Mutex<WakeObserver>> {
    static RECORDER: OnceLock<Option<Mutex<WakeObserver>>> = OnceLock::new();
    RECORDER
        .get_or_init(|| {
            // Unit tests drive `WakeObserver` directly; a shared recorder would
            // write into whatever sidecar another test points at.
            if cfg!(test) {
                return None;
            }
            // Only a daemon-managed Run has a sidecar to keep the block in.
            std::env::var_os("XMATRIX_RUN_STATUS_FILE")?;
            let runtime = std::env::var("XMATRIX_SPAWN_RUNTIME").unwrap_or_default();
            let resumed = crate::env_flag("XMATRIX_RESUME_REQUESTED");
            let started_with_input = crate::runtime_resume_input::initial_runtime_message()
                .is_some_and(|message| !message.trim().is_empty());
            let spawned_at = std::env::var(RUN_SPAWNED_AT_ENV)
                .ok()
                .and_then(|raw| raw.trim().parse::<u64>().ok());
            Some(Mutex::new(WakeObserver::new(
                harness_for_runtime(&runtime),
                resumed,
                started_with_input,
                spawned_at,
            )))
        })
        .as_ref()
}

fn record(observe: impl FnOnce(&mut WakeObserver, u64) -> bool) {
    let Some(recorder) = recorder() else {
        return;
    };
    let mut observer = recorder.lock().unwrap_or_else(|poison| poison.into_inner());
    if observe(&mut observer, crate::unix_millis_now()) {
        crate::write_current_run_wake_metrics(observer.metrics());
    }
}

/// A main-agent Claude stream-json frame.
pub(crate) fn record_claude_frame(frame: &Value) {
    record(|observer, now| observer.observe_claude(frame, now));
}

/// A message read from a Codex app-server or ACP provider.
pub(crate) fn record_provider_message(message: &Value) {
    record(|observer, now| observer.observe_provider(message, now));
}

/// The ACP client sent `session/prompt`.
pub(crate) fn record_acp_prompt_sent() {
    record(|observer, _| {
        observer.note_acp_prompt_sent();
        false
    });
}

// ---------------------------------------------------------------------------
// Daemon JSONL records
// ---------------------------------------------------------------------------

/// One ended Run, as appended to `wake-metrics.jsonl`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WakeMetricRecord {
    pub v: u32,
    pub recorded_at_millis: u64,
    /// Hash of the daemon's registry key and the wrapper pid: one per Run.
    pub key: String,
    /// Hash of the Run's resume session key, linking a wake to the Run that
    /// slept before it.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub session: Option<String>,
    pub harness: String,
    /// `wake`, `resume` or `cold`.
    pub launch: String,
    /// How the Run ended: `sleeping`, `stopped` or `exited`.
    pub end: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub first_response_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub first_turn: Option<FirstTurnUsage>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub compactions: Option<u32>,
}

pub(crate) fn metrics_path(state_root: &Path) -> PathBuf {
    state_root.join(METRICS_FILE)
}

fn rotated_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".1");
    PathBuf::from(name)
}

fn short_hash(value: &str) -> String {
    lowercase_hex(&Sha256::digest(value.as_bytes())[..8])
}

/// What the daemon knows about an ended Run.
pub(crate) struct EndedRun<'a> {
    pub registry_key: &'a str,
    pub pid: u32,
    pub resume_session_key: Option<&'a str>,
    pub end: &'a str,
    pub wake: &'a RunWakeMetrics,
}

/// Every record kept, oldest first.
pub(crate) fn read_records(path: &Path) -> Vec<WakeMetricRecord> {
    [rotated_path(path), path.to_path_buf()]
        .iter()
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .flat_map(|raw| {
            raw.lines()
                .filter_map(|line| serde_json::from_str::<WakeMetricRecord>(line).ok())
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Build the record for an ended Run, classify its launch against the
/// records already kept, and append it once. Returns whether a record was
/// written (`false` when this Run was already recorded).
pub(crate) fn append_ended_run(
    path: &Path,
    run: &EndedRun<'_>,
    now_millis: u64,
    max_bytes: u64,
) -> std::io::Result<bool> {
    let key = short_hash(&format!("{}\n{}", run.registry_key, run.pid));
    let session = run
        .resume_session_key
        .map(str::trim)
        .filter(|session| !session.is_empty())
        .map(short_hash);
    let existing = read_records(path);
    if existing.iter().any(|record| record.key == key) {
        return Ok(false);
    }
    let launch = if !run.wake.resumed {
        "cold"
    } else if session.is_some()
        && existing
            .iter()
            .rev()
            .find(|record| record.session == session)
            .is_some_and(|previous| previous.end == "sleeping")
    {
        "wake"
    } else {
        "resume"
    };
    let first_response_ms = run
        .wake
        .started_with_input
        .then_some(run.wake.spawned_at_millis)
        .flatten()
        .zip(run.wake.first_response_at_millis)
        .map(|(spawned, first)| first.saturating_sub(spawned));
    let record = WakeMetricRecord {
        v: RECORD_SCHEMA_VERSION,
        recorded_at_millis: now_millis,
        key,
        session,
        harness: run.wake.harness.clone(),
        launch: launch.into(),
        end: run.end.into(),
        first_response_ms,
        first_turn: run.wake.first_turn.clone(),
        compactions: run.wake.compactions,
    };
    let mut line = serde_json::to_vec(&record).map_err(std::io::Error::other)?;
    line.push(b'\n');
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let size = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    if size > 0 && size + line.len() as u64 > max_bytes {
        std::fs::rename(path, rotated_path(path))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(&line)?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Aggregation for `xmatrix daemon wake-metrics`
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Distribution {
    pub samples: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p50: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p90: Option<u64>,
}

impl Distribution {
    fn of(mut values: Vec<u64>) -> Self {
        values.sort_unstable();
        Self {
            samples: values.len(),
            p50: percentile(&values, 50),
            p90: percentile(&values, 90),
        }
    }
}

/// Nearest-rank percentile of sorted values.
fn percentile(sorted: &[u64], percent: usize) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (percent * sorted.len()).div_ceil(100).max(1);
    sorted.get(rank - 1).copied()
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaunchAggregate {
    pub launch: String,
    pub runs: usize,
    pub first_response_ms: Distribution,
    pub total_input_tokens: Distribution,
    pub uncached_input_tokens: Distribution,
    pub cache_read_input_tokens: Distribution,
    pub cache_creation_input_tokens: Distribution,
    /// Runs whose harness reports compactions.
    pub compaction_samples: usize,
    pub compactions: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compactions_per_run: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessAggregate {
    pub harness: String,
    pub launches: Vec<LaunchAggregate>,
    /// Median first-turn total input of wakes over that of cold starts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wake_to_cold_input_ratio: Option<f64>,
}

const LAUNCH_ORDER: [&str; 3] = ["wake", "resume", "cold"];

pub(crate) fn aggregate(
    records: &[WakeMetricRecord],
    harness: Option<&str>,
) -> Vec<HarnessAggregate> {
    let mut grouped: BTreeMap<&str, HashMap<&str, Vec<&WakeMetricRecord>>> = BTreeMap::new();
    for record in records {
        if harness.is_some_and(|harness| harness != record.harness) {
            continue;
        }
        grouped
            .entry(record.harness.as_str())
            .or_default()
            .entry(record.launch.as_str())
            .or_default()
            .push(record);
    }
    grouped
        .into_iter()
        .map(|(harness, launches)| {
            let mut ordered: Vec<LaunchAggregate> = launches
                .iter()
                .map(|(launch, records)| launch_aggregate(launch, records))
                .collect();
            ordered.sort_by_key(|aggregate| {
                LAUNCH_ORDER
                    .iter()
                    .position(|launch| *launch == aggregate.launch)
                    .unwrap_or(LAUNCH_ORDER.len())
            });
            let median_input = |launch: &str| {
                ordered
                    .iter()
                    .find(|aggregate| aggregate.launch == launch)
                    .and_then(|aggregate| aggregate.total_input_tokens.p50)
            };
            let wake_to_cold_input_ratio = median_input("wake")
                .zip(median_input("cold"))
                .filter(|(_, cold)| *cold > 0)
                .map(|(wake, cold)| wake as f64 / cold as f64);
            HarnessAggregate {
                harness: harness.to_string(),
                launches: ordered,
                wake_to_cold_input_ratio,
            }
        })
        .collect()
}

fn launch_aggregate(launch: &str, records: &[&WakeMetricRecord]) -> LaunchAggregate {
    let turn_values = |pick: fn(&FirstTurnUsage) -> Option<u64>| {
        Distribution::of(
            records
                .iter()
                .filter_map(|record| record.first_turn.as_ref().and_then(pick))
                .collect(),
        )
    };
    let compactions: Vec<u32> = records
        .iter()
        .filter_map(|record| record.compactions)
        .collect();
    let compaction_total: u64 = compactions.iter().map(|count| u64::from(*count)).sum();
    LaunchAggregate {
        launch: launch.to_string(),
        runs: records.len(),
        first_response_ms: Distribution::of(
            records
                .iter()
                .filter_map(|record| record.first_response_ms)
                .collect(),
        ),
        total_input_tokens: turn_values(|turn| Some(turn.total_input_tokens)),
        uncached_input_tokens: turn_values(|turn| Some(turn.input_tokens)),
        cache_read_input_tokens: turn_values(|turn| turn.cache_read_input_tokens),
        cache_creation_input_tokens: turn_values(|turn| turn.cache_creation_input_tokens),
        compaction_samples: compactions.len(),
        compactions: compaction_total,
        compactions_per_run: (!compactions.is_empty())
            .then(|| compaction_total as f64 / compactions.len() as f64),
    }
}

fn cell(value: Option<u64>) -> String {
    value
        .map(|value| value.to_string())
        .unwrap_or_else(|| "-".into())
}

pub(crate) fn render_text(path: &Path, aggregates: &[HarnessAggregate]) -> String {
    let mut out = format!("Wake metrics from {}\n", path.display());
    if aggregates.is_empty() {
        out.push_str("No Runs recorded yet.\n");
        return out;
    }
    out.push_str(&format!(
        "{:<12} {:<7} {:>5}  {:>21}  {:>21}  {:>11}  {:>11}  {:>11}\n",
        "harness",
        "launch",
        "runs",
        "first resp ms p50/p90",
        "input tokens p50/p90",
        "uncached p50",
        "cache rd p50",
        "compact/run"
    ));
    for harness in aggregates {
        for launch in &harness.launches {
            out.push_str(&format!(
                "{:<12} {:<7} {:>5}  {:>21}  {:>21}  {:>11}  {:>11}  {:>11}\n",
                harness.harness,
                launch.launch,
                launch.runs,
                format!(
                    "{}/{}",
                    cell(launch.first_response_ms.p50),
                    cell(launch.first_response_ms.p90)
                ),
                format!(
                    "{}/{}",
                    cell(launch.total_input_tokens.p50),
                    cell(launch.total_input_tokens.p90)
                ),
                cell(launch.uncached_input_tokens.p50),
                cell(launch.cache_read_input_tokens.p50),
                launch
                    .compactions_per_run
                    .map(|value| format!("{value:.2}"))
                    .unwrap_or_else(|| "-".into()),
            ));
        }
        if let Some(ratio) = harness.wake_to_cold_input_ratio {
            out.push_str(&format!(
                "{:<12} wake/cold median first-turn input: {:.2}x ({:.0}% fewer)\n",
                harness.harness,
                ratio,
                (1.0 - ratio) * 100.0
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn claude_observer() -> WakeObserver {
        WakeObserver::new("claude_code".into(), true, true, Some(1_000))
    }

    #[test]
    fn claude_frames_give_first_response_usage_and_compactions() {
        let mut observer = claude_observer();
        assert!(!observer.observe_claude(&json!({"type":"system","subtype":"init"}), 1_100));
        assert!(observer.observe_claude(
            &json!({"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}),
            3_500
        ));
        // Only the first output counts.
        assert!(!observer.observe_claude(&json!({"type":"assistant"}), 4_000));
        assert!(observer.observe_claude(
            &json!({"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto"}}),
            4_100
        ));
        assert!(observer.observe_claude(
            &json!({"type":"result","usage":{
                "input_tokens": 12, "cache_read_input_tokens": 30_000,
                "cache_creation_input_tokens": 1_500, "output_tokens": 400}}),
            5_000
        ));
        // A later turn's result does not replace the first.
        assert!(!observer.observe_claude(
            &json!({"type":"result","usage":{"input_tokens": 99}}),
            6_000
        ));
        assert!(observer.observe_claude(
            &json!({"type":"system","subtype":"compact_boundary"}),
            6_100
        ));
        let metrics = observer.metrics();
        assert_eq!(metrics.first_response_at_millis, Some(3_500));
        assert_eq!(metrics.compactions, Some(2));
        assert_eq!(
            metrics.first_turn,
            Some(FirstTurnUsage {
                input_tokens: 12,
                cache_read_input_tokens: Some(30_000),
                cache_creation_input_tokens: Some(1_500),
                total_input_tokens: 31_512,
                output_tokens: Some(400),
            })
        );
    }

    #[test]
    fn a_self_started_claude_turn_is_not_the_first_turn() {
        let mut observer = claude_observer();
        assert!(!observer.observe_claude(
            &json!({"type":"result","origin":{"kind":"task-notification"},
                    "usage":{"input_tokens": 5}}),
            2_000
        ));
        assert_eq!(observer.metrics().first_turn, None);
    }

    #[test]
    fn codex_first_turn_usage_is_the_delta_of_cumulative_totals() {
        let mut observer = WakeObserver::new("codex".into(), true, true, Some(0));
        let usage = |turn: &str, total: u64, cached: u64, last: u64| {
            json!({"method":"thread/tokenUsage/updated","params":{"threadId":"t","turnId":turn,
                "tokenUsage":{
                    "total":{"inputTokens":total,"cachedInputTokens":cached,"outputTokens":10,
                             "reasoningOutputTokens":0,"totalTokens":total+10},
                    "last":{"inputTokens":last,"cachedInputTokens":0,"outputTokens":10,
                            "reasoningOutputTokens":0,"totalTokens":last+10}}}})
        };
        // A resumed thread reports its restored totals before any turn.
        observer.observe_provider(&usage("old", 50_000, 40_000, 2_000), 10);
        assert_eq!(observer.metrics().compactions, None);
        observer.observe_provider(
            &json!({"method":"turn/started","params":{"threadId":"t","turn":{"id":"turn-1"}}}),
            20,
        );
        assert_eq!(observer.metrics().compactions, Some(0));
        // The waking message's own item is not output.
        assert!(!observer.observe_provider(
            &json!({"method":"item/started","params":{"turnId":"turn-1","item":{"type":"userMessage"}}}),
            30
        ));
        assert!(observer.observe_provider(
            &json!({"method":"item/agentMessage/delta","params":{"turnId":"turn-1","delta":"x"}}),
            900
        ));
        observer.observe_provider(&usage("turn-1", 53_000, 42_000, 3_000), 950);
        observer.observe_provider(&usage("turn-1", 57_000, 45_000, 4_000), 990);
        observer.observe_provider(
            &json!({"method":"turn/completed","params":{"turn":{"id":"turn-1"}}}),
            1_000,
        );
        observer.observe_provider(&usage("turn-2", 90_000, 80_000, 33_000), 2_000);
        let metrics = observer.metrics();
        assert_eq!(metrics.first_response_at_millis, Some(900));
        let turn = metrics.first_turn.clone().unwrap();
        assert_eq!(turn.total_input_tokens, 7_000);
        assert_eq!(turn.cache_read_input_tokens, Some(5_000));
        assert_eq!(turn.input_tokens, 2_000);
    }

    #[test]
    fn codex_without_a_prior_snapshot_uses_the_first_request_as_baseline() {
        let mut observer = WakeObserver::new("codex".into(), false, true, Some(0));
        observer.observe_provider(
            &json!({"method":"turn/started","params":{"turn":{"id":"a"}}}),
            1,
        );
        observer.observe_provider(
            &json!({"method":"thread/tokenUsage/updated","params":{"turnId":"a","tokenUsage":{
                "total":{"inputTokens":9_000,"cachedInputTokens":0,"outputTokens":5},
                "last":{"inputTokens":9_000,"cachedInputTokens":0,"outputTokens":5}}}}),
            2,
        );
        assert_eq!(
            observer
                .metrics()
                .first_turn
                .as_ref()
                .unwrap()
                .total_input_tokens,
            9_000
        );
    }

    #[test]
    fn codex_compactions_count_once_when_reported_twice() {
        let mut observer = WakeObserver::new("codex".into(), true, true, Some(0));
        observer.observe_provider(
            &json!({"method":"turn/started","params":{"turn":{"id":"a"}}}),
            1,
        );
        let notice = |turn: &str| json!({"method":"thread/compacted","params":{"threadId":"t","turnId":turn}});
        let item = |turn: &str| json!({"method":"item/completed","params":{"turnId":turn,"item":{"type":"contextCompaction","id":"c"}}});
        observer.observe_provider(
            &json!({"method":"item/started","params":{"turnId":"a","item":{"type":"contextCompaction"}}}),
            2,
        );
        observer.observe_provider(&item("a"), 2);
        observer.observe_provider(&notice("a"), 3);
        assert_eq!(observer.metrics().compactions, Some(1));
        observer.observe_provider(&notice("b"), 4);
        observer.observe_provider(&notice("b"), 5);
        assert_eq!(observer.metrics().compactions, Some(3));
        // Compaction items are not the first response.
        assert_eq!(observer.metrics().first_response_at_millis, None);
        // Beyond the tracked window, old turns fold into the total.
        for turn in 0..(COMPACTION_TURNS_TRACKED + 5) {
            observer.observe_provider(&item(&format!("z{turn:03}")), 6);
        }
        assert_eq!(
            observer.metrics().compactions,
            Some(3 + COMPACTION_TURNS_TRACKED as u32 + 5)
        );
        assert!(observer.codex_compactions.len() <= COMPACTION_TURNS_TRACKED);
    }

    #[test]
    fn acp_ignores_history_replay_and_reads_prompt_usage() {
        let mut observer = WakeObserver::new("grok".into(), true, true, Some(0));
        let chunk = json!({"method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"agent_message_chunk","content":{"text":"old"}}}});
        assert!(!observer.observe_provider(&chunk, 5));
        observer.note_acp_prompt_sent();
        assert!(observer.observe_provider(&chunk, 70));
        assert!(observer.observe_provider(
            &json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn",
                "usage":{"inputTokens":800,"cachedReadTokens":20_000,"outputTokens":30}}}),
            90
        ));
        let metrics = observer.metrics();
        assert_eq!(metrics.first_response_at_millis, Some(70));
        assert_eq!(
            metrics.first_turn.as_ref().unwrap().total_input_tokens,
            20_800
        );
        assert_eq!(metrics.compactions, None);
    }

    #[test]
    fn the_sidecar_block_round_trips_inside_a_status_marker() {
        let mut observer = claude_observer();
        observer.observe_claude(&json!({"type":"assistant"}), 2_000);
        let block = observer.metrics().clone();
        let value = serde_json::to_value(&block).unwrap();
        assert_eq!(value["harness"], "claude_code");
        assert_eq!(value["firstResponseAtMillis"], 2_000);
        assert!(value.get("firstTurn").is_none());
        let back: RunWakeMetrics = serde_json::from_value(value).unwrap();
        assert_eq!(back, block);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "xmatrix-wake-metrics-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn wake(resumed: bool, tokens: u64) -> RunWakeMetrics {
        RunWakeMetrics {
            harness: "claude_code".into(),
            resumed,
            started_with_input: true,
            spawned_at_millis: Some(1_000),
            first_response_at_millis: Some(1_000 + tokens / 10),
            first_turn: Some(FirstTurnUsage {
                input_tokens: tokens,
                total_input_tokens: tokens,
                ..FirstTurnUsage::default()
            }),
            compactions: Some(0),
        }
    }

    #[test]
    fn a_resumed_run_after_a_sleep_is_a_wake_and_is_recorded_once() {
        let dir = temp_dir("classify");
        let path = metrics_path(&dir);
        let cold = wake(false, 40_000);
        let append = |key: &str, pid: u32, end: &str, metrics: &RunWakeMetrics| {
            append_ended_run(
                &path,
                &EndedRun {
                    registry_key: key,
                    pid,
                    resume_session_key: Some("session-1"),
                    end,
                    wake: metrics,
                },
                7,
                METRICS_FILE_MAX_BYTES,
            )
            .unwrap()
        };
        assert!(append("run:a", 1, "sleeping", &cold));
        assert!(!append("run:a", 1, "sleeping", &cold), "deduplicated");
        let resumed = wake(true, 4_000);
        assert!(append("run:b", 2, "exited", &resumed));
        // Its predecessor exited without sleeping: an ordinary resume.
        assert!(append("run:c", 3, "sleeping", &resumed));
        let records = read_records(&path);
        let launches: Vec<&str> = records
            .iter()
            .map(|record| record.launch.as_str())
            .collect();
        assert_eq!(launches, ["cold", "wake", "resume"]);
        assert_eq!(records[1].first_response_ms, Some(400));
        // Hashed keys only: no session key or registry key in the file.
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("session-1") && !raw.contains("run:a"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_metrics_file_rotates_and_stays_bounded() {
        let dir = temp_dir("cap");
        let path = metrics_path(&dir);
        let metrics = wake(false, 1_000);
        let cap = 2_000;
        for pid in 0..200 {
            append_ended_run(
                &path,
                &EndedRun {
                    registry_key: "run:x",
                    pid,
                    resume_session_key: None,
                    end: "exited",
                    wake: &metrics,
                },
                pid.into(),
                cap,
            )
            .unwrap();
            let active = std::fs::metadata(&path).unwrap().len();
            let rotated = std::fs::metadata(rotated_path(&path))
                .map(|meta| meta.len())
                .unwrap_or(0);
            assert!(active <= cap && rotated <= cap, "{active} {rotated}");
        }
        let records = read_records(&path);
        assert!(!records.is_empty() && records.len() < 200);
        // The newest record survives rotation.
        assert_eq!(records.last().unwrap().recorded_at_millis, 199);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn record(
        harness: &str,
        launch: &str,
        total: u64,
        first_ms: u64,
        compactions: Option<u32>,
    ) -> WakeMetricRecord {
        WakeMetricRecord {
            v: 1,
            recorded_at_millis: 0,
            key: format!("{harness}{launch}{total}"),
            session: None,
            harness: harness.into(),
            launch: launch.into(),
            end: "sleeping".into(),
            first_response_ms: Some(first_ms),
            first_turn: Some(FirstTurnUsage {
                input_tokens: total / 10,
                cache_read_input_tokens: Some(total - total / 10),
                total_input_tokens: total,
                ..FirstTurnUsage::default()
            }),
            compactions,
        }
    }

    #[test]
    fn aggregates_compare_wakes_with_cold_starts_per_harness() {
        let mut records = vec![
            record("claude_code", "cold", 40_000, 9_000, Some(0)),
            record("claude_code", "cold", 60_000, 11_000, Some(1)),
            record("claude_code", "wake", 5_000, 4_000, Some(0)),
            record("claude_code", "wake", 6_000, 5_000, Some(2)),
            record("claude_code", "wake", 7_000, 6_000, Some(1)),
            record("grok", "wake", 1_000, 700, None),
        ];
        records.push(record("codex", "resume", 10_000, 3_000, Some(0)));
        let all = aggregate(&records, None);
        assert_eq!(
            all.iter().map(|h| h.harness.as_str()).collect::<Vec<_>>(),
            ["claude_code", "codex", "grok"]
        );
        let claude = &all[0];
        assert_eq!(
            claude
                .launches
                .iter()
                .map(|l| l.launch.as_str())
                .collect::<Vec<_>>(),
            ["wake", "cold"]
        );
        let wake = &claude.launches[0];
        assert_eq!(wake.runs, 3);
        assert_eq!(wake.total_input_tokens.p50, Some(6_000));
        assert_eq!(wake.total_input_tokens.p90, Some(7_000));
        assert_eq!(wake.first_response_ms.p50, Some(5_000));
        assert_eq!(wake.compactions, 3);
        assert_eq!(wake.compactions_per_run, Some(1.0));
        assert_eq!(claude.launches[1].total_input_tokens.p50, Some(40_000));
        assert_eq!(claude.wake_to_cold_input_ratio, Some(6_000.0 / 40_000.0));
        // A harness that reports no compactions has no rate.
        assert_eq!(all[2].launches[0].compactions_per_run, None);
        assert_eq!(all[2].launches[0].compaction_samples, 0);

        let only_grok = aggregate(&records, Some("grok"));
        assert_eq!(only_grok.len(), 1);
        let text = render_text(Path::new("/x/wake-metrics.jsonl"), &all);
        assert!(
            text.contains("wake/cold median first-turn input: 0.15x (85% fewer)"),
            "{text}"
        );
        assert!(render_text(Path::new("/x"), &[]).contains("No Runs recorded yet."));
    }

    #[test]
    fn nearest_rank_percentiles() {
        assert_eq!(percentile(&[], 50), None);
        assert_eq!(percentile(&[7], 90), Some(7));
        let values: Vec<u64> = (1..=10).collect();
        assert_eq!(percentile(&values, 50), Some(5));
        assert_eq!(percentile(&values, 90), Some(9));
    }

    #[test]
    fn harness_names() {
        assert_eq!(harness_for_runtime("claude"), "claude_code");
        assert_eq!(harness_for_runtime("Codex"), "codex");
        assert_eq!(harness_for_runtime("grok"), "grok");
        assert_eq!(harness_for_runtime(""), "other");
    }
}
