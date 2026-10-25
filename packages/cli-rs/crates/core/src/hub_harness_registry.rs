//! The harness registry (`agent-presets.json`) as the Hub last sent it.
//!
//! A daemon declaring [`CAPABILITY`] receives the Hub's registry text in its
//! connected frame whenever it differs from what the daemon reported holding
//! ([`held_sha256`]). The daemon keeps it beside its config, where every
//! process of this CLI on the machine reads it (`xmatrix_cli_agent::agent_presets`),
//! so a harness added or a recipe changed reaches the machine with a Hub deploy.
//! A machine that never heard from the Hub uses the copy compiled into its CLI.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

pub const CAPABILITY: &str = "hub_harness_registry_v1";
const FILE: &str = "hub-harness-registry.json";

/// Bumped each time this process records a different registry, so a
/// long-lived daemon reads the new one without restarting.
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn path() -> PathBuf {
    crate::config::config_dir().join(FILE)
}

/// The registry text the Hub last sent, if this machine holds one.
pub fn read() -> Option<String> {
    read_at(&path())
}

fn read_at(path: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .filter(|text| !text.trim().is_empty())
}

/// What this process has recorded since it started; see [`GENERATION`].
pub fn generation() -> u64 {
    GENERATION.load(Ordering::Acquire)
}

/// The digest the daemon reports on connect, so an unchanged registry is not
/// sent again.
pub fn held_sha256() -> Option<String> {
    read().map(|text| crate::hex::sha256_hex(text.as_bytes()))
}

/// Keeps the Hub's registry text. Written through a temporary file and a
/// rename, so a reader never sees half of it; an unchanged text is not
/// rewritten. A failed write is reported and leaves the previous registry.
pub fn record(text: &str) {
    record_at(&path(), text);
}

fn record_at(path: &std::path::Path, text: &str) {
    if text.trim().is_empty() || read_at(path).as_deref() == Some(text) {
        return;
    }
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(&temporary, text))
        .and_then(|()| std::fs::rename(&temporary, path));
    match written {
        Ok(()) => {
            GENERATION.fetch_add(1, Ordering::AcqRel);
        }
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            eprintln!("⚠ Could not keep the Hub's harness registry: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recorded_registry_is_read_back_and_an_unchanged_one_is_not_rewritten() {
        let dir = std::env::temp_dir().join(format!("xmatrix-registry-{}", std::process::id()));
        let path = dir.join(FILE);
        assert_eq!(read_at(&path), None);
        let before = generation();
        record_at(&path, "[{\"id\":\"codex\"}]");
        assert_eq!(read_at(&path).as_deref(), Some("[{\"id\":\"codex\"}]"));
        assert_eq!(generation(), before + 1);
        record_at(&path, "[{\"id\":\"codex\"}]");
        record_at(&path, "  ");
        assert_eq!(generation(), before + 1);
        record_at(&path, "[]");
        assert_eq!(read_at(&path).as_deref(), Some("[]"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
