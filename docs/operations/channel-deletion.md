# Channel deletion

A Human Space owner or admin chooses **Delete Channel…** from the conversation
actions or details, types its current name and acknowledges deletion for every
member. Stop the Channel's Agents first. The Hub rejects Agent credentials,
ordinary members, a mismatched Space, changed names and active or stopping Runs,
unreleased allocations and pending launches. All verification uses isolated data;
never delete a real person's production Channel to test this feature.

## Authority and recovery

`data.channels.mode='deleted'` immediately retires admission under the existing
Channel capability policy. It is internal lifecycle state, never a serialized
Channel mode. The catalog, history, content, new work, metadata changes and
Automation paths reject the retired Channel, including Space admins and existing
grants. The same row lock orders retirement with appends and execution admission.
Existing clients simply lose the Channel from their catalog.

`data.channel_deletions` owns cleanup progress and a minimal retirement receipt.
The stable target is `(space_id, channel_id)`; repeating the authenticated request
returns its current state even after physical cleanup. No deletion can be undone.
A delayed create cannot reuse a retired ID. The journal retains opaque identity,
initiating Human, timestamps and progress, without message bodies or credentials.

Cron advances at most two jobs on each configured physical shard per invocation.
Every operation checks the active placement fence. The journal moves with its
Space; a moving Space waits rather than purging on the wrong shard. Space purge
waits for pending Channel cleanup before removing its placement.

Space purge also explicitly clears its connector consent, room and delivery-job
records before their parent connections. Registration bindings and stop intents
go before Runs. Each batch revisits the finite cleanup plan, so dependencies
added before a retained progress marker are still processed after an upgrade.
Immutable Apple purchase ownership and content-free secret-access audits remain.

Each pass deletes at most 100 restricted objects and mutates at most 2,000 rows
in batches of 500, then commits its progress. Storage failures leave the cursor
unchanged; a restart retries the same exact keys. Every restricted key is parsed
and checked against the deleted Channel before deletion. Content-addressed
`objects/<sha256>` bytes can be shared with other Channels or Spaces and remain
under the existing content retention/collection policy. Removing a Channel
removes its references, not another Channel's bytes.

Cleanup removes Channel messages, message replay copies, metadata history,
attachments, schedules, linked execution records, grants, Page links and its pins.
Other Channels, Pages and their revision bodies remain; a Page can contain text
copied from a conversation and is a separately owned document. Local computer
files, third-party copies and independent billing/audit records are outside this
deletion. The final transaction removes the Channel row after its metadata
foreign-key closure, and marks the journal completed. Operators must not reset a
retired Channel to open or recreate its identity to recover failed cleanup.

## Account and personal-data deletion

Account deletion is already available in **Settings → Account → Delete account**
and at `/account/delete`. See [account deletion](account-deletion.md) for fresh
sign-in, revocation, private-data cleanup and shared-content limits. Deleting a
Channel does not delete its members' accounts; deleting an account does not
automatically destroy other members' shared work.

The GDPR's [Article 17](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng) provides
a qualified right to erasure of personal data. [EDPB guidance](https://www.edpb.europa.eu/sme/be-compliant/respect-individuals-rights_en)
requires facilitating requests and normally responding within one month;
complex requests can receive a further two months with notice during the first
month. Erasure must occur without undue delay when applicable. Legal retention,
claims and others' protected rights require a reasoned assessment, not blanket
retention of every shared message. Account deactivation, sender-profile removal
or a Channel-delete button alone does not establish GDPR compliance. Requests
concerning personal data inside retained shared content follow the privacy-policy
rights process and the relevant controller; the automatic account boundary still
has the shared-content acceptance gap documented in the account runbook.
