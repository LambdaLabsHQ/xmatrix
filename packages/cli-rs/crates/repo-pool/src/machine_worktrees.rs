//! Every linked worktree on this machine, whoever created it.
//!
//! The daemon reclaims the trees it creates itself: run worktrees and
//! repo-pool slots. Harnesses and Agents create their own as well: Claude
//! Code's sub-agent isolation under `<repo>/.claude/worktrees`, Codex and
//! Cursor under their home directories, and hand-made `git worktree add`
//! trees anywhere, often in `/tmp`. Many exist before a machine ever runs
//! xMatrix. None of them were visible to reclaim, so they filled disks.
//!
//! Git registers every linked tree with its repository, so the inventory asks
//! each repository this machine knows about instead of guessing directories.
//! Harness layouts only label what git reports, and point at repositories
//! xMatrix never launched in.
//!
//! xMatrix's own trees keep their automatic reclaim. Every other tree is
//! listed and left alone until the owner turns automatic reclaim on for this
//! machine (`xmatrix machine worktrees auto-reclaim on`).

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::repo_pool;
use crate::run_worktree::{self, GIT_LOCAL_TIMEOUT, git};

const POLICY_FILE: &str = "worktree-policy.json";
const FOREIGN_AUTO_RECLAIM_KEY: &str = "foreignAutoReclaim";
/// How deep under a harness's worktree root its trees sit
/// (`~/.codex/worktrees/<id>/<repo>`, `~/.cursor/worktrees/<repo>/<id>`).
const HARNESS_ROOT_DEPTH: usize = 3;

/// Who created a linked worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorktreeOrigin {
    RepoPool,
    RunWorktree,
    ClaudeCode,
    Codex,
    Cursor,
    /// `git worktree add` by a person or an Agent, outside any harness layout.
    Manual,
}

impl WorktreeOrigin {
    pub fn label(self) -> &'static str {
        match self {
            Self::RepoPool => "repo-pool",
            Self::RunWorktree => "run-worktree",
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
            Self::Manual => "manual",
        }
    }

    /// Trees the daemon created and already reclaims on its own schedule.
    pub fn managed_by_xmatrix(self) -> bool {
        matches!(self, Self::RepoPool | Self::RunWorktree)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineWorktree {
    pub path: PathBuf,
    /// The repository's common git directory.
    pub repository: PathBuf,
    pub origin: WorktreeOrigin,
    pub branch: Option<String>,
    pub locked: Option<String>,
    /// Registered with git but its directory is gone.
    pub missing: bool,
    pub idle_secs: Option<u64>,
}

/// Where this machine keeps the trees and repositories the inventory knows by
/// layout.
#[derive(Debug, Clone)]
pub struct InventoryRoots {
    pub pools_root: Option<PathBuf>,
    pub run_worktrees_root: PathBuf,
    pub managed_repos_root: PathBuf,
    pub codex_worktrees_root: Option<PathBuf>,
    pub cursor_worktrees_root: Option<PathBuf>,
}

impl InventoryRoots {
    pub fn current() -> Self {
        let run_worktrees_root = run_worktree::run_worktrees_root();
        let managed_repos_root = run_worktrees_root
            .parent()
            .map(|parent| parent.join("repos"))
            .unwrap_or_else(|| run_worktrees_root.join("repos"));
        let home = dirs::home_dir();
        Self {
            pools_root: repo_pool::default_repo_pools_root().ok(),
            run_worktrees_root,
            managed_repos_root,
            codex_worktrees_root: home
                .as_ref()
                .map(|home| home.join(".codex").join("worktrees")),
            cursor_worktrees_root: home
                .as_ref()
                .map(|home| home.join(".cursor").join("worktrees")),
        }
    }

    fn classify(&self, path: &Path) -> WorktreeOrigin {
        let path = canonical(path);
        let under = |root: &Option<PathBuf>| {
            root.as_ref()
                .is_some_and(|root| path.starts_with(canonical(root)))
        };
        if under(&self.pools_root) {
            WorktreeOrigin::RepoPool
        } else if path.starts_with(canonical(&self.run_worktrees_root)) {
            WorktreeOrigin::RunWorktree
        } else if under(&self.codex_worktrees_root) {
            WorktreeOrigin::Codex
        } else if under(&self.cursor_worktrees_root) {
            WorktreeOrigin::Cursor
        } else if path
            .ancestors()
            .any(|ancestor| ancestor.ends_with(".claude/worktrees"))
        {
            WorktreeOrigin::ClaudeCode
        } else {
            WorktreeOrigin::Manual
        }
    }
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Every linked worktree of every repository this machine knows about.
/// `known_cwds` are directories in use (live runs), whose repositories are
/// asked too.
pub async fn machine_worktrees(known_cwds: &[PathBuf]) -> Vec<MachineWorktree> {
    machine_worktrees_at(&InventoryRoots::current(), known_cwds).await
}

pub async fn machine_worktrees_at(
    roots: &InventoryRoots,
    known_cwds: &[PathBuf],
) -> Vec<MachineWorktree> {
    let mut trees = Vec::new();
    for repository in known_repositories(roots, known_cwds).await {
        let Ok(listing) = git(
            &repository,
            &["worktree", "list", "--porcelain"],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        else {
            continue;
        };
        for entry in parse_worktree_list(&listing).into_iter().skip(1) {
            let missing = !entry.path.exists();
            trees.push(MachineWorktree {
                origin: roots.classify(&entry.path),
                idle_secs: if missing {
                    None
                } else {
                    repo_pool::slot_idle_for(&entry.path).map(|idle| idle.as_secs())
                },
                repository: repository.clone(),
                path: entry.path,
                branch: entry.branch,
                locked: entry.locked,
                missing,
            });
        }
    }
    trees.sort_by(|a, b| a.origin.cmp(&b.origin).then_with(|| a.path.cmp(&b.path)));
    trees
}

/// Common git directories, deduplicated, of: managed checkouts, the bases the
/// repo pools are pinned to, repositories behind harness-made trees, and the
/// repositories of `known_cwds`.
async fn known_repositories(roots: &InventoryRoots, known_cwds: &[PathBuf]) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&roots.managed_repos_root) {
        candidates.extend(
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.join(".git").is_dir()),
        );
    }
    if let Some(pools_root) = &roots.pools_root {
        candidates.extend(repo_pool::pool_base_repos_at(pools_root));
    }
    for root in [&roots.codex_worktrees_root, &roots.cursor_worktrees_root]
        .into_iter()
        .flatten()
    {
        collect_linked_trees(root, HARNESS_ROOT_DEPTH, &mut candidates);
    }
    candidates.extend(known_cwds.iter().filter(|cwd| cwd.is_dir()).cloned());

    let mut repositories = BTreeMap::new();
    for candidate in candidates {
        if let Ok(common) = git(
            &candidate,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        {
            let common = canonical(Path::new(&common));
            repositories.entry(common.clone()).or_insert(common);
        }
    }
    repositories.into_values().collect()
}

fn collect_linked_trees(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if dir.join(".git").is_file() {
        out.push(dir.to_path_buf());
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            collect_linked_trees(&entry.path(), depth - 1, out);
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ListedWorktree {
    path: PathBuf,
    branch: Option<String>,
    locked: Option<String>,
}

/// `git worktree list --porcelain`, main worktree first.
fn parse_worktree_list(listing: &str) -> Vec<ListedWorktree> {
    let mut trees = Vec::new();
    let mut current: Option<ListedWorktree> = None;
    for line in listing.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            trees.extend(current.take());
            current = Some(ListedWorktree {
                path: PathBuf::from(path),
                ..ListedWorktree::default()
            });
            continue;
        }
        let Some(tree) = current.as_mut() else {
            continue;
        };
        if let Some(branch) = line.strip_prefix("branch ") {
            tree.branch = Some(
                branch
                    .strip_prefix("refs/heads/")
                    .unwrap_or(branch)
                    .to_string(),
            );
        } else if line == "locked" {
            tree.locked = Some(String::new());
        } else if let Some(reason) = line.strip_prefix("locked ") {
            tree.locked = Some(reason.to_string());
        }
    }
    trees.extend(current);
    trees
}

/// The owner's choice for trees xMatrix did not create, read fresh at each
/// sweep so the CLI and the daemon share one record.
pub fn foreign_auto_reclaim_enabled() -> Result<bool, String> {
    read_foreign_auto_reclaim(&policy_path())
}

pub fn set_foreign_auto_reclaim(enabled: bool) -> Result<(), String> {
    write_foreign_auto_reclaim(&policy_path(), enabled)
}

pub fn policy_path() -> PathBuf {
    xmatrix_cli_core::config::config_dir().join(POLICY_FILE)
}

/// Off until the owner turns it on: a missing file means nobody has.
fn read_foreign_auto_reclaim(path: &Path) -> Result<bool, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))?;
    match value.get(FOREIGN_AUTO_RECLAIM_KEY) {
        None => Ok(false),
        Some(serde_json::Value::Bool(enabled)) => Ok(*enabled),
        Some(_) => Err(format!(
            "{} has a non-boolean {FOREIGN_AUTO_RECLAIM_KEY}",
            path.display()
        )),
    }
}

/// Fails closed on a malformed file instead of replacing what it holds.
fn write_foreign_auto_reclaim(path: &Path, enabled: bool) -> Result<(), String> {
    let mut document = match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
            .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    let object = document
        .as_object_mut()
        .ok_or_else(|| format!("{} is not a JSON object", path.display()))?;
    object.insert(
        FOREIGN_AUTO_RECLAIM_KEY.to_string(),
        serde_json::Value::Bool(enabled),
    );
    xmatrix_cli_core::config::write_json_atomically(path, &document)
}

#[derive(Debug, Default)]
pub struct ForeignReclaimOutcome {
    pub apply: bool,
    pub reclaimed: Vec<PathBuf>,
    pub snapshotted: Vec<PathBuf>,
    pub in_use: Vec<PathBuf>,
    pub skipped: Vec<(PathBuf, String)>,
}

/// Reclaim trees xMatrix did not create that have sat untouched for
/// `min_idle`, behind the same gates as the daemon's own trees: foreign locks
/// are honored, and a dirty tree or one with commits no remote has is
/// committed and pinned under `refs/xmatrix/snapshot/foreign/` first. A tree
/// any process on this machine works in is never touched.
pub async fn reclaim_foreign_worktrees(
    trees: &[MachineWorktree],
    live_cwds: &HashSet<PathBuf>,
    origins: Option<&[WorktreeOrigin]>,
    min_idle: Duration,
    apply: bool,
) -> ForeignReclaimOutcome {
    let mut busy: Vec<PathBuf> = live_cwds.iter().map(|cwd| canonical(cwd)).collect();
    busy.extend(process_cwds());
    let mut outcome = ForeignReclaimOutcome {
        apply,
        ..ForeignReclaimOutcome::default()
    };
    for tree in trees {
        if tree.origin.managed_by_xmatrix()
            || tree.missing
            || origins.is_some_and(|origins| !origins.contains(&tree.origin))
        {
            continue;
        }
        if tree
            .idle_secs
            .is_none_or(|idle| Duration::from_secs(idle) < min_idle)
        {
            continue;
        }
        let path = canonical(&tree.path);
        if busy.iter().any(|cwd| cwd.starts_with(&path)) {
            outcome.in_use.push(tree.path.clone());
            continue;
        }
        match run_worktree::reclaim_linked_worktree(&tree.path, apply, &snapshot_name(tree)).await {
            Ok(snapshotted) => {
                if snapshotted {
                    outcome.snapshotted.push(tree.path.clone());
                }
                outcome.reclaimed.push(tree.path.clone());
            }
            Err(reason) => outcome.skipped.push((tree.path.clone(), reason)),
        }
    }
    outcome
}

/// Foreign trees share directory names freely (`agent-*`, `/tmp/fix`), so the
/// snapshot ref also carries a digest of the full path.
fn snapshot_name(tree: &MachineWorktree) -> String {
    let dir = tree
        .path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let safe: String = dir
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let digest = xmatrix_cli_core::hex::sha256_hex(tree.path.to_string_lossy().as_bytes());
    format!("foreign/{}/{safe}-{}", tree.origin.label(), &digest[..8])
}

/// Working directories of every process on this machine. Harness sessions
/// started outside xMatrix are not in the daemon's registry, but their cwd
/// still sits in the tree they use.
#[cfg(target_os = "linux")]
fn process_cwds() -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.bytes().all(|byte| byte.is_ascii_digit()))
        })
        .filter_map(|entry| std::fs::read_link(entry.path().join("cwd")).ok())
        .collect()
}

/// Other platforms offer no cheap cwd listing; the idle floor alone guards
/// trees no xMatrix run is registered in.
#[cfg(not(target_os = "linux"))]
fn process_cwds() -> Vec<PathBuf> {
    Vec::new()
}

/// The daemon's sweep: only when the owner turned it on.
pub async fn reclaim_foreign_worktrees_if_enabled(
    live_cwds: &HashSet<PathBuf>,
    min_idle: Duration,
) -> Option<ForeignReclaimOutcome> {
    match foreign_auto_reclaim_enabled() {
        Ok(true) => {}
        Ok(false) => return None,
        Err(error) => {
            eprintln!("worktree reclaim: not reclaiming foreign worktrees: {error}");
            return None;
        }
    }
    let known: Vec<PathBuf> = live_cwds.iter().cloned().collect();
    let trees = machine_worktrees(&known).await;
    Some(reclaim_foreign_worktrees(&trees, live_cwds, None, min_idle, true).await)
}

pub fn log_foreign_reclaim_outcome(outcome: &ForeignReclaimOutcome) {
    if outcome.reclaimed.is_empty() && outcome.skipped.is_empty() {
        return;
    }
    eprintln!(
        "worktree reclaim: foreign trees reclaimed {:?} (snapshotted {:?}), in use {:?}, skipped {:?}",
        outcome.reclaimed, outcome.snapshotted, outcome.in_use, outcome.skipped
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    include!("../../core/tests/support/fs_cleanup.rs");

    use crate::test_support::{git_available, run_git, seed_remote, unique_temp_dir};

    /// A repository whose commit a remote already has, so only real WIP
    /// needs a snapshot.
    fn published_repo(dir: &Path) {
        let remote = dir.with_extension("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        seed_remote(&remote, dir);
    }

    fn add_worktree(base: &Path, path: &Path) {
        run_git(
            base,
            &[
                "worktree",
                "add",
                "--detach",
                "--quiet",
                &path.display().to_string(),
                "HEAD",
            ],
        );
    }

    fn roots_under(scratch: &Path) -> InventoryRoots {
        InventoryRoots {
            pools_root: Some(scratch.join("repo-pools")),
            run_worktrees_root: scratch.join("xmatrix").join("worktrees"),
            managed_repos_root: scratch.join("xmatrix").join("repos"),
            codex_worktrees_root: Some(scratch.join("codex").join("worktrees")),
            cursor_worktrees_root: Some(scratch.join("cursor").join("worktrees")),
        }
    }

    #[test]
    fn parses_porcelain_listing() {
        let listing = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /tmp/fix\nHEAD def\ndetached\nlocked held by me\n\nworktree /tmp/gone\nHEAD 123\nbranch refs/heads/feat/x\nprunable gitdir file points to non-existent location";
        let trees = parse_worktree_list(listing);
        assert_eq!(trees.len(), 3);
        assert_eq!(trees[0].branch.as_deref(), Some("main"));
        assert_eq!(trees[1].path, PathBuf::from("/tmp/fix"));
        assert_eq!(trees[1].branch, None);
        assert_eq!(trees[1].locked.as_deref(), Some("held by me"));
        assert_eq!(trees[2].branch.as_deref(), Some("feat/x"));
    }

    #[test]
    fn classifies_by_layout() {
        let scratch = unique_temp_dir("classify");
        let roots = roots_under(&scratch);
        let cases = [
            (
                scratch.join("repo-pools/b43d/abf4"),
                WorktreeOrigin::RepoPool,
            ),
            (
                scratch.join("xmatrix/worktrees/run-1"),
                WorktreeOrigin::RunWorktree,
            ),
            (
                scratch.join("codex/worktrees/a1/repo"),
                WorktreeOrigin::Codex,
            ),
            (
                scratch.join("cursor/worktrees/repo/x"),
                WorktreeOrigin::Cursor,
            ),
            (
                scratch.join("xmatrix/repos/r/.claude/worktrees/agent-1"),
                WorktreeOrigin::ClaudeCode,
            ),
            (PathBuf::from("/tmp/some-fix"), WorktreeOrigin::Manual),
        ];
        for (path, origin) in cases {
            assert_eq!(roots.classify(&path), origin, "{}", path.display());
        }
        cleanup_test_dirs(&[&scratch]);
    }

    #[test]
    fn foreign_auto_reclaim_is_off_until_turned_on() {
        let scratch = unique_temp_dir("policy");
        let path = scratch.join(POLICY_FILE);
        assert!(!read_foreign_auto_reclaim(&path).unwrap());
        std::fs::write(&path, r#"{"other": 1}"#).unwrap();
        assert!(!read_foreign_auto_reclaim(&path).unwrap());
        write_foreign_auto_reclaim(&path, true).unwrap();
        assert!(read_foreign_auto_reclaim(&path).unwrap());
        let kept: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(kept["other"], 1);
        write_foreign_auto_reclaim(&path, false).unwrap();
        assert!(!read_foreign_auto_reclaim(&path).unwrap());
        std::fs::write(&path, "not json").unwrap();
        assert!(read_foreign_auto_reclaim(&path).is_err());
        assert!(write_foreign_auto_reclaim(&path, true).is_err());
        cleanup_test_dirs(&[&scratch]);
    }

    #[tokio::test]
    async fn inventories_and_reclaims_only_foreign_trees() {
        if !git_available() {
            return;
        }
        let scratch = unique_temp_dir("inventory");
        let roots = roots_under(&scratch);
        let base = roots.managed_repos_root.join("owner-repo");
        std::fs::create_dir_all(&base).unwrap();
        published_repo(&base);
        let run_tree = roots.run_worktrees_root.join("run-abc");
        let claude_tree = base.join(".claude/worktrees/agent-1");
        let manual_tree = scratch.join("tmp").join("fix");
        let busy_tree = scratch.join("tmp").join("busy");
        for tree in [&run_tree, &claude_tree, &manual_tree, &busy_tree] {
            std::fs::create_dir_all(tree.parent().unwrap()).unwrap();
            add_worktree(&base, tree);
        }
        std::fs::write(manual_tree.join("wip.txt"), "unlanded").unwrap();

        // A Codex tree of a repository xMatrix never launched in.
        let outside = scratch.join("outside-repo");
        std::fs::create_dir_all(&outside).unwrap();
        published_repo(&outside);
        let codex_tree = roots
            .codex_worktrees_root
            .as_ref()
            .unwrap()
            .join("a1")
            .join("outside-repo");
        std::fs::create_dir_all(codex_tree.parent().unwrap()).unwrap();
        add_worktree(&outside, &codex_tree);

        let trees = machine_worktrees_at(&roots, &[]).await;
        let origin_of = |path: &Path| {
            trees
                .iter()
                .find(|tree| canonical(&tree.path) == canonical(path))
                .map(|tree| tree.origin)
        };
        assert_eq!(origin_of(&run_tree), Some(WorktreeOrigin::RunWorktree));
        assert_eq!(origin_of(&claude_tree), Some(WorktreeOrigin::ClaudeCode));
        assert_eq!(origin_of(&manual_tree), Some(WorktreeOrigin::Manual));
        assert_eq!(origin_of(&codex_tree), Some(WorktreeOrigin::Codex));
        assert_eq!(
            origin_of(&base),
            None,
            "a main worktree is not a linked tree"
        );

        let live: HashSet<PathBuf> = [busy_tree.clone()].into_iter().collect();
        let dry = reclaim_foreign_worktrees(&trees, &live, None, Duration::ZERO, false).await;
        assert_eq!(dry.reclaimed.len(), 3, "{dry:?}");
        assert!(manual_tree.exists());

        let outcome = reclaim_foreign_worktrees(&trees, &live, None, Duration::ZERO, true).await;
        let canonical_all =
            |paths: &[PathBuf]| paths.iter().map(|path| canonical(path)).collect::<Vec<_>>();
        assert_eq!(canonical_all(&outcome.in_use), vec![canonical(&busy_tree)]);
        assert!(
            run_tree.exists(),
            "xMatrix's own trees keep their own reclaim"
        );
        assert!(busy_tree.exists());
        assert!(!claude_tree.exists());
        assert!(!manual_tree.exists());
        assert!(!codex_tree.exists());
        assert_eq!(
            canonical_all(&outcome.snapshotted),
            vec![canonical(&manual_tree)]
        );
        let refs = std::process::Command::new("git")
            .arg("-C")
            .arg(&base)
            .args([
                "for-each-ref",
                "--format=%(refname)",
                "refs/xmatrix/snapshot/",
            ])
            .output()
            .unwrap();
        let refs = String::from_utf8_lossy(&refs.stdout);
        assert!(
            refs.contains("refs/xmatrix/snapshot/foreign/manual/fix-"),
            "{refs}"
        );

        let idle_floor =
            reclaim_foreign_worktrees(&trees, &live, None, Duration::from_secs(3600), true).await;
        assert!(idle_floor.reclaimed.is_empty());

        cleanup_test_dirs(&[&scratch]);
    }
}
