/**
 * What xMatrix says to a new person in their welcome conversation, and in
 * reply to a first message no agent can answer (`connect-agents`)
 * (docs/architecture/first-space.md). A message names only its step; the
 * client reads what the step shows from the facts, so the Hub writes each
 * step once and never edits it.
 */
export const ONBOARDING_MESSAGE_KIND = "xmatrix.onboarding.v1";

export const ONBOARDING_STAGES = ["bring-agents", "agents-in", "connect-agents"] as const;
export type OnboardingStage = typeof ONBOARDING_STAGES[number];

export function onboardingStageOf(metadata: Record<string, unknown> | undefined): OnboardingStage | null {
  if (!metadata || metadata.kind !== ONBOARDING_MESSAGE_KIND) return null;
  return (ONBOARDING_STAGES as readonly unknown[]).includes(metadata.stage) ? metadata.stage as OnboardingStage : null;
}

/**
 * The language of a new person's first ten minutes: Chinese for any `zh`
 * tag, English otherwise. Only that path is translated; the rest of the app
 * stays English.
 */
export type OnboardingLocale = "en" | "zh";

export function onboardingLocale(tag: string | null | undefined): OnboardingLocale {
  return /^zh(?:-|_|$)/iu.test(tag?.trim() ?? "") ? "zh" : "en";
}
