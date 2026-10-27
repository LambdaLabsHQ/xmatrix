import type { OnboardingLocale } from "@xmatrix/protocol";

/* What an Agent is good at, wherever the mention menu and the editor say it,
   in English and Chinese. Only @auto reads it, so the menu says so on the auto
   row; an Agent nobody has described yet invites a description in the place
   its description would stand. Picked by the same locale as the
   first-ten-minutes path (onboarding-locale.ts): a saved Space display locale,
   otherwise the browser's language. */

const en = {
  auto: "Picks an Agent by what each is good at",
  edit: "Say what it's good at",
  editNamed: (name: string) => `Say what ${name} is good at`,
  title: "What it's good at",
  field: (harness: string) => `What ${harness} is good at`,
  placeholder: (harness: string) =>
    `What ${harness} is good at here, and what to keep away from it. Write it any way you like.`,
  applies: (harness: string) =>
    `With @auto, xMatrix reads this to choose an Agent. It applies on every machine ${harness} runs on in this Space.`,
  empty: (harness: string) =>
    `Nothing written yet. A Space owner or admin, or anyone with a ${harness} agent here, can write it.`,
  save: "Save",
  cancel: "Cancel",
};

const zh: typeof en = {
  auto: "按各 Agent 适合做什么自动分配",
  edit: "写下它适合做什么",
  editNamed: (name) => `写下 ${name} 适合做什么`,
  title: "适合做什么",
  field: (harness) => `${harness} 适合做什么`,
  placeholder: (harness) => `${harness} 在这里适合做什么、哪些别交给它，怎么写都行。`,
  applies: (harness) => `用 @auto 时，xMatrix 按这段选 Agent。这个 Space 里所有运行 ${harness} 的机器都适用。`,
  empty: (harness) => `还没写。Space 的所有者或管理员，或在这里有 ${harness} 的人，可以写。`,
  save: "保存",
  cancel: "取消",
};

export type HarnessProfileCopy = typeof en;

export const HARNESS_PROFILE_COPY: Record<OnboardingLocale, HarnessProfileCopy> = { en, zh };
