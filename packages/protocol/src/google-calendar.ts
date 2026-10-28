/**
 * Google's sendUpdates wire modes and the meaning shown before a write.
 * Shared by Hub validation and approval presentation; "external" describes
 * Calendar usage, never an organization's boundary. Some other Google emails
 * may still be sent even with none.
 * https://developers.google.com/workspace/calendar/api/v3/reference/events/insert#sendUpdates
 */
export const GOOGLE_CALENDAR_SEND_UPDATES = {
  all: "Emails every guest",
  externalOnly: "Emails only guests who do not use Google Calendar",
  none: "Sends no guest update notifications",
} as const;

export type GoogleCalendarSendUpdates = keyof typeof GOOGLE_CALENDAR_SEND_UPDATES;

export function isGoogleCalendarSendUpdates(value: unknown): value is GoogleCalendarSendUpdates {
  return typeof value === "string" && Object.hasOwn(GOOGLE_CALENDAR_SEND_UPDATES, value);
}
