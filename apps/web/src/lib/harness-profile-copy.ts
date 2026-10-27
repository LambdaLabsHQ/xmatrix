import type { OnboardingLocale } from "@xmatrix/protocol";

/* The mention menu and the When to pick it editor, in English and Chinese.
   Picked by the same locale as the first-ten-minutes path
   (onboarding-locale.ts): a saved Space display locale, otherwise the
   browser's language. */

const en = {
  hint: "Say when to pick each Agent. Auto uses it to choose.",
  edit: "Describe",
  editLong: "Say when to pick it",
  editNamed: (name: string) => `Say when to pick ${name}`,
  title: "When to pick it",
  field: (harness: string) => `When to pick ${harness}`,
  placeholder: (harness: string) =>
    `What ${harness} is good at here, and what to keep away from it. Write it any way you like.`,
  applies: (harness: string) =>
    `Read when work is assigned automatically. Applies on every machine ${harness} runs on in this Space.`,
  empty: (harness: string) =>
    `No description yet. A Space owner or admin, or anyone with a ${harness} agent here, can write one.`,
  save: "Save",
  cancel: "Cancel",
};

const zh: typeof en = {
  hint: "写下适合交给各个 Agent 的事，自动分配时会参考。",
  edit: "写说明",
  editLong: "写下适合交给它的事",
  editNamed: (name) => `写下适合交给 ${name} 的事`,
  title: "适合交给它的事",
  field: (harness) => `适合交给 ${harness} 的事`,
  placeholder: (harness) => `哪些事适合交给 ${harness}，哪些别交给它，怎么写都行。`,
  applies: (harness) => `自动分配时会参考这段。这个 Space 里所有运行 ${harness} 的机器都适用。`,
  empty: (harness) => `还没有说明。Space 的所有者或管理员，或在这里有 ${harness} 的人，可以写一段。`,
  save: "保存",
  cancel: "取消",
};

export type HarnessProfileCopy = typeof en;

export const HARNESS_PROFILE_COPY: Record<OnboardingLocale, HarnessProfileCopy> = { en, zh };
