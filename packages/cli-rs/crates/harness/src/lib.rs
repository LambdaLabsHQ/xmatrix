#![deny(warnings)]
//! `xmatrix-harness` drives the facts an agent harness (Claude Code, Codex,
//! ACP agents such as Kimi, Grok, Cursor, OpenCode) exposes about itself, as a
//! library with no dependency on the rest of xMatrix.
//!
//! Today it owns:
//! - [`usage`]: the normalized token/context/quota usage types every harness
//!   reports, whose serde shape is part of the xMatrix Hub protocol;
//! - [`quota`]: account-quota probes for each provider, behind one
//!   [`quota::read`] entrypoint plus per-provider readers and pure parsers;
//! - [`fields`]: tolerant JSON field readers the parsers share.
//!
//! See `README.md` for the boundary and what is not yet extracted.

mod claude_credentials;
pub mod fields;
mod host;
pub mod quota;
pub mod usage;

pub use host::home_dir_path;
pub use usage::{LlmQuotaUsage, LlmUsage};
