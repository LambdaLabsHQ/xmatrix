import { providerJson, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { requireText } from "./common";
import { pagerDutyApiOrigin } from "../pagerduty-oauth";
import { pagerDutyHeaders, PAGERDUTY_READ_INCIDENT } from "./pagerduty-context";

const INCIDENT = /^[A-Za-z0-9]{1,32}$/u;

function statusAction(status: "acknowledged" | "resolved", verb: string): ConnectorAction {
  return {
    effect: "write",
    requires: ["apiKey|oauthToken"],
    parse: (statement) => INCIDENT.test(statement.target) ? { incident: statement.target.toUpperCase() }
      : `name an incident id: @pagerduty:${verb}:Q1ABC2DEF`,
    async execute({ credentials }, input) {
      await providerJson(`${pagerDutyApiOrigin(credentials)}/incidents/${encodeURIComponent(input.incident!)}`, {
        method: "PUT", headers: pagerDutyHeaders(credentials, true),
        json: { incident: { type: "incident_reference", status } } });
      return { summary: `Incident ${input.incident} ${status}` };
    },
  };
}

export const PAGERDUTY_ACTIONS: Record<string, ConnectorAction> = {
  read_incident: PAGERDUTY_READ_INCIDENT,
  acknowledge: statusAction("acknowledged", "acknowledge"),
  resolve: statusAction("resolved", "resolve"),
  note: {
    effect: "write",
    requires: ["apiKey|oauthToken"],
    parse(statement) {
      if (!INCIDENT.test(statement.target)) return "name an incident id: @pagerduty:note:Q1ABC2DEF <text>";
      const text = requireText(statement);
      return text ? { incident: statement.target.toUpperCase(), text } : "write the note after the incident id";
    },
    async execute({ credentials }, input) {
      await providerJson(`${pagerDutyApiOrigin(credentials)}/incidents/${encodeURIComponent(input.incident!)}/notes`, {
        method: "POST", headers: pagerDutyHeaders(credentials, true), json: { note: { content: input.text } } });
      return { summary: `Added a note to incident ${input.incident}` };
    },
  },
};


/** Verify scoped OAuth or manual keys without fetching personal profiles. */
export async function verifyPagerDuty(credentials: Readonly<Record<string, string>>): Promise<void> {
  if (!credentials.apiKey && !credentials.oauthToken) {
    if (credentials.webhookSecret) return; // Signed webhook-only setup.
    throw new ProviderRequestError(400, "PagerDuty needs OAuth, an API key, or a webhook signing secret");
  }
  const result = await providerJson(`${pagerDutyApiOrigin(credentials)}/abilities`, { headers: pagerDutyHeaders(credentials) });
  if (!Array.isArray(result.abilities) || !result.abilities.every(value => typeof value === "string")) {
    throw new ProviderRequestError(502, "PagerDuty did not confirm account abilities");
  }
}
