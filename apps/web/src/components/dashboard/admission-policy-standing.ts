import type { SettingDescriptor } from "@xmatrix/protocol";

/** The Space's adopted admission policy as the Hub reads it for this viewer; its text only for one who may adopt. */
export interface AdmissionPolicyView {
  policy?: { pageId: string; libraryName: string; sourceText: string; adoptedAt: string };
  canAdopt: boolean;
  /** Where the adopted library stands on its Page now. */
  setting?: SettingDescriptor;
}

/** What the row says about the adopted text against its Page, and whether the Page's text can replace it. */
export function admissionPolicyStanding(view: AdmissionPolicyView): { word: string; note?: string; adoptable?: string } {
  const { setting } = view;
  if (!setting || setting.satisfied) return { word: "Adopted" };
  if (setting.state === "invalid") {
    return { word: "Adopted", note: `Its Page no longer holds a text that can be adopted; the adopted text stays in force. ${setting.problem ?? ""}`.trim() };
  }
  return { word: "Changed on its Page", note: "The Page's text changed since; the adopted text stays in force until the new one is adopted.",
    ...(view.canAdopt && setting.canWrite && setting.value ? { adoptable: setting.value } : {}) };
}
