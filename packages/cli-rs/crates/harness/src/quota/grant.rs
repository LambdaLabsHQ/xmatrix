//! Reading a harness's local sign-in only on its owner's word.
//!
//! Some harnesses (Cursor, and OpenCode before 2.2.0) offer no official way
//! to ask for their quota: the only answer is to read the sign-in that harness stored for itself and call
//! the provider's dashboard with it. That sign-in exists for the harness, not
//! as permission for xMatrix to use it, so its reader takes a
//! [`SignInReadGrant`] — a person's explicit, per-machine permission — and
//! opens no credential source without one.
//!
//! A grant is bound to the sign-in it was first used with: a local-only
//! fingerprint of that account, keyed by a random per-grant key so it cannot
//! be compared across grants or machines. When the account or credential
//! changes, the reader reports [`GrantedRead::SignInChanged`] instead of
//! asking the provider, and the caller voids the grant.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::usage::LlmUsage;

/// A person's permission to read one harness's local sign-in on this machine,
/// only to ask that harness's provider for its own usage. It never leaves the
/// machine: the fingerprint is compared here and nowhere else.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignInReadGrant {
    /// Random per-grant key the fingerprint is keyed with.
    pub key: String,
    /// Fingerprint of the sign-in the grant is bound to; `None` until the
    /// first read under the grant binds it.
    #[serde(rename = "signIn", default, skip_serializing_if = "Option::is_none")]
    pub sign_in: Option<String>,
}

impl SignInReadGrant {
    /// A new, unbound grant under `key` (the caller supplies the randomness).
    pub fn new(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            sign_in: None,
        }
    }
}

/// What a read under a grant did.
#[derive(Clone, Debug)]
pub enum GrantedRead {
    /// No grant, or every quota probe is switched off: nothing was opened or read.
    Closed,
    /// The sign-in differs from the one the grant is bound to. The provider
    /// was not asked; the grant is void and its last reading must be dropped.
    SignInChanged,
    /// The sign-in's token has expired. The provider was not asked and the
    /// token was not refreshed on the harness's behalf; its last reading is
    /// dropped until the harness signs in again.
    SignInExpired,
    /// Read under the grant. `bound` is the fingerprint this read bound an
    /// unbound grant to, for the caller to keep with the grant.
    Read {
        usage: Option<LlmUsage>,
        bound: Option<String>,
    },
}

/// How a sign-in compares with the grant it is read under.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum GrantMatch {
    /// The grant's own sign-in; `bound` is set when this read binds it.
    Same {
        bound: Option<String>,
    },
    Changed,
}

pub(crate) fn match_grant(grant: &SignInReadGrant, token: &str) -> GrantMatch {
    let fingerprint = sign_in_fingerprint(&grant.key, token);
    match grant.sign_in.as_deref() {
        None => GrantMatch::Same {
            bound: Some(fingerprint),
        },
        Some(bound) if bound == fingerprint => GrantMatch::Same { bound: None },
        Some(_) => GrantMatch::Changed,
    }
}

/// The account a credential signs in as: a JWT's subject when the token is
/// one (so a refreshed token of the same account keeps its grant), else the
/// credential itself (an API key).
fn sign_in_identity(token: &str) -> String {
    jwt_subject(token)
        .map(|subject| format!("sub:{subject}"))
        .unwrap_or_else(|| format!("credential:{token}"))
}

fn jwt_subject(token: &str) -> Option<String> {
    use base64::Engine;
    let mut parts = token.split('.');
    let (_, payload, _) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    claims
        .get("sub")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|subject| !subject.is_empty())
        .map(str::to_string)
}

/// Keyed digest of the sign-in's account; meaningful only beside its grant.
pub(crate) fn sign_in_fingerprint(key: &str, token: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"xmatrix-sign-in-read-grant-v1\0");
    digest.update(key.as_bytes());
    digest.update(b"\0");
    digest.update(sign_in_identity(token).as_bytes());
    crate::host::lowercase_hex(&digest.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn jwt(subject: &str, issued: u64) -> String {
        let encode = |value: serde_json::Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
        };
        format!(
            "{}.{}.signature",
            encode(serde_json::json!({"alg": "HS256"})),
            encode(serde_json::json!({"sub": subject, "iat": issued}))
        )
    }

    #[test]
    fn the_first_read_binds_and_a_refreshed_token_of_that_account_keeps_the_grant() {
        let grant = SignInReadGrant::new("grant-key");
        let GrantMatch::Same { bound: Some(bound) } = match_grant(&grant, &jwt("user_a", 1)) else {
            panic!("an unbound grant binds on its first read");
        };
        let bound_grant = SignInReadGrant {
            sign_in: Some(bound),
            ..grant
        };
        assert_eq!(
            match_grant(&bound_grant, &jwt("user_a", 2)),
            GrantMatch::Same { bound: None }
        );
        assert_eq!(
            match_grant(&bound_grant, &jwt("user_b", 2)),
            GrantMatch::Changed
        );
    }

    #[test]
    fn another_api_key_is_another_sign_in() {
        let grant = SignInReadGrant::new("grant-key");
        let GrantMatch::Same { bound } = match_grant(&grant, "key_one") else {
            panic!("binds");
        };
        let grant = SignInReadGrant {
            sign_in: bound,
            ..grant
        };
        assert_eq!(
            match_grant(&grant, "key_one"),
            GrantMatch::Same { bound: None }
        );
        assert_eq!(match_grant(&grant, "key_two"), GrantMatch::Changed);
    }

    #[test]
    fn a_fingerprint_names_nothing_of_the_sign_in_and_differs_per_grant() {
        let token = jwt("user_sentinel", 1);
        let one = sign_in_fingerprint("key-one", &token);
        let two = sign_in_fingerprint("key-two", &token);
        assert_ne!(one, two);
        for fingerprint in [&one, &two] {
            assert!(
                !fingerprint.contains("user_sentinel") && !token.contains(fingerprint.as_str())
            );
        }
    }
}
