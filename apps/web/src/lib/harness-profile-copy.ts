import type { OnboardingLocale } from "@xmatrix/protocol";

/* The mention menu and the When to pick it editor, in English and Chinese.
   Picked by the same locale as the first-ten-minutes path
   (onboarding-locale.ts): a saved Space display locale, otherwise the
   browser's language. */

const en = {
  hint: "What an agent is good at can be written.",
  edit: "Click to edit",
  editLong: "Click to edit what it's good at",
  editNamed: (name: string) => `Click to edit what ${name} is good at`,
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
  hint: "Agent 擅长什么、不擅长什么，都可以写。",
  edit: "点击修改",
  editLong: "点击此处修改它的优势劣势",
  editNamed: (name) => `点击此处修改 ${name} 的优势劣势`,
  title: "擅长什么",
  field: (harness) => `${harness} 擅长什么`,
  placeholder: (harness) => `写 ${harness} 在这里擅长什么、什么别交给它。怎么写都行。`,
  applies: (harness) => `自动派活时会读这段。这个 Space 里每台跑 ${harness} 的机器都适用。`,
  empty: (harness) => `还没有说明。Space 的所有者或管理员，或者这里有 ${harness} 的人，可以写一段。`,
  save: "保存",
  cancel: "取消",
};

export type HarnessProfileCopy = typeof en;

export const HARNESS_PROFILE_COPY: Record<OnboardingLocale, HarnessProfileCopy> = { en, zh };
