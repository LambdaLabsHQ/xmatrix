//! DeepSeek prepaid balance, read from the official balance endpoint behind
//! the API key DeepSeek Harness (`dsh`) already holds.
//!
//! DeepSeek bills an API key against a prepaid balance: there is no window, no
//! share used and no reset, only an amount in one currency and the provider's
//! word on whether it still covers a request. The reading therefore carries no
//! `quota_usages`; it is the account's `allowed` verdict plus its credits as an
//! amount and a currency.
//!
//! The key is resolved the way `dsh` resolves `DEEPSEEK_API_KEY`: the stored
//! credential file under the harness home first, then the launch environment,
//! then the harness-home `.env`. The account route (`deepseek-account`) signs
//! in with a token this endpoint does not take, so it has no reading here.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::cache::ProviderUsageCache;
use crate::fields::{first_f64, first_string};
use crate::host::{home_dir_path, provider_client};
use crate::usage::{LlmQuotaAccount, LlmQuotaCredits, LlmUsage};

const DEEPSEEK_BALANCE_URL: &str = "https://api.deepseek.com/user/balance";
const DEEPSEEK_API_KEY_REF: &str = "DEEPSEEK_API_KEY";
/// The `dsh` route that authenticates with the API key.
const DEEPSEEK_API_KEY_ROUTE: &str = "deepseek-official";

static DEEPSEEK_BALANCE: ProviderUsageCache = ProviderUsageCache::account_meter();

/// The harness home: `$DSH_HOME` unless blank, else `~/.dsh`.
fn dsh_home() -> Option<PathBuf> {
    let home = home_dir_path();
    match std::env::var("DSH_HOME") {
        Ok(value) if !value.trim().is_empty() => {
            let value = value.trim();
            match value
                .strip_prefix("~/")
                .or_else(|| value.strip_prefix("~\\"))
            {
                Some(rest) => home.map(|home| home.join(rest)),
                None if value == "~" => home,
                None => Some(PathBuf::from(value)),
            }
        }
        _ => home.map(|home| home.join(".dsh")),
    }
}

/// A scalar as YAML or dotenv wrote it: one layer of matching quotes removed,
/// and an unquoted value cut at its trailing comment.
fn unquoted_scalar(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let value = match raw.chars().next()? {
        quote @ ('"' | '\'') => raw[1..].split(quote).next()?,
        _ => raw.split(" #").next()?.trim(),
    };
    (!value.is_empty()).then(|| value.to_string())
}

/// `refs.<name>` of the stored credential file (`version: 1`, a `refs:`
/// mapping of key values by environment-variable name).
fn credential_file_ref(document: &str, name: &str) -> Option<String> {
    let mut in_refs = false;
    for line in document.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if !line.starts_with([' ', '\t']) {
            in_refs = line.trim_end() == "refs:";
            continue;
        }
        if in_refs
            && let Some((key, value)) = line.trim().split_once(':')
            && unquoted_scalar(key).as_deref() == Some(name)
        {
            return unquoted_scalar(value);
        }
    }
    None
}

/// `<name>=<value>` of a dotenv file.
fn dotenv_value(document: &str, name: &str) -> Option<String> {
    document.lines().find_map(|line| {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line);
        let (key, value) = line.split_once('=')?;
        (key.trim() == name).then(|| unquoted_scalar(value))?
    })
}

fn deepseek_api_key_in(home: Option<&Path>, inherited: Option<String>) -> Option<String> {
    let read = |file: &str| std::fs::read_to_string(home?.join(file)).ok();
    read(".credentials.yaml")
        .and_then(|document| credential_file_ref(&document, DEEPSEEK_API_KEY_REF))
        .or_else(|| inherited.and_then(|value| unquoted_scalar(&value)))
        .or_else(|| read(".env").and_then(|document| dotenv_value(&document, DEEPSEEK_API_KEY_REF)))
}

/// A key sent to another endpoint (`DEEPSEEK_BASE_URL`) is not an account
/// whose balance the official API can state.
fn official_endpoint() -> bool {
    match std::env::var("DEEPSEEK_BASE_URL") {
        Ok(value) if !value.trim().is_empty() => {
            let rest = value.trim().trim_start_matches("https://");
            rest.split(['/', ':']).next() == Some("api.deepseek.com")
        }
        _ => true,
    }
}

/// Whether the session's model spends the API key. `dsh` names a model as a
/// JSON pair of route and model (`["deepseek-official","deepseek-flash"]`); a
/// model on another route (the account login, a third-party provider) does
/// not. An unknown or differently spelled model is taken to spend the key.
fn model_spends_api_key(model: Option<&str>) -> bool {
    let route = model
        .and_then(|model| serde_json::from_str::<Value>(model.trim()).ok())
        .and_then(|value| value.get(0)?.as_str().map(str::to_string));
    route.is_none_or(|route| route == DEEPSEEK_API_KEY_ROUTE)
}

/// The prepaid balance behind the key `dsh` would use for `model`.
pub async fn read_deepseek_balance_for_model(force: bool, model: Option<&str>) -> Option<LlmUsage> {
    if !model_spends_api_key(model) {
        return None;
    }
    read_deepseek_balance(force).await
}

/// The prepaid balance behind the DeepSeek API key `dsh` holds.
pub async fn read_deepseek_balance(force: bool) -> Option<LlmUsage> {
    if super::quota_probes_disabled() {
        return None;
    }
    if let Some(cached) = DEEPSEEK_BALANCE.hit_unless_forced(force) {
        return cached;
    }
    let key = official_endpoint()
        .then(|| {
            deepseek_api_key_in(
                dsh_home().as_deref(),
                std::env::var(DEEPSEEK_API_KEY_REF).ok(),
            )
        })
        .flatten();
    let Some(key) = key else {
        return DEEPSEEK_BALANCE.unavailable();
    };
    let value = DEEPSEEK_BALANCE
        .fetch_json(
            "deepseek",
            provider_client()
                .get(DEEPSEEK_BALANCE_URL)
                .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
                .header(reqwest::header::ACCEPT, "application/json"),
        )
        .await?;
    let usage = deepseek_balance_usage_from_value(&value);
    DEEPSEEK_BALANCE.store(usage.clone());
    usage
}

/// `{ "is_available": true, "balance_infos": [ { "currency": "CNY",
/// "total_balance": "110.00", "granted_balance": "10.00",
/// "topped_up_balance": "100.00" } ] }`. An account holding two currencies
/// reports the one that still has money.
pub(crate) fn deepseek_balance_usage_from_value(value: &Value) -> Option<LlmUsage> {
    let balances: Vec<(f64, String)> = value
        .get("balance_infos")?
        .as_array()?
        .iter()
        .filter_map(|entry| {
            let entry = entry.as_object()?;
            let balance = first_f64(entry, &["total_balance"])
                .filter(|balance| balance.is_finite() && *balance >= 0.0)?;
            let currency = first_string(entry, &["currency"])
                .filter(|code| code.len() == 3 && code.bytes().all(|b| b.is_ascii_alphabetic()))?
                .to_ascii_uppercase();
            Some((balance, currency))
        })
        .collect();
    let (balance, currency) = balances
        .iter()
        .find(|(balance, _)| *balance > 0.0)
        .or(balances.first())?
        .clone();
    Some(LlmUsage {
        quota_source: Some("provider_api".to_string()),
        quota_observed_at: super::observed_now(),
        quota_account: Some(LlmQuotaAccount {
            allowed: value.get("is_available").and_then(Value::as_bool),
            credits: Some(LlmQuotaCredits {
                balance: Some(balance),
                currency: Some(currency),
                unlimited: false,
            }),
        }),
        ..LlmUsage::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn balance_is_an_amount_in_a_currency_with_the_provider_verdict() {
        let usage = deepseek_balance_usage_from_value(&json!({
            "is_available": true,
            "balance_infos": [{ "currency": "CNY", "total_balance": "110.00",
                "granted_balance": "10.00", "topped_up_balance": "100.00" }]
        }))
        .unwrap();
        assert_eq!(usage.quota_source.as_deref(), Some("provider_api"));
        assert!(usage.quota_observed_at.is_some());
        assert!(usage.quota_usages.is_none());
        assert!(crate::usage::has_llm_usage(&usage));
        let account = usage.quota_account.unwrap();
        assert_eq!(account.allowed, Some(true));
        let credits = account.credits.unwrap();
        assert_eq!(credits.balance, Some(110.0));
        assert_eq!(credits.currency.as_deref(), Some("CNY"));
    }

    #[test]
    fn the_currency_with_money_is_reported_and_an_empty_account_reads_zero() {
        let usage = deepseek_balance_usage_from_value(&json!({
            "is_available": true,
            "balance_infos": [
                { "currency": "CNY", "total_balance": "0.00" },
                { "currency": "usd", "total_balance": "3.5" }
            ]
        }))
        .unwrap();
        let credits = usage.quota_account.unwrap().credits.unwrap();
        assert_eq!(
            (credits.balance, credits.currency.as_deref()),
            (Some(3.5), Some("USD"))
        );

        let empty = deepseek_balance_usage_from_value(&json!({
            "is_available": false,
            "balance_infos": [{ "currency": "CNY", "total_balance": "0.00" }]
        }))
        .unwrap();
        let account = empty.quota_account.unwrap();
        assert_eq!(account.allowed, Some(false));
        assert_eq!(account.credits.unwrap().balance, Some(0.0));
    }

    #[test]
    fn a_body_without_a_balance_is_not_a_reading() {
        for body in [
            json!({ "error": { "message": "Authentication Fails" } }),
            json!({ "is_available": true, "balance_infos": [] }),
            json!({ "is_available": true, "balance_infos": [{ "currency": "CNY" }] }),
            json!({ "balance_infos": [{ "currency": "yuan", "total_balance": "1" }] }),
        ] {
            assert!(deepseek_balance_usage_from_value(&body).is_none(), "{body}");
        }
    }

    #[test]
    fn the_key_resolves_as_the_harness_resolves_it() {
        let home = std::env::temp_dir().join(format!("xmatrix-dsh-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let key = |inherited: Option<&str>| {
            deepseek_api_key_in(Some(&home), inherited.map(str::to_string))
        };
        assert_eq!(key(None), None);
        std::fs::write(
            home.join(".env"),
            "# home\nexport DEEPSEEK_API_KEY='sk-env-file'\n",
        )
        .unwrap();
        assert_eq!(key(None).as_deref(), Some("sk-env-file"));
        assert_eq!(key(Some(" sk-launch ")).as_deref(), Some("sk-launch"));
        std::fs::write(
            home.join(".credentials.yaml"),
            "version: 1\n\nrefs:\n  # note\n  OPENAI_API_KEY: sk-other\n  DEEPSEEK_API_KEY: \"sk-stored\" # mine\n\nrecords:\n  llm/x:\n    DEEPSEEK_API_KEY: sk-record\n",
        )
        .unwrap();
        assert_eq!(key(Some("sk-launch")).as_deref(), Some("sk-stored"));
        std::fs::write(
            home.join(".credentials.yaml"),
            "version: 1\nrefs:\n  OPENAI_API_KEY: sk-other\n",
        )
        .unwrap();
        assert_eq!(key(Some("sk-launch")).as_deref(), Some("sk-launch"));
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn only_a_model_on_the_api_key_route_spends_the_key() {
        assert!(model_spends_api_key(None));
        assert!(model_spends_api_key(Some("deepseek-flash")));
        assert!(model_spends_api_key(Some(
            r#"["deepseek-official","deepseek-flash"]"#
        )));
        assert!(!model_spends_api_key(Some(
            r#"["deepseek-account","deepseek-flash"]"#
        )));
        assert!(!model_spends_api_key(Some(r#"["llm-pi-ai","gpt-5"]"#)));
    }
}
