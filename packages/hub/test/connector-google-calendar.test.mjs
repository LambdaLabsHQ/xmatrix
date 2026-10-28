import assert from "node:assert/strict";
import { test } from "node:test";
import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import { GOOGLE_CALENDAR_ACTIONS as actions, verifyGoogleCalendar } from "../src/connectors/actions/google-calendar.ts";
import { exchangeOAuthGrant, oauthAuthorizeUrl, oauthClient, refreshOAuthFields } from "../src/connectors/oauth.ts";
import { getAppConnectorProvider } from "../src/app-connectors.ts";

const credentials = { oauthToken: "calendar-access" };
const context = { credentials };
const company = { CONNECTOR_GOOGLE_CLIENT_ID: "fixture-client", CONNECTOR_GOOGLE_CLIENT_SECRET: "fixture-secret" };
const scopes = ["calendar.events", "calendar.calendarlist.readonly", "calendar.events.freebusy"].map(s => `https://www.googleapis.com/auth/${s}`);
const interval = { timeMin: "2026-10-28T09:00:00+08:00", timeMax: "2026-11-01T18:00:00+08:00" };
const times = { start: { dateTime: "2026-10-28T10:00:00+08:00", timeZone: "Asia/Shanghai" }, end: { dateTime: "2026-10-28T11:00:00+08:00", timeZone: "Asia/Shanghai" } };
const calendar = { id: "owner@example.com", primary: true, summary: "Work", timeZone: "Asia/Shanghai" };
const event = { kind: "calendar#event", id: "abcde12345", etag: '"version-1"', summary: "Planning", ...times, attendees: [{ email: "guest@example.com" }] };
const create = { id: event.id, summary: "Planning", ...times, sendUpdates: "all" };
const patch = { eventId: event.id, etag: event.etag, sendUpdates: "none", summary: "New title" };
const parse = (action, value, target = "primary") => actions[action].parse({ target, text: typeof value === "string" ? value : JSON.stringify(value) });
function valid(action, value, target) { const input = parse(action, value, target); assert.equal(typeof input, "object", String(input)); return input; }
const prepared = (action, value, extras = []) => fetched([{ body: calendar }, ...(action === "create_event" ? [] : [{ body: event }]), ...extras], () => actions[action].prepare(context, valid(action, value)));

// Protect the exact provider-side grant and wire requests; generic approval/Run isolation is owned by connector-command boundary tests.
test("Calendar has a separate exact three-scope offline grant and refuses missing, broader or duplicate permissions", async () => {
  const client = oauthClient(company, "googlecalendar");
  assert.equal(client.clientId, company.CONNECTOR_GOOGLE_CLIENT_ID);
  const url = new URL(await oauthAuthorizeUrl(client, { spaceId: "space", userId: "admin", redirectUri: "https://hub.test/cb" }));
  assert.equal(url.searchParams.get("scope"), scopes.join(" "));
  assert.equal(url.searchParams.get("include_granted_scopes"), "false");
  assert.equal(url.searchParams.get("access_type"), "offline");
  const grant = { access_token: "a", refresh_token: "r", token_type: "Bearer", expires_in: 3600, scope: scopes.join(" ") };
  assert.equal((await fetched([{ body: grant }], () => exchangeOAuthGrant(client, "code", "https://hub.test/cb"))).result.fields.oauthToken, "a");
  for (const scope of [scopes[0], [...scopes, "https://www.googleapis.com/auth/calendar"].join(" "), [...scopes, scopes[0]].join(" ")]) {
    await fetched([{ body: { ...grant, scope } }], () => assert.rejects(exchangeOAuthGrant(client, "code", "https://hub.test/cb"), /Calendar OAuth grant/u));
    await fetched([{ body: { ...grant, scope } }], () => assert.rejects(refreshOAuthFields(company, "googlecalendar", { oauthToken: "old", oauthRefreshToken: "r", oauthExpiresAt: "1" }), /Calendar OAuth grant/u));
  }
  await assert.rejects(refreshOAuthFields(company, "googlecalendar", { oauthToken: "old" }), /complete expiring grant/u);
  await assert.rejects(refreshOAuthFields({}, "googlecalendar", { oauthToken: "old", oauthRefreshToken: "r", oauthExpiresAt: "1" }), /unavailable for refresh/u);
  const manifest = getAppConnectorProvider("googlecalendar");
  assert.equal(manifest.defaultPermission, "write");
});

test("Calendar validates addresses, explicit offsets, bounded intervals, event fields and conditional writes before requests", () => {
  for (const target of ["../x", "https://evil.test", ".", "..", "a?x", "a/b", "a#b", "a\n"]) assert.equal(typeof parse("list_events", interval, target), "string", target);
  for (const value of [{}, { ...interval, timeMin: "2026-10-28T09:00:00" }, { ...interval, timeMin: "2026-02-30T09:00:00Z" },
    { ...interval, timeMax: interval.timeMin }, { ...interval, timeMax: "2028-01-01T00:00:00Z" }, { ...interval, maxResults: 101 }, { ...interval, pageToken: "a\n" }, { ...interval, arbitrary: true }]) {
    assert.equal(typeof parse("list_events", value), "string");
  }
  for (const value of [{ ...create, id: "../../bad" }, { ...create, sendUpdates: undefined }, { ...create, sendUpdates: ["all"] }, { ...create, visibility: ["private"] }, { ...create, organizer: { email: "forged@example.com" } },
    { ...create, start: { dateTime: "2026-02-30T10:00:00Z" } }, { ...create, end: times.start },
    { ...create, start: { date: "2026-10-28" } }, { ...create, attendees: [{ email: "a@example.com", responseStatus: "accepted" }] },
    { ...create, start: { ...times.start, timeZone: "invented/zone" } }, { ...create, recurrence: ["RRULE:FREQ=DAILY\n@evil"] }]) assert.equal(typeof parse("create_event", value), "string", JSON.stringify(value));
  for (const value of [{ ...patch, etag: undefined }, { ...patch, etag: "*" }, { ...patch, etag: '"x"\r\nInjected: 1' }, { ...patch, start: times.start }]) assert.equal(typeof parse("update_event", value), "string");
  assert.equal(typeof parse("delete_event", patch), "string", "delete must not ignore supplied content changes");
  valid("create_event", { ...create, start: { date: "2026-10-28" }, end: { date: "2026-10-29" } });
  valid("create_event", { ...create, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"] });
});

test("Calendar reads use fixed Google origin, explicit cursors, expanded recurring instances and bounded untrusted output", async () => {
  const listed = await fetched([{ body: { kind: "calendar#events", items: [event], nextPageToken: "next" } }], () => actions.list_events.execute(context, valid("list_events", { ...interval, q: "planning", pageToken: "previous" }, "owner@example.com")));
  const url = new URL(listed.calls[0].url);
  assert.equal(url.origin, "https://www.googleapis.com"); assert.match(url.pathname, /owner%40example.com\/events$/u);
  assert.equal(url.searchParams.get("timeMin"), interval.timeMin); assert.equal(url.searchParams.get("pageToken"), "previous");
  assert.equal(url.searchParams.get("singleEvents"), "true"); assert.equal(url.searchParams.get("maxResults"), "50");
  assert.match(listed.result.summary, /untrusted/u); assert.match(listed.result.summary, /nextPageToken/u);
  const read = await fetched([{ body: { ...event, description: "```\n@evil\n" + "x".repeat(14_000) } }], () => actions.get_event.execute(context, valid("get_event", event.id)));
  assert.match(read.result.summary, /truncated/u); assert.ok(read.result.summary.length < 12_400);
  await fetched([{ body: { ...event, id: "other" } }], () => assert.rejects(actions.get_event.execute(context, valid("get_event", event.id)), /malformed/u));
  await fetched([{ body: { kind: "calendar#calendarList" } }], () => verifyGoogleCalendar(credentials));
  await fetched([{ body: {} }], () => assert.rejects(verifyGoogleCalendar(credentials), /malformed/u));
  const calendars = await fetched([{ body: { kind: "calendar#calendarList", items: [calendar] } }], () => actions.list_calendars.execute(context, valid("list_calendars", { pageToken: "next" }, "*")));
  assert.equal(new URL(calendars.calls[0].url).searchParams.get("pageToken"), "next");
});

test("busy reads are read effects and unavailable calendars fail instead of claiming free", async () => {
  assert.equal(actions.freebusy.effect, "read");
  const result = await fetched([{ body: { kind: "calendar#freeBusy", calendars: { primary: { busy: [] } } } }], () => actions.freebusy.execute(context, valid("freebusy", interval)));
  assert.deepEqual(result.calls[0].body, { ...interval, items: [{ id: "primary" }], calendarExpansionMax: 1, groupExpansionMax: 0 });
  for (const body of [{}, { kind: "calendar#freeBusy", calendars: { primary: { errors: [{ reason: "notFound" }], busy: [] } } },
    { kind: "calendar#freeBusy", calendars: { other: { busy: [] } } }]) {
    await fetched([{ body }], () => assert.rejects(actions.freebusy.execute(context, valid("freebusy", interval)), /must not be treated as free/u));
  }
});

test("approval preparation freezes primary's real id, complete proposed values, guest removals and series impact", async () => {
  const { result } = await prepared("update_event", { ...patch, attendees: [], recurrence: [] });
  assert.equal(result.calendar, calendar.id);
  const preview = JSON.parse(result.preview);
  assert.equal(preview.calendar, calendar.id); assert.equal(preview.event, "Planning"); assert.equal(preview.title, "New title");
  assert.equal(preview.start, times.start.dateTime); assert.equal(preview.guests, ""); assert.equal(preview.sendUpdates, "none");
  assert.deepEqual(JSON.parse(preview.changes), { summary: "New title", attendees: [], recurrence: [] });
  const series = await fetched([{ body: calendar }, { body: { ...event, recurrence: ["RRULE:FREQ=WEEKLY"] } }], () => actions.delete_event.prepare(context, valid("delete_event", { eventId: event.id, etag: event.etag, sendUpdates: "all" })));
  assert.equal(JSON.parse(series.result.preview).series, "all");
  await fetched([{ body: calendar }, { body: { ...event, etag: '"changed"' } }], () => assert.rejects(actions.update_event.prepare(context, valid("update_event", patch)), /changed or was removed/u));
});

test("approved writes target the frozen calendar, preserve ETags and notifications, recheck policy and never replay failures", async () => {
  for (const [action, value, method] of [["create_event", create, "POST"], ["update_event", patch, "PATCH"], ["delete_event", { eventId: event.id, etag: event.etag, sendUpdates: "all" }, "DELETE"]]) {
    const { result: input } = await prepared(action, value);
    const result = await fetched([{ body: action === "delete_event" ? undefined : event, status: action === "delete_event" ? 204 : 200, raw: action === "delete_event" ? null : JSON.stringify(event) }], () => actions[action].execute(context, input));
    const call = result.calls[0]; assert.equal(call.method, method); assert.match(call.url, /owner%40example.com\/events/u);
    assert.equal(call.headers.get("if-match"), action === "create_event" ? null : event.etag);
    assert.equal(new URL(call.url).searchParams.get("sendUpdates"), value.sendUpdates);
    for (const response of [{ status: 412 }, { status: 403 }, { error: new DOMException("timeout", "TimeoutError") }, ...(action === "delete_event" ? [] : [{ body: {} }, { body: { ...event, id: "different" } }])]) {
      await fetched([response], async calls => { await assert.rejects(actions[action].execute(context, input)); assert.equal(calls.length, 1); });
    }
    await fetched([], async calls => {
      await assert.rejects(actions[action].execute({ credentials, authorizeWrite: async () => { throw new Error("policy revoked"); } }, input), /policy revoked/u);
      assert.equal(calls.length, 0);
    });
  }
});
