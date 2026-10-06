//! Filesystem reads that distinguish an absent path from other failures.
use std::{fs::Metadata, io, path::Path};

/// Do not follow symlinks: the caller owns file-type and size admission.
pub fn metadata_if_exists(path: &Path) -> io::Result<Option<Metadata>> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// For an attempted file operation, absence is optional; all other I/O failures survive.
pub fn missing_file_as_none<T>(result: io::Result<T>) -> io::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}
