# Activation report

Run `node packages/db/scripts/activation-report.mjs <private-config.json> <from UTC> <to UTC>`
with runtime PostgreSQL credentials. The primary URL is
`POSTGRES_RUNTIME_DATABASE_URL`; supply each additional physical shard through
an environment variable named in `shardUrlEnvs`. Do not put credentials or the
classification file in Git or channel messages.

The private JSON configuration has four arrays:

```json
{
  "internalSpaceIds": ["known-team-space-id"],
  "excludedUserIds": ["confirmed-internal-or-test-account-id"],
  "externalUserIds": [],
  "shardUrlEnvs": ["POSTGRES_SHARD_1_RUNTIME_DATABASE_URL"]
}
```

External classification requires human evidence; activity alone is insufficient.
Known team membership and explicit exclusions take precedence. All other accounts
stay unclassified. Empty external cohorts produce counts of zero, not fabricated
conversion or retention percentages. Configure all team Spaces and known test
accounts; the report does not infer them from names or email addresses.

The registration cohort contains currently existing auth accounts created in
`[from,to)`, with a maximum 90-day window and 10,000 accounts. Historical accounts
outside that window and deleted accounts are excluded; this is not a historical
signup ledger or the overall seven-day active-user metric.

The aggregate output counts each person once within each classification:

- `humanMessage`: at least one retained, non-recalled user message after signup
  and before `to`, excluding `scheduled-message:` triggers.
- `firstReply`: a launch triggered by such a message has a recorded first reply
  after that message and before `to`. Launch connection alone is insufficient.
- `pageCreated`: a surviving Page credits the account as creator after signup.
  This includes imported/manual Pages; it does not prove Agent authorship.
- `activatedWithPage`: a Page in the same Space was created after a qualifying
  first reply. This establishes ordering, not causal attribution.
- `weekTwoEligible` / `weekTwoActive`: accounts observed for fourteen full days,
  and those with a qualifying human message during days 7 through 14 after signup.

Counts for messages, replies and Pages are independent; only `activatedWithPage`
requires the reply-before-Page sequence. Do not present `pageCreated / firstReply`
as an ordered funnel conversion.

The script opens repeatable-read, read-only transactions with connection, statement
and idle transaction timeouts. It checks physical shard identities, reads only
currently placed Spaces and refuses missing/duplicate shard coverage or moving/
blocked placement. Snapshots are taken separately per shard; use a fixed historical
`to` and avoid concurrent Space migrations. Output contains aggregate counts,
window and shard coverage only; no IDs, emails, message bodies or credentials.
CLI failures suppress database error details. Nothing is persisted or deployed by
running this report. Use `xmatrix secret exec` with explicitly named runtime secrets.
