//! Idle Instance sleep (docs/instance-sleep.md §2).
//!
//! An Instance is not its process: once a resumable Run has had nothing to do
//! for the idle window, the daemon ends its process tree exactly like a
//! retained stop and reports the exit as a sleep. The Hub keeps the Instance in
//! its Channel and wakes it, through the ordinary reborn, on the next message.
//!
//! This module holds the decision only: which Runs are idle, and whether a
//! Run's provider still has work of its own running. The registry monitor owns
//! the effects.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

/// Seconds a resumable Run must sit idle before it sleeps; `0` disables sleep.
pub(crate) const INSTANCE_IDLE_SLEEP_SECS_ENV: &str = "XMATRIX_INSTANCE_IDLE_SLEEP_SECS";
const DEFAULT_IDLE_SLEEP: Duration = Duration::from_secs(30 * 60);

/// The status phase the daemon stamps on a Run it put to sleep. The exit
/// report reads it back, so a daemon restart between the stop and the report
/// still reports a sleep.
pub(crate) const SLEEPING_PHASE: &str = "sleeping";

/// A wrapper that already reported a startup failure but never exited only
/// holds memory and a checkout; it is ended once it has sat this long.
const FAILED_STARTUP_GRACE: Duration = Duration::from_secs(60);

/// Phases in which a wrapper waits for its next message. Also any
/// `*_app_ready` phase (codex / grok / acp / …): the provider is up and idle.
const RESTING_PHASES: &[&str] = &[
    "turn_completed",
    "turn_failed",
    "turn_interrupted",
    "relay_registered",
    "channel_joined",
    "model_selected",
    "effort_selected",
];

fn is_resting_phase(phase: &str) -> bool {
    RESTING_PHASES.contains(&phase) || phase.ends_with("_app_ready")
}

/// Only an explicit positive count means a watch / Monitor / CI wait is still
/// running. `None` means the runtime never reported tasks (Codex, Cursor, ACP,
/// Grok, or Claude after its stream closed with none open) — that is idle, not
/// "unknown busy".
fn has_background_work(background_tasks: Option<u32>) -> bool {
    background_tasks.is_some_and(|count| count > 0)
}

pub(crate) fn idle_sleep_window() -> Option<Duration> {
    let window = std::env::var(INSTANCE_IDLE_SLEEP_SECS_ENV)
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_IDLE_SLEEP);
    (!window.is_zero()).then_some(window)
}

/// What the monitor knows about one managed Run on this tick.
#[derive(Debug, Clone)]
pub(crate) struct RunIdleView {
    pub key: String,
    pub pid: u32,
    pub resumable_session: bool,
    pub stop_in_progress: bool,
    /// The sidecar marker, only when it was written by this exact pid.
    pub marker: Option<RunIdleMarker>,
}

#[derive(Debug, Clone)]
pub(crate) struct RunIdleMarker {
    pub phase: String,
    pub completed: bool,
    /// A task execution is accepted or running and has not finished.
    pub execution_in_flight: bool,
    /// Newest task-execution update or finish, in Unix milliseconds.
    pub last_execution_millis: Option<u64>,
    pub wrapper_ready_at_millis: Option<u64>,
    /// When the wrapper that owns `pid` last wrote the marker itself. Only the
    /// wrapper stamps it, so the pid named that wrapper at this moment.
    pub updated_at_millis: u64,
    /// Background tasks the provider reports as running. `None` or `0` means
    /// no reported watch; only a positive count holds the Run awake.
    pub background_tasks: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum IdleAction {
    /// The Run rests until the next message wakes it.
    Sleep { idle_for: Duration, phase: String },
    /// The wrapper already failed at startup and only lingers.
    EndFailedStartup,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IdleDecision {
    pub key: String,
    pub pid: u32,
    /// The marker's `updated_at_millis`: the wrapper was alive then.
    pub alive_at_millis: u64,
    pub action: IdleAction,
}

/// Remembers when each Run's phase last changed, so a turn shorter than the
/// sampling interval that left no task-execution trace still counts as work.
#[derive(Debug, Default)]
pub(crate) struct IdleSleepTracker {
    phases: HashMap<String, (u32, String, u64, bool)>,
    /// Runs whose process this daemon already ended, or found gone. Their
    /// registry row outlives the process until the exit report is confirmed,
    /// and a dead pid must never be signalled again: it may belong to anyone.
    ended: HashSet<(String, u32)>,
}

impl IdleSleepTracker {
    pub(crate) fn observe(
        &mut self,
        now_millis: u64,
        window: Duration,
        runs: &[RunIdleView],
    ) -> Vec<IdleDecision> {
        let live: HashSet<&str> = runs.iter().map(|run| run.key.as_str()).collect();
        self.phases.retain(|key, _| live.contains(key.as_str()));
        self.ended.retain(|(key, _)| live.contains(key.as_str()));
        let mut decisions = Vec::new();
        for run in runs {
            if self.ended.contains(&(run.key.clone(), run.pid)) {
                continue;
            }
            let Some(marker) = run.marker.as_ref() else {
                continue;
            };
            let entry = self
                .phases
                .entry(run.key.clone())
                .or_insert_with(|| (run.pid, marker.phase.clone(), now_millis, false));
            if entry.0 != run.pid || entry.1 != marker.phase {
                *entry = (run.pid, marker.phase.clone(), now_millis, false);
            }
            let phase_since = entry.2;
            if run.stop_in_progress {
                continue;
            }
            if marker.phase == "wrapper_startup_failed" && marker.completed {
                if now_millis.saturating_sub(phase_since) >= FAILED_STARTUP_GRACE.as_millis() as u64
                {
                    decisions.push(IdleDecision {
                        key: run.key.clone(),
                        pid: run.pid,
                        alive_at_millis: marker.updated_at_millis,
                        action: IdleAction::EndFailedStartup,
                    });
                }
                continue;
            }
            let busy = marker.execution_in_flight || has_background_work(marker.background_tasks);
            if busy || entry.3 {
                entry.2 = now_millis;
            }
            entry.3 = busy;
            let phase_since = entry.2;
            // Outstanding provider work resets the idle window even when the
            // wrapper stays in turn_completed throughout a watch or CI wait.
            if busy {
                continue;
            }
            // `completed` is not consulted: a wrapper stamps `turn_completed`
            // with `completed: true` after every ordinary turn, which is the
            // very state a resting Run is in. Every harness with a resume key
            // sleeps; only an explicit background-task count > 0 (watch /
            // Monitor / CI wait) holds it awake.
            if !run.resumable_session || !is_resting_phase(&marker.phase) {
                continue;
            }
            let last_activity = [
                Some(phase_since),
                marker.last_execution_millis,
                marker.wrapper_ready_at_millis,
            ]
            .into_iter()
            .flatten()
            .max()
            .unwrap_or(phase_since);
            let idle_for = Duration::from_millis(now_millis.saturating_sub(last_activity));
            if idle_for >= window {
                decisions.push(IdleDecision {
                    key: run.key.clone(),
                    pid: run.pid,
                    alive_at_millis: marker.updated_at_millis,
                    action: IdleAction::Sleep {
                        idle_for,
                        phase: marker.phase.clone(),
                    },
                });
            }
        }
        decisions
    }
}

impl IdleSleepTracker {
    /// Never act on this Run's `pid` again.
    pub(crate) fn note_ended(&mut self, key: &str, pid: u32) {
        self.ended.insert((key.to_string(), pid));
    }
}

/// Clock skew allowed between a process start time (whole seconds, derived
/// from boot time) and the wrapper's own marker stamp.
const PROCESS_START_SLACK_MILLIS: u64 = 2_000;

/// Whether `pid` is still the wrapper that stamped its marker at
/// `alive_at_millis`. A process that started after that stamp reuses the
/// number of a wrapper that is gone; signalling it would end someone else's
/// process tree.
pub(crate) fn is_marker_writer(pid: u32, alive_at_millis: u64, processes: &[ProcessView]) -> bool {
    processes
        .iter()
        .find(|process| process.pid == pid)
        .is_some_and(|process| {
            process.start_time.saturating_mul(1_000)
                <= alive_at_millis.saturating_add(PROCESS_START_SLACK_MILLIS)
        })
}

/// The runtime subcommand a wrapper was started with (`xmatrix claude ...`).
#[cfg(test)]
pub(crate) fn wrapper_runtime(args: Option<&[String]>) -> Option<String> {
    let first = args?.first()?.trim();
    let name = std::path::Path::new(first)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(first);
    (!name.is_empty()).then(|| name.to_ascii_lowercase())
}

/// One process, as the pid-reuse check needs it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ProcessView {
    pub pid: u32,
    /// Seconds since the Unix epoch.
    pub start_time: u64,
}

/// A snapshot of every process, for `is_marker_writer`.
pub(crate) fn process_snapshot() -> Vec<ProcessView> {
    // One-off scan: do not keep a /proc stat handle open per process.
    sysinfo::set_open_files_limit(0);
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::nothing(),
    );
    system
        .processes()
        .iter()
        .map(|(pid, process)| ProcessView {
            pid: pid.as_u32(),
            start_time: process.start_time(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: Duration = Duration::from_secs(30 * 60);
    const MINUTE: u64 = 60_000;

    fn run(phase: &str) -> RunIdleView {
        RunIdleView {
            key: "run:run-1".into(),
            pid: 42,
            resumable_session: true,
            stop_in_progress: false,
            marker: Some(RunIdleMarker {
                phase: phase.into(),
                // As the wrappers write it: a finished turn is `completed`.
                completed: phase == "turn_completed",
                execution_in_flight: false,
                last_execution_millis: None,
                wrapper_ready_at_millis: None,
                updated_at_millis: 0,
                background_tasks: Some(0),
            }),
        }
    }

    #[test]
    fn a_resumable_run_sleeps_only_after_a_full_idle_window() {
        let mut tracker = IdleSleepTracker::default();
        let runs = [run("turn_completed")];
        assert!(tracker.observe(0, WINDOW, &runs).is_empty());
        assert!(tracker.observe(29 * MINUTE, WINDOW, &runs).is_empty());
        let decisions = tracker.observe(30 * MINUTE, WINDOW, &runs);
        assert_eq!(
            decisions,
            vec![IdleDecision {
                key: "run:run-1".into(),
                pid: 42,
                alive_at_millis: 0,
                action: IdleAction::Sleep {
                    idle_for: WINDOW,
                    phase: "turn_completed".into()
                },
            }]
        );
    }

    #[test]
    fn background_work_finishing_requires_a_new_idle_window() {
        let mut tracker = IdleSleepTracker::default();
        let mut runs = [run("turn_completed")];
        tracker.observe(0, WINDOW, &runs);
        runs[0].marker.as_mut().unwrap().background_tasks = Some(1);
        assert!(tracker.observe(60 * MINUTE, WINDOW, &runs).is_empty());
        runs[0].marker.as_mut().unwrap().background_tasks = Some(0);
        assert!(tracker.observe(61 * MINUTE, WINDOW, &runs).is_empty());
        assert!(tracker.observe(89 * MINUTE, WINDOW, &runs).is_empty());
        assert_eq!(tracker.observe(91 * MINUTE, WINDOW, &runs).len(), 1);
    }

    #[test]
    fn a_short_turn_between_samples_restarts_the_window() {
        let mut tracker = IdleSleepTracker::default();
        let mut runs = [run("turn_completed")];
        tracker.observe(0, WINDOW, &runs);
        // The phase never changed, but a task finished at minute 20.
        runs[0].marker.as_mut().unwrap().last_execution_millis = Some(20 * MINUTE);
        assert!(tracker.observe(40 * MINUTE, WINDOW, &runs).is_empty());
        assert_eq!(tracker.observe(50 * MINUTE, WINDOW, &runs).len(), 1);
        // A phase change is activity too.
        let mut tracker = IdleSleepTracker::default();
        let mut runs = [run("turn_completed")];
        tracker.observe(0, WINDOW, &runs);
        runs[0].marker.as_mut().unwrap().phase = "turn_running".into();
        tracker.observe(10 * MINUTE, WINDOW, &runs);
        runs[0].marker.as_mut().unwrap().phase = "turn_completed".into();
        // Observed back at rest at minute 35: the window starts there.
        assert!(tracker.observe(35 * MINUTE, WINDOW, &runs).is_empty());
        assert!(tracker.observe(64 * MINUTE, WINDOW, &runs).is_empty());
        assert_eq!(tracker.observe(65 * MINUTE, WINDOW, &runs).len(), 1);
    }

    #[test]
    fn busy_unresumable_or_stopping_runs_never_sleep() {
        let cases: Vec<Box<dyn Fn(&mut RunIdleView)>> = vec![
            Box::new(|run| run.marker.as_mut().unwrap().phase = "turn_running".into()),
            Box::new(|run| run.marker.as_mut().unwrap().execution_in_flight = true),
            // The provider says a background task (a CI wait / Monitor) is still running.
            Box::new(|run| run.marker.as_mut().unwrap().background_tasks = Some(1)),
            Box::new(|run| run.resumable_session = false),
            Box::new(|run| run.stop_in_progress = true),
            Box::new(|run| run.marker = None),
        ];
        for mutate in cases {
            let mut tracker = IdleSleepTracker::default();
            let mut view = run("turn_completed");
            mutate(&mut view);
            tracker.observe(0, WINDOW, std::slice::from_ref(&view));
            assert!(
                tracker
                    .observe(24 * 60 * MINUTE, WINDOW, &[view])
                    .is_empty()
            );
        }
    }

    #[test]
    fn unknown_or_zero_background_count_lets_every_harness_sleep() {
        // Production markers leave backgroundTasks unset (Codex / Cursor / ACP /
        // Grok, and Claude after its stream closes with none open). That is idle.
        for phase in [
            "turn_completed",
            "turn_failed",
            "acp_app_ready",
            "grok_app_ready",
            "codex_app_ready",
        ] {
            for background_tasks in [None, Some(0u32)] {
                let mut tracker = IdleSleepTracker::default();
                let mut view = run(phase);
                let marker = view.marker.as_mut().unwrap();
                marker.background_tasks = background_tasks;
                marker.completed = phase == "turn_completed";
                let runs = [view];
                tracker.observe(0, WINDOW, &runs);
                assert_eq!(
                    tracker.observe(30 * MINUTE, WINDOW, &runs).len(),
                    1,
                    "phase={phase} bg={background_tasks:?}"
                );
            }
        }
    }

    #[test]
    fn a_run_whose_last_turn_finished_normally_sleeps() {
        // The marker a claude wrapper leaves after an ordinary turn (seen in
        // production on 0.16.540): it must not look finished for good.
        let mut tracker = IdleSleepTracker::default();
        let mut view = run("turn_completed");
        let marker = view.marker.as_mut().unwrap();
        assert!(marker.completed);
        marker.last_execution_millis = Some(0);
        let runs = [view];
        tracker.observe(0, WINDOW, &runs);
        assert!(matches!(
            tracker.observe(30 * MINUTE, WINDOW, &runs)[..],
            [IdleDecision {
                action: IdleAction::Sleep { .. },
                ..
            }]
        ));
    }

    #[test]
    fn a_lingering_failed_startup_is_ended_not_slept() {
        let mut tracker = IdleSleepTracker::default();
        let mut view = run("wrapper_startup_failed");
        view.marker.as_mut().unwrap().completed = true;
        view.resumable_session = false;
        let runs = [view];
        assert!(tracker.observe(0, WINDOW, &runs).is_empty());
        assert_eq!(
            tracker.observe(MINUTE, WINDOW, &runs)[0].action,
            IdleAction::EndFailedStartup
        );
    }

    #[test]
    fn the_wrapper_runtime_is_its_first_argument() {
        let args = [
            "claude".to_string(),
            "--dangerously-skip-permissions".into(),
        ];
        assert_eq!(wrapper_runtime(Some(&args)).as_deref(), Some("claude"));
        let path = ["/opt/bin/Codex.exe".to_string()];
        assert_eq!(wrapper_runtime(Some(&path)).as_deref(), Some("codex"));
        assert_eq!(wrapper_runtime(None), None);
        assert_eq!(wrapper_runtime(Some(&[])), None);
    }

    fn process(pid: u32, start_time: u64) -> ProcessView {
        ProcessView { pid, start_time }
    }

    #[test]
    fn an_ended_run_is_never_acted_on_again() {
        // A failed wrapper whose exit report never finalizes keeps its row.
        let mut tracker = IdleSleepTracker::default();
        let mut failed = run("wrapper_startup_failed");
        failed.marker.as_mut().unwrap().completed = true;
        let runs = [failed];
        tracker.observe(0, WINDOW, &runs);
        let decisions = tracker.observe(MINUTE, WINDOW, &runs);
        assert_eq!(decisions.len(), 1);
        assert_eq!(decisions[0].action, IdleAction::EndFailedStartup);
        tracker.note_ended("run:run-1", 42);
        assert!(tracker.observe(2 * MINUTE, WINDOW, &runs).is_empty());
        assert!(tracker.observe(60 * MINUTE, WINDOW, &runs).is_empty());
        // Once the row is gone and a new Run reuses the key, it is judged anew.
        tracker.observe(61 * MINUTE, WINDOW, &[]);
        tracker.observe(62 * MINUTE, WINDOW, &runs);
        assert_eq!(tracker.observe(63 * MINUTE, WINDOW, &runs).len(), 1);
    }

    #[test]
    fn a_reused_pid_is_not_the_wrapper() {
        // The wrapper (pid 10, started at second 1_000) stamped its marker at
        // second 2_000.
        let alive_at = 2_000_000;
        assert!(is_marker_writer(10, alive_at, &[process(10, 1_000)]));
        assert!(
            is_marker_writer(10, alive_at, &[process(10, 2_001)]),
            "clock slack"
        );
        // It is gone, or another process now holds its number.
        assert!(!is_marker_writer(10, alive_at, &[]));
        assert!(!is_marker_writer(10, alive_at, &[process(10, 2_100)]));
    }
}
