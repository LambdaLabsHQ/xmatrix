/**
 * Pure domain types for workspace shell (no UI / shell-module imports).
 * Owned by the lower DAG layer so constants/formatters can stay free of reverse edges.
 */
import type { AgentRegistrationSummary } from "@xmatrix/protocol";

import type { MachineGlanceReading } from "./machine-load";

export type { LlmQuotaUsage, LlmUsage } from "@xmatrix/protocol";

export type UsageLimitSummary = {
  label: string;
  title: string;
  severity: "limit" | "warning";
  /** The window the verdict is about, as its usage tag is labelled. */
  window?: string;
  /** What that tag adds to its percentage: when it resets, or the credits paying past it. */
  note?: string;
  /** Past the window and still served, on credits. */
  credits?: boolean;
  /** The window's percentage, for drawing its tag when no tag reported it. */
  percent?: number;
};

/** One of this Space's registrations whose harness runs on this machine. */
export type LocalManagedAgent = {
  id: string;
  name: string;
  harness: string;
  registration: AgentRegistrationSummary;
};

/** A tag as the runtime declared it: text, a meter, or both. */
export type StatusChip = {
  id: string;
  label: string;
  value?: string;
  percent?: number;
  /** How busy the thing the tag names is, 0..100, toned behind its value; the Machine tag's load,
   * whose bars open on hover like the Machine's list row. */
  busy?: { percent: number; glance: MachineGlanceReading[] };
  /** The Machine a Machine tag names, so the tag can open that Machine's page. */
  machine?: { machineId: string; ownerUserId?: string };
  resetAt?: string;
  /** The limit verdict's word on this window (reset time, credits), added by the web. */
  note?: string;
  /** Overrides the percentage's tone: a used-up window paid by credits reads as a warning. */
  noteTone?: "yellow" | "red";
  /** Hub derived this tag from a harness parameter of this kind. */
  parameterKind?: "boolean" | "enum";
};
