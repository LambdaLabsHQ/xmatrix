/// Cloudflare emits this exact server frame while replacing a Durable Object
/// runtime. It is a transient transport boundary, not an authentication or
/// product-protocol rejection.
pub(crate) fn durable_object_runtime_reset(message: &str) -> bool {
    message
        .trim()
        .eq_ignore_ascii_case("Durable Object reset because its code was updated.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_only_the_exact_durable_object_runtime_reset() {
        assert!(durable_object_runtime_reset(
            "Durable Object reset because its code was updated."
        ));
        assert!(durable_object_runtime_reset(
            " durable object reset because its code was updated. "
        ));
        assert!(!durable_object_runtime_reset(
            "Missing bearer or basic authentication in header"
        ));
        assert!(!durable_object_runtime_reset(
            "Durable Object reset because storage was deleted."
        ));
    }
}
