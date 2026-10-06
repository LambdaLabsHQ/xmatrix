//! Lowercase hex, and the SHA-256 hex digest most callers want.
//!
//! The one encoder for the CLI crates that depend on core. `xmatrix-harness`
//! and `xmatrix-windows-continuity` keep their own copy because they must not
//! depend on any other xmatrix crate.

use sha2::{Digest, Sha256};

/// Two lowercase hex digits per byte.
pub fn lowercase_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Lowercase hex of the SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    lowercase_hex(&Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn encodes_bytes_and_digests() {
        assert_eq!(lowercase_hex(&[]), "");
        assert_eq!(lowercase_hex(&[0x00, 0x0f, 0xa5, 0xff]), "000fa5ff");
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                rust_sources(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }

    /// Crates that depend on core read hex from here, not from a local copy.
    #[test]
    fn no_crate_on_core_writes_its_own_hex_encoder() {
        let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let standalone = ["harness", "windows-continuity"];
        let mut offenders = Vec::new();
        for entry in std::fs::read_dir(crates).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if standalone.contains(&name.as_str()) {
                continue;
            }
            let mut files = Vec::new();
            rust_sources(&entry.path().join("src"), &mut files);
            for file in files {
                if file.ends_with("core/src/hex.rs") {
                    continue;
                }
                let source = std::fs::read_to_string(&file).unwrap();
                if source.contains(":02x}") || source.contains("= b\"0123456789abcdef\"") {
                    offenders.push(file.display().to_string());
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "use xmatrix_cli_core::hex instead of a local hex encoder: {offenders:?}"
        );
    }
}
