//! The owner's worktree actions from the Machine page: list every tree with
//! what the decision to reclaim it needs (size, un-landed work, whether a
//! process works in it), reclaim the trees the owner chose, and flip the
//! switch for reclaiming trees xMatrix did not create.
//!
//! A path in a request is only a choice from an earlier listing. Reclaim
//! lists again and acts only on trees git still registers that xMatrix did
//! not create, behind the same gates as the automatic sweep.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::machine_worktrees::{
    self, MachineWorktree, canonical, machine_worktrees, process_cwds, reclaim_foreign_worktrees,
    set_foreign_auto_reclaim,
};
use crate::run_worktree;

/// One listing carries at most this many trees (the protocol's bound).
const INVENTORY_TREES_MAX: usize = 1_000;
/// Sizing every tree of a busy machine can take minutes; trees not reached in
/// time are listed without a size rather than holding the answer back.
const SIZE_BUDGET: Duration = Duration::from_secs(90);
const PROBE_CONCURRENCY: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeActionKind {
    List,
    Reclaim,
    AutoReclaimOn,
    AutoReclaimOff,
}

impl WorktreeActionKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Reclaim => "reclaim",
            Self::AutoReclaimOn => "auto_reclaim_on",
            Self::AutoReclaimOff => "auto_reclaim_off",
        }
    }
}

/// The protocol's `WorktreeActionResult` for one owner request.
pub async fn execute_worktree_action(
    action: WorktreeActionKind,
    paths: &[String],
    live_cwds: &HashSet<PathBuf>,
) -> Value {
    let outcome = match action {
        WorktreeActionKind::List => list(live_cwds).await,
        WorktreeActionKind::Reclaim => reclaim(paths, live_cwds).await,
        WorktreeActionKind::AutoReclaimOn | WorktreeActionKind::AutoReclaimOff => {
            let on = action == WorktreeActionKind::AutoReclaimOn;
            set_foreign_auto_reclaim(on).map(|()| json!({ "foreignAutoReclaim": on }))
        }
    };
    let mut result = match outcome {
        Ok(Value::Object(fields)) => Value::Object(fields),
        Ok(_) => json!({}),
        Err(error) => json!({ "status": "failed", "error": bounded(&error) }),
    };
    result["action"] = json!(action.as_str());
    if result.get("status").is_none() {
        result["status"] = json!("succeeded");
    }
    result
}

fn bounded(text: &str) -> String {
    let clean: String = text.chars().filter(|ch| !ch.is_control()).collect();
    if clean.chars().count() > 1_000 {
        clean.chars().take(999).chain(['…']).collect()
    } else if clean.is_empty() {
        "failed".to_string()
    } else {
        clean
    }
}

fn busy_dirs(live_cwds: &HashSet<PathBuf>) -> Vec<PathBuf> {
    let mut busy: Vec<PathBuf> = live_cwds.iter().map(|cwd| canonical(cwd)).collect();
    busy.extend(process_cwds());
    busy
}

fn in_use(tree: &MachineWorktree, busy: &[PathBuf]) -> bool {
    let path = canonical(&tree.path);
    busy.iter().any(|cwd| cwd.starts_with(&path))
}

async fn list(live_cwds: &HashSet<PathBuf>) -> Result<Value, String> {
    let foreign_auto_reclaim = machine_worktrees::foreign_auto_reclaim_enabled()?;
    let known: Vec<PathBuf> = live_cwds.iter().cloned().collect();
    let mut trees = machine_worktrees(&known).await;
    let truncated = trees.len() > INVENTORY_TREES_MAX;
    trees.truncate(INVENTORY_TREES_MAX);
    let busy = busy_dirs(live_cwds);
    let deadline = Instant::now() + SIZE_BUDGET;
    let probes = probe_trees(&trees, deadline).await;
    let entries: Vec<Value> = trees
        .iter()
        .zip(probes)
        .map(|(tree, (size, unlanded))| {
            let mut entry = json!({
                "path": tree.path.to_string_lossy(),
                "origin": tree.origin.label(),
                "locked": tree.locked.is_some(),
                "missing": tree.missing,
                "inUse": !tree.missing && in_use(tree, &busy),
            });
            if let Some(branch) = tree.branch.as_deref().filter(|branch| !branch.is_empty()) {
                entry["branch"] = json!(branch);
            }
            if let Some(idle) = tree.idle_secs {
                entry["idleSecs"] = json!(idle);
            }
            if let Some(size) = size {
                entry["sizeBytes"] = json!(size);
            }
            if let Some(unlanded) = unlanded {
                entry["unlanded"] = json!(unlanded);
            }
            entry
        })
        .collect();
    let mut inventory = json!({
        "capturedAt": time::OffsetDateTime::now_utc()
            .replace_nanosecond(0)
            .ok()
            .and_then(|now| now.format(&time::format_description::well_known::Rfc3339).ok())
            .unwrap_or_default(),
        "foreignAutoReclaim": foreign_auto_reclaim,
        "trees": entries,
    });
    if truncated {
        inventory["truncated"] = json!(true);
    }
    Ok(json!({ "inventory": inventory }))
}

/// Size on disk and un-landed work of each tree, a few at a time, within the deadline.
async fn probe_trees(
    trees: &[MachineWorktree],
    deadline: Instant,
) -> Vec<(Option<u64>, Option<bool>)> {
    let permits = Arc::new(tokio::sync::Semaphore::new(PROBE_CONCURRENCY));
    let mut tasks = tokio::task::JoinSet::new();
    for (index, tree) in trees.iter().enumerate() {
        if tree.missing {
            continue;
        }
        let path = tree.path.clone();
        let permits = permits.clone();
        tasks.spawn(async move {
            let Ok(_permit) = permits.acquire_owned().await else {
                return (index, None, None);
            };
            if Instant::now() >= deadline {
                return (index, None, None);
            }
            // A dry run answers whether reclaim would snapshot it, changing nothing.
            let unlanded = run_worktree::reclaim_linked_worktree(&path, false, "probe")
                .await
                .ok();
            let walk = path.clone();
            let size = tokio::task::spawn_blocking(move || disk_usage(&walk, deadline))
                .await
                .ok()
                .flatten();
            (index, size, unlanded)
        });
    }
    let mut probes = vec![(None, None); trees.len()];
    while let Some(joined) = tasks.join_next().await {
        if let Ok((index, size, unlanded)) = joined {
            probes[index] = (size, unlanded);
        }
    }
    probes
}

/// Bytes the tree occupies, without following symlinks; `None` past the deadline.
fn disk_usage(root: &Path, deadline: Instant) -> Option<u64> {
    let mut total = 0u64;
    let mut stack = vec![root.to_path_buf()];
    let mut seen = 0u32;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            seen = seen.wrapping_add(1);
            if seen.is_multiple_of(4_096) && Instant::now() >= deadline {
                return None;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                stack.push(entry.path());
            } else {
                total = total.saturating_add(allocated(&metadata));
            }
        }
    }
    Some(total)
}

#[cfg(unix)]
fn allocated(metadata: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    metadata.blocks().saturating_mul(512)
}

#[cfg(not(unix))]
fn allocated(metadata: &std::fs::Metadata) -> u64 {
    metadata.len()
}

async fn reclaim(paths: &[String], live_cwds: &HashSet<PathBuf>) -> Result<Value, String> {
    let known: Vec<PathBuf> = live_cwds.iter().cloned().collect();
    let listed = machine_worktrees(&known).await;
    let asked: HashSet<&str> = paths.iter().map(String::as_str).collect();
    let mut kept: Vec<Value> = Vec::new();
    let mut chosen: Vec<MachineWorktree> = Vec::new();
    let mut found: HashSet<String> = HashSet::new();
    for tree in listed {
        let path = tree.path.to_string_lossy().to_string();
        if !asked.contains(path.as_str()) || !found.insert(path.clone()) {
            continue;
        }
        if tree.origin.managed_by_xmatrix() {
            kept.push(json!({ "path": path, "reason": "xMatrix cleans up its own worktrees" }));
        } else if tree.missing {
            kept.push(json!({ "path": path, "reason": "its folder is already gone" }));
        } else if tree.idle_secs.is_none() {
            kept.push(json!({ "path": path, "reason": "could not tell when it was last used" }));
        } else {
            chosen.push(tree);
        }
    }
    for path in paths {
        if !found.contains(path) {
            kept.push(json!({ "path": path, "reason": "no longer a worktree on this machine" }));
        }
    }
    let outcome = reclaim_foreign_worktrees(&chosen, live_cwds, None, Duration::ZERO, true).await;
    for path in &outcome.in_use {
        kept.push(json!({ "path": path.to_string_lossy(), "reason": "in use" }));
    }
    for (path, reason) in &outcome.skipped {
        kept.push(json!({ "path": path.to_string_lossy(), "reason": bounded(reason) }));
    }
    let reclaimed: Vec<Value> = outcome
        .reclaimed
        .iter()
        .map(|path| {
            json!({
                "path": path.to_string_lossy(),
                "snapshotted": outcome.snapshotted.contains(path),
            })
        })
        .collect();
    Ok(json!({ "reclaimed": reclaimed, "kept": kept }))
}

#[cfg(test)]
mod tests {
    use super::*;
    include!("../../core/tests/support/fs_cleanup.rs");

    use crate::test_support::{git_available, run_git, seed_remote, unique_temp_dir};

    #[test]
    fn disk_usage_counts_nested_files() {
        let dir = unique_temp_dir("disk-usage");
        std::fs::create_dir_all(dir.join("a/b")).unwrap();
        std::fs::write(dir.join("a/b/file"), vec![1u8; 64 * 1024]).unwrap();
        let size = disk_usage(&dir, Instant::now() + Duration::from_secs(30)).unwrap();
        assert!(size >= 64 * 1024, "{size}");
        cleanup_test_dirs(&[&dir]);
    }

    #[tokio::test]
    async fn reclaim_acts_only_on_listed_foreign_trees_it_was_asked_for() {
        if !git_available() {
            return;
        }
        let dir = unique_temp_dir("worktree-action-reclaim");
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let remote = dir.join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        seed_remote(&remote, &repo);
        let chosen = dir.join("chosen");
        let other = dir.join("other");
        run_git(
            &repo,
            &["worktree", "add", "--detach", chosen.to_str().unwrap()],
        );
        run_git(
            &repo,
            &["worktree", "add", "--detach", other.to_str().unwrap()],
        );
        let chosen_path = run_worktree_path(&repo, "chosen");
        let live: HashSet<PathBuf> = [repo.clone()].into_iter().collect();
        let result = execute_worktree_action(
            WorktreeActionKind::Reclaim,
            &[chosen_path.clone(), "/nowhere/at/all".to_string()],
            &live,
        )
        .await;
        assert_eq!(result["status"], "succeeded", "{result}");
        assert_eq!(result["reclaimed"][0]["path"], chosen_path.as_str());
        assert!(!chosen.exists());
        assert!(other.exists(), "a tree nobody asked for stays");
        let kept = result["kept"].as_array().unwrap();
        assert!(kept.iter().any(|entry| entry["path"] == "/nowhere/at/all"));
        cleanup_test_dirs(&[&dir]);
    }

    /// The path as `git worktree list` reports it, which is what a listing hands the owner.
    fn run_worktree_path(repo: &Path, name: &str) -> String {
        let output = std::process::Command::new("git")
            .args(["worktree", "list", "--porcelain"])
            .current_dir(repo)
            .output()
            .unwrap();
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .filter_map(|line| line.strip_prefix("worktree "))
            .find(|path| path.ends_with(name))
            .unwrap()
            .to_string()
    }
}
