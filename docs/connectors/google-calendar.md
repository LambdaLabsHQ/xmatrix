# Google Calendar

`googlecalendar` is a separate Space connection using the company Google OAuth
client. It stores its own encrypted offline grant and never reuses a Drive,
Gmail, Search Console or other Google connection's token. Disconnect deletes
its managed access token, refresh token and expiry. Google enforces which
calendars the connected account may access.

## Setup and permissions

Enable **Google Calendar API** (`calendar-json.googleapis.com`) in the company
Google project and register these three scopes in its OAuth consent screen:

- `calendar.calendarlist.readonly`: list subscribed calendars and resolve their
  names, IDs and time zones for approval.
- `calendar.events`: read, create, edit and delete events.
- `calendar.events.freebusy`: query calendar availability.

Each is prefixed by `https://www.googleapis.com/auth/`. The Hub requests
`access_type=offline`, `prompt=consent`, `include_granted_scopes=false` and
requires exactly these permissions in the returned grant. It does not request
calendar administration, sharing or ACL permissions. Check reads one calendar
list response without storing it. An existing Google connection does not
provide Calendar access; an admin connects Calendar separately. Company app
verification and each user's consent remain separate prerequisites; deploying
the connector does not complete either.

## Read actions

All targets are a calendar ID from `list_calendars`, or `primary`, except the
calendar list itself. IDs are addresses, never authorization. JSON options
reject unknown keys. All reads support the existing private-result mechanism:
`xmatrix call "<command>" --private` masks the result in Channel receipts;
invocation parameters remain visible, and the calling Agent's Human owner can
read its protected original for 30 days.

| Action | Input after the target |
| --- | --- |
| `list_calendars:*` | Optional `{"pageToken":"…"}`; at most 100 calendars |
| `list_events:<calendar>` | `{"timeMin":"2026-10-28T00:00:00+08:00","timeMax":"2026-11-01T00:00:00+08:00","q":"optional search","maxResults":50,"pageToken":"optional"}` |
| `get_event:<calendar>` | Exact event ID from a list/read |
| `freebusy:<calendar>` | JSON `timeMin` and `timeMax` |

Intervals require RFC3339 timestamps with explicit UTC offsets and span at
most 366 days. Event pages contain 1–100 items (default 50); recurring events
are expanded into occurrences in chronological order. Follow `nextPageToken`
explicitly with the same interval/search. Text output is fenced as untrusted
and limited to 12,000 characters with an explicit truncation notice. Narrow
an event interval/page or read an exact event when a page is truncated.
Provider calls retain the platform's 10-second, 256-KiB response bounds.

Free/busy is a read despite its HTTP POST. Missing calendars, per-calendar
errors and malformed replies fail rather than claim the calendar is free.
An empty busy list means free only within the requested interval.

## Write actions

Users can let AI schedule directly: in the app's **Permissions**, select a
Channel and set each desired write action to **Allow**. Creation, edits and
deletion are independent permissions; allowing creation need not allow deletion.
Allow executes without a per-event approval and still checks current Channel
access/policy immediately before the write. Switch back to **Ask** for
per-request approval or **Disallow** to stop that action. Connecting Google
alone does not grant automatic scheduling. Space admins can also configure:

```text
@googlecalendar:policy:create_event allow
@googlecalendar:policy:update_event allow
@googlecalendar:policy:delete_event ask
```

All three actions default to **ask** and use the existing immutable request,
Space-admin approval and live Channel policy checks. Every write requires an
explicit `sendUpdates`: `all`, `externalOnly` or `none`. This controls Google's
guest notifications; Google documents that some mail may still be sent even
when notifications are disabled. Notifications, exact changed fields and the
recurring-series/occurrence impact are included in the approval preview.

Create an event with a unique base32hex ID (lowercase `a`–`v`, digits `0`–`9`,
5–1024 characters; a lowercase UUID with hyphens removed works):

```text
@googlecalendar:create_event:primary {"id":"0123456789abcdef0123456789abcdef","summary":"Project review","start":{"dateTime":"2026-10-29T10:00:00+08:00","timeZone":"Asia/Shanghai"},"end":{"dateTime":"2026-10-29T11:00:00+08:00","timeZone":"Asia/Shanghai"},"attendees":[{"email":"guest@example.com"}],"sendUpdates":"all"}
```

For all-day events use `{"date":"2026-10-29"}` and an exclusive end date
such as `{"date":"2026-10-30"}`. Timed recurring events require explicit IANA
time zones. Optional content fields are `description`, `location`, `attendees`
(up to 50 email/optional pairs), `recurrence` (up to five RRULE/RDATE/EXDATE
lines), `visibility` and `transparency`. Google validates recurrence semantics.
The connector creates ordinary events; calendar sharing, attachments, custom
reminders, creating video conferences, RSVP and moving events between calendars
are outside this action contract. Existing conference details are readable.

Read the exact event and retain its quoted `etag` for edits/deletion:

```text
@googlecalendar:update_event:primary {"eventId":"0123456789abcdef0123456789abcdef","etag":"\"provider-version\"","summary":"Revised review","sendUpdates":"all"}
@googlecalendar:delete_event:primary {"eventId":"0123456789abcdef0123456789abcdef","etag":"\"provider-version\"","sendUpdates":"all"}
```

Updates PATCH only supplied content fields. Moving an event requires both
start and end. Attendee/recurrence arrays replace the complete field; `[]`
clears it. A recurring master changes or deletes the whole series; an expanded
instance ID affects just that occurrence. Preparation resolves `primary` to
its real calendar ID, reads the current event, verifies the requested ETag and
shows complete proposed values; approved execution retains that exact ID and
sends `If-Match`. Concurrent changes return 412, requiring a fresh read and
request. It does not silently overwrite them or re-resolve an approved
`primary` against another account.

Mutations are sent once, with no automatic retry after timeout, conflict or
malformed acknowledgment. After an uncertain create, read the explicit event
ID before retrying; never generate a new ID merely to retry. IDs reduce
accidental duplication but do not promise exactly-once provider execution.

## Release and acceptance

This adds Hub actions and a shared manifest, consumed by the existing CLI and
Web; no database migration or native protocol change is required. Release via
CI-validated beta Hub/Web artifacts. Recovery is a CI-validated beta reverting
the connector while preserving any user-created Google Calendar events.

Native acceptance requires a separately consented account: Check, list a
calendar, list/read a controlled event, query availability, approve a new test
event, read it, edit it with the returned ETag, verify the change in Google
Calendar, then delete only that test event with its current ETag. Also verify
denied policy and provider revocation; deployment/tool visibility alone is not
native acceptance. Calendar has no inbound subscriptions in this release.

Sources: [scopes](https://developers.google.com/workspace/calendar/api/auth),
[API reference](https://developers.google.com/workspace/calendar/api/v3/reference),
[conditional modifications](https://developers.google.com/workspace/calendar/api/guides/version-resources),
[event insertion and notifications](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert),
[free/busy](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query).
