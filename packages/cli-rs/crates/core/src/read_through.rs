//! How far this Run has read each Channel: the newest message sequence its
//! model was shown — in a turn prompt, its first prompt's history, a
//! `xmatrix channel history` read, or the diff a refused send printed.
//! `xmatrix send` offers it to the Hub, which refuses to append a message over
//! anything newer from someone else that the sender has not read.
//!
//! The wrapper keeps the record beside its status file and is the only one to
//! create it; the commands its model runs only move an existing record
//! forward. No record (an older wrapper, a Run without a status file, a
//! Channel this Run never read) offers nothing, and the Hub checks nothing.
//! The record only ever restricts this Run's own sends; the Hub's timeline
//! stays the one source of what is newer.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// More Channels than one Run reads; past it a new Channel goes unrecorded.
const MAX_CHANNELS: usize = 256;

fn record_path() -> Option<PathBuf> {
    let mut path = std::env::var_os("XMATRIX_RUN_STATUS_FILE")?;
    path.push(".read-through");
    Some(PathBuf::from(path))
}

/// The wrapper showed its model `channel_id` through `sequence`.
pub fn record(channel_id: &str, sequence: u64) {
    if let Some(path) = record_path() {
        update(&path, channel_id, sequence, true);
    }
}

/// A command showed the model `channel_id` through `sequence`. Only a record
/// the wrapper started moves; outside a recording Run this does nothing.
pub fn advance(channel_id: &str, sequence: u64) {
    if let Some(path) = record_path() {
        update(&path, channel_id, sequence, false);
    }
}

/// How far this Run has read `channel_id`, if it keeps a record of it.
pub fn current(channel_id: &str) -> Option<u64> {
    current_at(&record_path()?, channel_id)
}

fn read(path: &Path) -> Option<BTreeMap<String, u64>> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn current_at(path: &Path, channel_id: &str) -> Option<u64> {
    read(path)?.get(channel_id).copied()
}

/// Raise `channel_id` to `sequence`, never lower it. The wrapper and a command
/// can write at once and one advance may be lost; that only makes the next
/// send stricter, and its refusal reads the difference again.
fn update(path: &Path, channel_id: &str, sequence: u64, create: bool) {
    if channel_id.is_empty() || sequence == 0 {
        return;
    }
    let mut channels = match read(path) {
        Some(channels) => channels,
        None if create => BTreeMap::new(),
        None => return,
    };
    if channels.len() >= MAX_CHANNELS && !channels.contains_key(channel_id) {
        return;
    }
    let entry = channels.entry(channel_id.to_string()).or_insert(0);
    if *entry >= sequence {
        return;
    }
    *entry = sequence;
    let Ok(encoded) = serde_json::to_vec(&channels) else {
        return;
    };
    let mut staged = path.as_os_str().to_owned();
    staged.push(format!(".{}.tmp", std::process::id()));
    let staged = PathBuf::from(staged);
    if std::fs::write(&staged, encoded).is_err() || std::fs::rename(&staged, path).is_err() {
        let _ = std::fs::remove_file(&staged);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_wrapper_starts_a_record_and_it_never_moves_back() {
        let dir =
            std::env::temp_dir().join(format!("xmatrix-read-through-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("status.json.read-through");

        // A command run outside a recording wrapper claims nothing.
        update(&path, "channel:1", 7, false);
        assert!(!path.exists());
        assert_eq!(current_at(&path, "channel:1"), None);

        update(&path, "channel:1", 7, true);
        update(&path, "channel:1", 5, false);
        update(&path, "channel:2", 3, false);
        assert_eq!(current_at(&path, "channel:1"), Some(7));
        assert_eq!(current_at(&path, "channel:2"), Some(3));
        update(&path, "channel:1", 9, false);
        assert_eq!(current_at(&path, "channel:1"), Some(9));

        // An unreadable record offers nothing until the wrapper writes it again.
        std::fs::write(&path, b"{").unwrap();
        update(&path, "channel:1", 12, false);
        assert_eq!(current_at(&path, "channel:1"), None);
        update(&path, "channel:1", 11, true);
        assert_eq!(current_at(&path, "channel:1"), Some(11));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
