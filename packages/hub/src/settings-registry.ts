import {
  parseSettingAddress, SETTING_ADDRESS_FORMS, type ParsedSettingAddress, type SettingDescriptor, type SettingDomain,
} from "@xmatrix/protocol";
import { ControlError } from "@xmatrix/db";
import type { Env } from "./types";

/*
 * The settings registry (docs/design/settings-cards.md): one resolver per
 * domain projects its addresses into descriptors from the domain's own
 * authoritative data, and writes what a person made on a card through the
 * domain's own store and authority check. Routes, the Hub's `xmatrix settings`
 * command and the card's wake read settings only through here, so none of
 * them knows which domains exist.
 */

/** Who reads settings, in which Space, and since when a card asked for them. */
export interface SettingsReader {
  env: Env;
  spaceId: string;
  /** The Human reading or writing; for an Agent Run, its owner, whose access the Run's Space shares. */
  userId: string;
  /** When the card asked; without it a setting is satisfied by its state alone. */
  since?: string;
  /**
   * Who the card asked for, from the Hub's own card: its Run's owner, whose
   * Machines a harness setting names, and the Run a secret is made for.
   */
  asker?: SettingsAsker;
}

export interface SettingsAsker {
  userId: string;
  runId?: string;
  channelId?: string;
}

/** A setting a domain refuses for what its address names or the value it is given, not for who asked. */
export class SettingWriteRefused extends ControlError {
  constructor(message: string, status = 400) { super("setting_refused", status, message); }
}

export interface SettingDomainResolver {
  /** A descriptor per address, in order, or the reason one names nothing the domain holds. */
  describe(reader: SettingsReader, addresses: readonly ParsedSettingAddress[]): Promise<SettingDescriptor[] | string>;
  /**
   * Writes a value a person made on a card. The domain's own store checks who
   * may write it; `null` clears a value. Absent for controls that finish
   * elsewhere (a connection, a harness sign-in).
   */
  write?(reader: SettingsReader, address: ParsedSettingAddress, value: string | null): Promise<void>;
}

export type SettingDomainResolvers = Record<SettingDomain, SettingDomainResolver>;

/** Each address parsed and owned by a domain, once each, or why one is not. */
export function parseSettingAddresses(addresses: readonly unknown[]): ParsedSettingAddress[] | string {
  const parsed: ParsedSettingAddress[] = [];
  for (const address of addresses) {
    const item = parseSettingAddress(address);
    if (!item) return `${String(address)} is not a setting a person can make; name one as ${SETTING_ADDRESS_FORMS.join(", ")}`;
    if (!parsed.some((known) => known.address === item.address)) parsed.push(item);
  }
  return parsed;
}

/**
 * The descriptors for `addresses`, in their order, each from its own domain.
 * A descriptor carries its address in the domain's canonical form (a
 * Machine's id for its name), which is the one a card stores.
 */
export async function describeSettings(reader: SettingsReader, addresses: readonly ParsedSettingAddress[],
  domains: SettingDomainResolvers): Promise<SettingDescriptor[] | string> {
  const byDomain = new Map<SettingDomain, number[]>();
  addresses.forEach((address, index) => byDomain.set(address.domain, [...byDomain.get(address.domain) ?? [], index]));
  const described: SettingDescriptor[] = [];
  for (const [domain, indexes] of byDomain) {
    const descriptors = await domains[domain].describe(reader, indexes.map((index) => addresses[index]!));
    if (typeof descriptors === "string") return descriptors;
    indexes.forEach((index, position) => { described[index] = descriptors[position]!; });
  }
  return described;
}

/** Writes one setting through its domain, then reads it back as the writer sees it. */
export async function writeSetting(reader: SettingsReader, address: ParsedSettingAddress, value: string | null,
  domains: SettingDomainResolvers): Promise<SettingDescriptor> {
  const domain = domains[address.domain];
  if (!domain.write) throw new SettingWriteRefused(`${address.address} is made where it lives, not by typing a value`);
  await domain.write(reader, address, value);
  const described = await describeSettings(reader, [address], domains);
  if (typeof described === "string") throw new SettingWriteRefused(described);
  return described[0]!;
}
