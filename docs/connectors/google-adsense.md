# Google AdSense connector

`googleadsense` lets people and Agents read an AdSense publisher account's
earnings and setup from a Channel, so revenue can be checked without a
repository script or a personal OAuth client. It is read-only: a separate Google
OAuth grant on the company's Google OAuth application, holding only
`https://www.googleapis.com/auth/adsense.readonly`. The Hub requires exactly that
scope on exchange and refresh, and does not borrow Drive, Search Console,
Analytics, Ads or GCP tokens. Calls use the AdSense Management API v2
(`https://adsense.googleapis.com/v2`).

Registration, production deployment and native acceptance are recorded in the
Space's Connector application registration page; fixture tests alone do not
establish native acceptance.

## Connect

1. Enable the **AdSense Management API** (`adsense.googleapis.com`) in the
   company OAuth client's Cloud project.
2. Add `https://www.googleapis.com/auth/adsense.readonly` to the project's OAuth
   consent configuration (Google Auth Platform → Data Access).
3. In Space **Apps → Google AdSense**, connect with the Google user who can read
   the AdSense account. A Testing OAuth app requires that user in its test-user
   list, and its refresh tokens last seven days. **Check** lists the user's
   AdSense accounts without storing them.

## Actions

An account is `pub-…` or `accounts/pub-…`. Google decides which accounts the
connected user may read.

| Action | Returns |
| --- | --- |
| `list_accounts:*` | Account name, display name, state and time zone |
| `list_sites:<pub-…>` | Each site's domain, approval state and whether Auto ads are on |
| `list_adunits:<pub-…>` | Each content ad unit's name, state, type, size and reporting id |
| `report:<pub-…> [by=…] [days=1-1095] [limit=1-250] [domain=example.com] [include_today]` | One report table with totals |
| `list_payments:<pub-…>` | The unpaid balance and past payments |
| `list_alerts:<pub-…>` | Current alerts: severity, type and message |
| `list_policy_issues:<pub-…>` | Policy issues: entity, site or page, action, topics, last detected |

`report` metrics are estimated earnings, page views, page RPM, impressions,
clicks, ad requests, ad request coverage and Active View viewability. `by` is
`none` or up to two of `date`, `month`, `domain`, `site`, `country`,
`platform`, `page`, `format` and `ad_unit` (defaults `by=date days=7 limit=50`).
`domain=` keeps one site's rows. Days are whole calendar days in the account's
time zone, which the Hub reads from the account before each report: the last
`days` days end yesterday, so a figure lines up with the AdSense UI's finished
days; `include_today` ends the range today instead, whose figures are still
estimates.

## What the API cannot read

- **Auto ads by format.** Auto ads have no ad unit name, so a `by=ad_unit`
  report leaves them out; read their share with `by=format` (In-page, Anchor,
  Vignette, In-article, Ad intents, …) or `by=none`. The report says this
  whenever it splits by ad unit.
- **Auto ads settings.** The site resource carries only `autoAdsEnabled`. The
  per-format switches (in-article, anchor, side rail, vignette, ad intents), ad
  load and excluded areas or pages have no API field; read them in AdSense under
  **Ads → By site**.
- **Writes.** AdSense Management API v2 cannot change ads or sites; this
  connector has no write actions.
