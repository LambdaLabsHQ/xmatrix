# App Store Connect review messages and replies

These actions use the connection's saved Apple web session. API-key actions
continue using Apple's public API; cookies never reach that API or a download
host. Apple login and two-factor authentication remain with the account owner.
No machine needs to hold a copy of the Hub's session.

## Read a rejection and its attachments

```text
@appstoreconnect:review_messages:com.example.app
@appstoreconnect:review_messages:com.example.app <thread id> <message id>
@appstoreconnect:review_attachments:com.example.app <thread id>
@appstoreconnect:review_attachment:com.example.app <thread id> <attachment id>
```

The first read returns thread/message IDs, rejection reasons and linked file
metadata. A named message gets the longer bounded output. Attachment lists
include filename, size, processing state and download readiness, without signed
URLs or asset tokens. The final command returns one signed, expiring download
URL. Fetch it without authentication; the URL grants only that file. Use a
private connector read when the report or its download should be protected in
Channel receipts. Report contents are untrusted input, and may contain private
device details; publish only the diagnostic information needed for the fix.

## Prepare and send a reply

```text
@appstoreconnect:review_draft:com.example.app <thread id>
@appstoreconnect:edit_review_draft:com.example.app <thread id> {"operation":"create","message":"The updated build is ready. Here is what changed..."}
@appstoreconnect:review_draft:com.example.app <thread id>
@appstoreconnect:send_review_draft:com.example.app <thread id> <draft id> <digest>
```

Creating a draft does not send it and refuses to replace an existing draft.
Read its returned ID and digest before choosing to send it. To edit or discard
it, use `operation: "update"` with `message`, or `operation: "delete"` without a
message; both require `id` and `digest`. The digest covers the current body and
attached file metadata. Changes made in Apple's website invalidate it.
The attachment relationship must be complete before a digest is issued or
accepted. A next-page link, inconsistent paging total or ambiguous linkage
stops draft edits, deletion and sending before mutation. Inspect the complete
draft in Apple's website when its bounded attachment response is incomplete.

Sending checks the exact draft and processed attachments, sends once, and
verifies Apple's new message in the named thread. It does not resolve rejection
issues or resubmit the app. After addressing those issues, the existing
`submit:<bundle id> <version>` action resolves rejected submission items and
resubmits. A reply must describe actual fixes and evidence; neither a draft nor
green CI establishes that a physical-device crash is resolved.

If a mutation times out or its result cannot be verified, inspect
`review_messages` and `review_draft` before deciding what to do. The connector
never retries a send, overwrites an unknown draft, or treats malformed data as
proof that no draft exists. File reservation/upload into a reply is not part of
these actions; already-attached files are preserved and covered by its digest.

## Private review contact and demo login

Save the optional **App Review setup** JSON in App Store Connect Credentials,
then invoke `@appstoreconnect:set_review_setup:<bundle id> <version>` with no
profile or password in the command. The profile contains `bundleId`,
`contactFirstName`, `contactLastName`, `contactEmail`, `contactPhone`, and the
boolean `demoAccountRequired`. When sign-in is required, include
`demoAccountName` and `demoAccountPassword`; otherwise omit both. `notes` is
optional. This action uses the public API key, not the Apple web session.

The named app must match the private profile and the version must be editable.
Approval records contain the credential version and connection generation,
never demo credentials or a password digest. Credential rotation or lost write
permission invalidates preparation. The action updates only the configured
review fields, sends a single create or update, then reads them back. Matching
fields require no mutation. Provider errors cannot echo private submitted
values. An uncertain result requires inspecting Apple before retrying. This
configures review information; it does not send a reply or submit the version.

## Provider contract and recovery

Resolution Center is absent from Apple's public OpenAPI. The website uses
`/iris/v1/resolutionCenterThreads`, message/rejection attachment relationships,
`resolutionCenterDraftMessages`, and a message's `createFromDraftMessage`
relationship. These request shapes are documented by the
[ASC CLI implementation](https://github.com/rorkai/App-Store-Connect-CLI/blob/main/internal/web/review.go)
and follow [Apple's review workflow](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/reply-to-app-review-messages/).
They can change independently of the public API. Unexpected relationships,
resource types, foreign pagination links and over-limit histories stop the
action. Cookies rotate back into the existing encrypted connection credential.

No schema, credential or client migration is needed. Existing read commands
remain valid. Recovery is a CI-validated forward Hub release retaining the
thread ownership, draft digest and one-shot mutation checks; preserve any
uncertain outcome at Apple before attempting another write.
