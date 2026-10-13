# Google Ads connector

`googleads` lets people and Agents configure advertising and read performance
from one explicitly selected advertiser account. It has a separate Google OAuth
grant and encrypted credentials, while reusing the company's Google OAuth
application. It does not borrow Drive, Analytics, Search Console or GCP tokens.
The Hub uses Google Ads API **v25** over HTTPS; no developer token is requested,
stored or sent. Google retired developer tokens on September 9, 2026 and now
assigns API access to the Cloud project that owns the OAuth client.

This document defines the implementation and acceptance contract. Registration,
production deployment and native acceptance are recorded separately in the
Space's Connector application registration page; code or fixture tests alone
do not establish native acceptance.

## Connect

1. Enable `googleads.googleapis.com` in the company OAuth client's Cloud project.
   Apply for **Explorer** or higher access in that project's Google Ads API
   overview. Test access cannot call live advertiser accounts. A manager account
   is not required for API enrollment. Explorer supports the campaign operations
   here; account creation, account/user management, planning and billing services
   have separate restrictions.
2. Add `https://www.googleapis.com/auth/adwords` to the company's Google consent
   configuration. This scope permits reads and writes; Google Ads does not offer
   a separate read-only OAuth scope. Google account roles and xMatrix Channel
   policies still apply. The connector rejects a grant with unrelated scopes,
   refresh errors and incomplete expiring credentials.
3. In Space **Apps → Google Ads → Credentials**, set `customerId` to the selected
   advertiser's ten-digit ID, with or without dashes. Set `loginCustomerId` only
   when accessing the advertiser through a Google Ads manager account.
4. Connect with Google, using the Google user authorized to that advertiser.
   A Testing OAuth app requires that user in its test-user list. Run **Check**.
   If the initial callback lacks a customer ID, save it and retry Check; do not
   repeatedly authorize. Check must record the connection as configured and
   confirm this exact advertiser's ID, currency and time zone. A successful
   accessible-account listing or another account does not prove that check.

An External OAuth app left in **Testing** issues these refresh tokens with a
seven-day lifetime. This can support an explicitly recorded native acceptance
session, but it is not durable authorization for unattended advertising.
Production automation needs the app's publishing/verification prerequisites
completed and fresh consent; even production tokens can later be revoked.
Expired or revoked credentials fail closed and cannot guarantee a later
automatic pause. Do not present Testing consent as permanent campaign control.

OAuth uses the existing canonical `CONNECTOR_GOOGLE_CLIENT_ID` and
`CONNECTOR_GOOGLE_CLIENT_SECRET` and normal company callback. Tokens remain
managed encrypted credentials. `customerId` and the optional `loginCustomerId`
are saved through the same admin-only configuration boundary. Every account
query or mutation checks the current selected customer before provider I/O;
nested mutation references cannot target another customer. Reconnecting does
not silently change the selected advertiser.

Provider failures expose typed Google status, reason and Ads error codes, not
raw error bodies, ad copy or credentials. In v25,
`CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` identifies an API access-level
problem in the OAuth client's project. It is not fixed by adding a developer
token or consenting to an unrelated scope.

## Actions

Commands use `@googleads:<action>:<target> <text>`. The Run's connectors MCP
exposes the same actions with `target` and `text` parameters.

| Action | Target and text | Effect |
| --- | --- | --- |
| `list_accounts` | `*` | At most 100 directly accessible customer IDs; does not traverse managers or change the selected account |
| `read_account` | `<customer ID>` | Account ID, name, currency, time zone and manager/test flags |
| `query` | `<customer ID> <SELECT GAQL query>` | Campaigns, budgets, ads, assets, targeting, spend, conversions and other account reports |
| `validate_mutations` | `<customer ID> {"currencyCode":"USD","mutateOperations":[…]}` | Google validates the proposed changes with `validateOnly=true`; no changes or activation |
| `mutate` | The same mutation JSON | One atomic configuration request; new campaigns must be paused |
| `set_campaign_status` | `<customer ID>/<campaign ID> {"status":"PAUSED"}` | Pause one campaign |
| `set_campaign_status` | `<customer ID>/<campaign ID> {"status":"ENABLED","currencyCode":"USD","expectedDailyBudgetMicros":"1000000"}` | Verify currency and the current dedicated DAILY budget, then atomically apply that approved amount/budget reference and enable |

Both write actions default to **ask** for each request. A Human Space admin can
choose `allow`, `ask` or `disallow` for each action in a Channel. Agent commands
cannot change that policy. Approval freezes the request; the Hub rechecks
current Channel access/policy immediately before dispatch, including after
provider preflight. A revoked policy, a different selected customer, a currency
mismatch or a changed/shared activation budget stops the write at preflight.
Google has no compare-and-swap for these fields: activation atomically reasserts
the approved average amount and exact budget reference with the status change.
This closes the gap between the preflight read and write instead of claiming
the provider snapshot cannot change. A concurrent switch to a shared budget
cannot be reset to non-shared and makes Google reject the whole transaction.

GAQL queries must begin with SELECT and contain one statement without comments.
A final LIMIT is 1–250; absent LIMIT becomes 250. These are bounded queries, not
complete exports. Use explicit resource filters/keyset queries for larger sets.
Responses are byte-bounded, fenced as untrusted text and capped at 16,000
retrieved characters with an explicit truncation notice. Report dates use the
account time zone. Integer Micros fields are millionths of the account currency;
they are not automatically converted into dollars or the operator's currency.

`mutateOperations` contains 1–25 create/update operations, at most 32,000 input
characters. Supported resource operations are campaigns, campaign budgets,
campaign criteria/assets, ad groups, ad-group criteria/ads/assets, ads, assets,
asset groups, asset-group assets and asset-group signals. These use Google's
v25 resource JSON and explicit update masks. Google remains authoritative for
required fields, policy checks and supported channel-specific configurations.
Use existing uploaded asset IDs when a media payload exceeds the input bounds.

Creation can link temporary negative resource IDs in one request, such as a
budget and campaign. The Hub fixes `partialFailure=false` and requests resource
names. New campaign budgets must set `explicitlyShared=false`. Monetary fields
ending in Micros are decimal strings within signed 64-bit range, avoiding
JavaScript rounding. The top-level currency is checked against the live account.
Wildcards, resource removal, payer/account/access changes, conversion uploads and
arbitrary service/URL dispatch are excluded. Actual campaign activation cannot
be smuggled into `mutate`: use `set_campaign_status`. Validation can check a
proposed activation, but its provider request always fixes `validateOnly=true`.

Writes are sent once. A timeout, server failure or incomplete/mismatched receipt
is an **unconfirmed outcome**, not proof nothing happened. Query the relevant
resources before another create request; the connector never retries an
uncertain provider mutation. Google ad approval and serving are asynchronous.
An accepted mutation or ENABLED status does not prove that an ad has served.

Google's average daily budget is **not a hard daily spending cap**. On many
campaigns a day can spend up to twice that average, with Google's separate
monthly charging limit. Neither `expectedDailyBudgetMicros`, approval nor a
periodic performance query creates an account-wide or instantaneous spend cap.
Actual activation still needs an explicit authorized promotion target and
budget; a connector acceptance test must not start spending by inference.

## Examples

Read campaign performance using dates in the selected account's time zone:

```text
@googleads:read_account:1234567890
@googleads:query:1234567890 SELECT campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_7_DAYS ORDER BY campaign.id LIMIT 50
```

A paused Search campaign and its dedicated $1 average daily budget:

```json
{
  "currencyCode": "USD",
  "mutateOperations": [
    {
      "campaignBudgetOperation": {
        "create": {
          "resourceName": "customers/1234567890/campaignBudgets/-1",
          "name": "Search budget",
          "amountMicros": "1000000",
          "deliveryMethod": "STANDARD",
          "explicitlyShared": false
        }
      }
    },
    {
      "campaignOperation": {
        "create": {
          "name": "Search campaign",
          "status": "PAUSED",
          "advertisingChannelType": "SEARCH",
          "campaignBudget": "customers/1234567890/campaignBudgets/-1",
          "manualCpc": {},
          "containsEuPoliticalAdvertising": "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
          "networkSettings": {
            "targetGoogleSearch": true,
            "targetSearchNetwork": false,
            "targetContentNetwork": false
          }
        }
      }
    }
  ]
}
```

Supply that JSON as `text` to `validate_mutations` first. A real create needs
`mutate` and its write approval or authorized Channel policy. The political-ad
declaration must reflect the actual campaign; the connector does not infer it.
Add valid ad groups, keywords, geographic/language criteria and creatives using
the same resource operations before explicitly enabling a campaign.

## Stable acceptance

After required CI, merge and release through Production Release Intent, verify
the exact stable Hub/Web release and recorded receipt. Then, on stable:

1. Complete native company OAuth, configure the selected advertiser and prove
   **Check → configured**. Verify the Google account ID/currency/time zone.
2. Read actual campaign state and spend/conversions through the Run's connector,
   comparing results with native Google Ads and preserving report/date scope.
3. Prove default ask/disallow cannot dispatch a provider write. A Human admin
   approves each isolated acceptance request or enables the named Channel action.
4. Validate and create an unmistakable **paused** acceptance campaign with a
   dedicated budget, targeting and ad; query it and verify the same resources
   in Google Ads. Update its budget/creative, pause it and verify the results.
5. Validate proposed activation without executing it; reject mismatched currency
   or expected budget and exercise Channel revocation before dispatch. Successful
   real activation/serving requires a separately authorized promotion and budget;
   record it as untested until its real evidence exists.
6. Revoke/disconnect the grant and prove later actions fail. Reconnect using new
   native consent and recheck the selected customer. Do not alter other Google
   connections or mark native acceptance complete from fixture/visibility checks.

An open PR, deployed manifest, HTTP success or token presence is not this
acceptance. Keep provider approval/brand verification, stable release, read/write
acceptance, actual ad serving and any outstanding prerequisites distinct.

## Official sources

- [Current API access and developer-token retirement](https://developers.google.com/google-ads/api/docs/api-policy/developer-token)
- [Cloud-project access levels](https://developers.google.com/google-ads/api/docs/api-policy/access-levels)
- [Google Ads access model](https://developers.google.com/google-ads/api/docs/oauth/access-model)
- [OAuth refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Atomic bulk mutations](https://developers.google.com/google-ads/api/docs/mutating/overview)
- [v25 mutation request](https://developers.google.com/google-ads/api/reference/rpc/v25/MutateGoogleAdsRequest)
- [GAQL](https://developers.google.com/google-ads/api/docs/query/overview)
- [Average daily budget and overdelivery](https://support.google.com/google-ads/answer/1704424?hl=en)
