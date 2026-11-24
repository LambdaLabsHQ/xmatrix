import { parseDiagnosticEvent, type DiagnosticEventSchema } from "./diagnostic-events.js";

/**
 * The steps of bringing agents in that only the person's own screen sees
 * (docs/architecture/first-space.md). Every later step is already a fact the
 * Hub holds: an agent turned on, a first message, a first reply, a first
 * page. Each is counted once per person, by where it was shown and on what.
 */
export const ONBOARDING_FUNNEL_STEPS = [
  "app_loaded", "space_ready", "command_shown", "command_copied", "download_clicked", "terminal_seen", "approved",
  "starter_chosen",
] as const;
export type OnboardingFunnelStep = typeof ONBOARDING_FUNNEL_STEPS[number];

/** Where the person was asked: the welcome conversation, an empty Space,
 * Agents; `shell` is the app itself, before any of them is on screen. */
export const ONBOARDING_SURFACES = ["welcome", "space", "agents", "shell", "conversation"] as const;
export type OnboardingSurface = typeof ONBOARDING_SURFACES[number];

/** What the person was looking at it on. */
export const ONBOARDING_DEVICES = ["phone", "desktop_web", "desktop_app"] as const;
export type OnboardingDevice = typeof ONBOARDING_DEVICES[number];

/** The welcome conversation's first tasks, by id. */
export const ONBOARDING_STARTERS = ["talk", "together", "cowrite", "machines", "project", "plan", "xmatrix"] as const;
export type OnboardingStarter = typeof ONBOARDING_STARTERS[number];

export type OnboardingFunnelEvent = { step: OnboardingFunnelStep; surface: OnboardingSurface; device: OnboardingDevice;
  /** Which first task, for `starter_chosen` only. */
  starter?: OnboardingStarter };

/** The declared fields of one onboarding step (src/diagnostic-events.ts). */
const ONBOARDING_STEP_EVENT = {
  step: { kind: "enum", values: ONBOARDING_FUNNEL_STEPS },
  surface: { kind: "enum", values: ONBOARDING_SURFACES },
  device: { kind: "enum", values: ONBOARDING_DEVICES },
  starter: { kind: "enum", values: ONBOARDING_STARTERS, optional: true },
} as const satisfies DiagnosticEventSchema;

/** One step as a client reports it; anything else is not counted. */
export function parseOnboardingFunnelEvent(value: unknown): OnboardingFunnelEvent | undefined {
  const event = parseDiagnosticEvent(ONBOARDING_STEP_EVENT, value);
  // A first task names which one; no other step does.
  if (!event || (event.step === "starter_chosen") !== (event.starter !== undefined)) return undefined;
  return event;
}
