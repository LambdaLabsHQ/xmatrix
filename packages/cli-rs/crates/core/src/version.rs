//! The CLI's release version.
//!
//! Only the `xmatrix` binary crate carries the release version; every library
//! crate keeps a fixed package version. A release bump then changes one
//! crate's `CARGO_PKG_VERSION`, so the build cache still serves every library
//! crate the release did not change. The binary registers its version here
//! before anything else runs.

use std::sync::OnceLock;

static VERSION: OnceLock<&'static str> = OnceLock::new();

/// Called once, first thing, by the binary with its `CARGO_PKG_VERSION`.
pub fn register(version: &'static str) {
    let registered = VERSION.get_or_init(|| version);
    assert_eq!(*registered, version, "the CLI version is registered once");
}

/// The running CLI's release version. Without a registration (library
/// tests) it is `0.0.0-unregistered`, a version no release publishes, never
/// a plausible wrong one.
pub fn current() -> &'static str {
    VERSION.get().copied().unwrap_or("0.0.0-unregistered")
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_registered_version_is_the_current_one() {
        super::register("0.16.999");
        assert_eq!(super::current(), "0.16.999");
        super::register("0.16.999");
    }
}
