//! Repo-key warm worktree pool (S1 + L1).
//!
//! Explicit remote-repo runs use this crate-private API for exact lease,
//! retain, reborn, and typed-abandon transitions.

// Domain-oriented include sections (same module scope via include!).
// Remaining peels stay include! until they gain explicit pub(crate) boundaries.
include!("repo_pool_manifest.rs");
include!("repo_pool_reclaim.rs");
include!("repo_pool_rehydrate.rs");
include!("repo_pool_handoff.rs");
include!("repo_pool_tests.rs");
