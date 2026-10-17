/**
 * The steps of bringing agents in that only the person's own screen sees
 * (docs/architecture/first-space.md). Every later step is already a fact the
 * Hub holds: an agent turned on, a first message, a first reply, a first
 * page. Each is counted once per person, by where it was shown and on what.
 */
export const ONBOARDING_FUNNEL_STEPS = [
  "app_loaded", "space_ready", "command_shown", "command_copied", "download_clicked", "link_emailed", "terminal_seen", "approved",
  "starter_chosen",
] as const;
export type OnboardingFunnelStep = typeof ONBOARDING_FUNNEL_STEPS[number];

/** Where the person was asked: the welcome conversation, an empty Space,
 * Agents; `shell` is the app itself, before any of them is on screen. */
export const ONBOARDING_SURFACES = ["welcome", "space", "agents", "shell"] as const;
export type OnboardingSurface = typeof ONBOARDING_SURFACES[number];

/** What the person was looking at it on. */
export const ONBOARDING_DEVICES = ["phone", "desktop_web", "desktop_app"] as const;
export type OnboardingDevice = typeof ONBOARDING_DEVICES[number];

/** The welcome conversation's first tasks, by id. */
export const ONBOARDING_STARTERS = ["project", "plan", "xmatrix"] as const;
export type OnboardingStarter = typeof ONBOARDING_STARTERS[number];

export type OnboardingFunnelEvent = { step: OnboardingFunnelStep; surface: OnboardingSurface; device: OnboardingDevice;
  /** Which first task, for `starter_chosen` only. */
  starter?: OnboardingStarter };

const member = <T extends string>(values: readonly T[], value: unknown): value is T =>
  (values as readonly unknown[]).includes(value);

/** One step as a client reports it; anything else is not counted. */
export function parseOnboardingFunnelEvent(value: unknown): OnboardingFunnelEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  if (Object.keys(event).some(key => !["step", "surface", "device", "starter"].includes(key)) ||
      !member(ONBOARDING_FUNNEL_STEPS, event.step) || !member(ONBOARDING_SURFACES, event.surface) ||
      !member(ONBOARDING_DEVICES, event.device)) return undefined;
  if ((event.step === "starter_chosen") !== (event.starter !== undefined) ||
      (event.starter !== undefined && !member(ONBOARDING_STARTERS, event.starter))) return undefined;
  return { step: event.step, surface: event.surface, device: event.device,
    ...(event.starter !== undefined ? { starter: event.starter as OnboardingStarter } : {}) };
}
