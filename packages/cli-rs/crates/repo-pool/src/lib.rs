//! The repo-key warm worktree pool (S1+L1) for explicit repo runs and typed
//! abandon transitions, and the per-run worktrees it hands out.
#![deny(warnings)]

mod failure_detail;
pub mod repo_pool;
pub mod run_worktree;

#[cfg(test)]
include!("../../core/tests/support/process_env.rs");
