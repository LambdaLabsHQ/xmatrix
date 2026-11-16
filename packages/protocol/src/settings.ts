import { APP_CONNECTOR_PROVIDER_MANIFESTS } from "./app-connector-manifests.js";
import { connectorReceiptFixesOf, proposedValue, SETTINGS_REQUEST_KEY, settingAddress, settingAddressFix,
  type ConnectorReceiptFix } from "./connector-receipt.js";

/*
 * Settings a person makes on a card (docs/design/settings-cards.md).
 *
 * A setting is named by an address. Its domain projects the address, from the
 * domain's own authoritative data, into one `SettingDescriptor`; the card, the
 * CLI, the Agent's status read and the wake all consume descriptors and never
 * branch on the domain. Each dimension is independent: the domain decides where
 * the value lives and who may write it, the control decides how a client asks
 * for it, sensitivity decides whether it is ever read back, and state is what
 * the domain observes now. A new domain is one Hub resolver; a new control is
 * one client widget; neither touches the other.
 */

/** Where settings live. Each domain is one Hub resolver that owns its addresses. */
export const SETTING_DOMAINS = ["connector", "secret", "secret-access", "harness"] as const;
export type SettingDomain = typeof SETTING_DOMAINS[number];

/**
 * How a client asks a person for a setting. The client owns each control; a
 * domain only names one. A card cannot define fields, labels or targets.
 * - `text`: a plain value, read back and typed in the open.
 * - `secret`: a value written once and never read back.
 * - `sign-in`: a web session the desktop app signs in to on the service's own page (`service`); a pasted
 *   Cookie header elsewhere.
 * - `connect`: an OAuth or install flow, completed where the App is managed (`href`).
 * - `grant`: a yes a person gives, such as letting Agents read a secret without asking.
 * - `harness-sign-in`: the Machine owner signs a harness in on that Machine.
 */
export const SETTING_CONTROLS = ["text", "secret", "sign-in", "connect", "grant", "harness-sign-in"] as const;
export type SettingControl = typeof SETTING_CONTROLS[number];

/** What the domain observes now: absent, present, present and checked, or refused by its check. */
export type SettingState = "missing" | "set" | "verified" | "invalid";

/** Whose role makes a setting; the domain checks it again where the value is written. */
export type SettingWriter = "space-admin" | "machine-owner";

/** One setting as its reader may see it. Never carries a secret value. */
export interface SettingDescriptor {
  address: string;
  domain: SettingDomain;
  /** What the setting belongs to, as a person reads it: `App Store Connect`, `Space secrets`, `Codex on Laptop`. */
  scope: string;
  label: string;
  description?: string;
  control: SettingControl;
  /** A secret is written only; a plain value is read back to its writers, and an Agent may suggest one. */
  sensitivity: "secret" | "plain";
  writer: SettingWriter;
  state: SettingState;
  /** The Hub's verdict that the setting is in as asked since the card was posted; a click is not enough. */
  satisfied: boolean;
  /** Whether this reader may make it. */
  canWrite: boolean;
  /** A plain setting's current value, for a reader who may write it. */
  value?: string;
  /** The service the desktop app signs in to, for a `sign-in` control. */
  service?: string;
  /** Where the setting is managed in the app, for `connect` and for clients without the control. */
  href?: string;
  /** The domain's words for an `invalid` state. */
  problem?: string;
}

export interface ParsedSettingAddress {
  domain: SettingDomain;
  /** The address in its canonical form. */
  address: string;
  /** The domain's own key parts: `[app, field]`, `[alias]`, `[machine, harness]`. */
  parts: string[];
}

// A secret alias may contain "/", so `secret:` and `secret-access:` take the rest of the address.
const ADDRESS_FORMS: Record<SettingDomain, RegExp> = {
  connector: /^connector:([a-z0-9-]{1,80})\/([A-Za-z0-9_]{1,80})$/u,
  secret: /^secret:(\S{1,160})$/u,
  "secret-access": /^secret-access:(\S{1,160})$/u,
  harness: /^harness:([^\s/]{1,200})\/([a-z0-9_-]{1,64})\/sign-in$/u,
};

/** The address forms, as a refusal and `--help` name them. */
export const SETTING_ADDRESS_FORMS = [
  "connector:<app>/<field>", "connector:<app>/connect", "secret:<alias>", "secret-access:<alias>",
  "harness:<machine>/<harness>/sign-in",
] as const;

/** An address's domain and parts, or undefined when no domain owns it. */
export function parseSettingAddress(value: unknown): ParsedSettingAddress | undefined {
  if (typeof value !== "string") return undefined;
  const address = value.trim();
  for (const domain of SETTING_DOMAINS) {
    const match = ADDRESS_FORMS[domain].exec(address);
    if (match) return { domain, address, parts: match.slice(1) };
  }
  return undefined;
}

/** The most settings one card asks for. */
export const MAX_SETTINGS_PER_CARD = 8;

/** One setting a card asks for, with the value an Agent suggests for a plain one. */
export interface SettingsCardEntry {
  address: string;
  proposed?: string;
}

/**
 * A settings card as the Hub wrote it under `xmatrixSettingsRequest`: who
 * asked, why, and the settings by address. Older cards named connector
 * settings only through `xmatrixConnectorFixes`; they read the same way.
 */
export interface SettingsCard {
  agentName: string;
  reason?: string;
  settings: SettingsCardEntry[];
}

/** A settings card from a message the Hub wrote, or null. */
export function settingsCardOf(metadata: Record<string, unknown> | undefined): SettingsCard | null {
  const value = metadata?.[SETTINGS_REQUEST_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  const text = (field: unknown, limit: number) => typeof field === "string" && field.trim() ? field.trim().slice(0, limit) : undefined;
  const listed = Array.isArray(request.settings) ? settingsEntriesOf(request.settings)
    : connectorReceiptFixesOf(metadata).map(fixEntry);
  if (!listed.length) return null;
  const reason = text(request.reason, 500);
  return { agentName: text(request.agentName, 120) ?? "", ...(reason ? { reason } : {}), settings: listed };
}

/** Well-formed entries for addresses a domain owns, once each; a suggestion only on a plain connector field. */
export function settingsEntriesOf(value: readonly unknown[]): SettingsCardEntry[] {
  const entries: SettingsCardEntry[] = [];
  for (const item of value.slice(0, MAX_SETTINGS_PER_CARD)) {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
    const parsed = parseSettingAddress(row?.address);
    if (!parsed || entries.some((entry) => entry.address === parsed.address)) continue;
    const proposed = row?.proposed === undefined ? undefined : proposableValue(parsed, row.proposed);
    entries.push({ address: parsed.address, ...(proposed ? { proposed } : {}) });
  }
  return entries;
}

/**
 * A suggested value for a setting that takes one: a plain field, as one short
 * line. A secret, a sign-in, a grant or a connection never takes one.
 */
export function proposableValue(parsed: ParsedSettingAddress, value: unknown): string | undefined {
  if (parsed.domain !== "connector") return undefined;
  const fix = connectorAddressFix(parsed);
  return fix?.remedy.kind === "credential" && plainConnectorField(fix.providerId, fix.remedy.field) ? proposedValue(value) : undefined;
}

/** The connector fix an address names: a typed field the Hub does not write itself, or the connection. */
export function connectorAddressFix(parsed: ParsedSettingAddress): Omit<ConnectorReceiptFix, "executionId"> | undefined {
  return parsed.domain === "connector" ? settingAddressFix(parsed.address) : undefined;
}

function plainConnectorField(providerId: string, field: string): boolean {
  const manifest = APP_CONNECTOR_PROVIDER_MANIFESTS.find((candidate) => candidate.id === providerId);
  return Boolean(manifest?.credentials?.find((candidate) => candidate.id === field)?.plain);
}

function fixEntry(fix: ConnectorReceiptFix): SettingsCardEntry {
  return { address: settingAddress(fix), ...(fix.proposed ? { proposed: fix.proposed } : {}) };
}
