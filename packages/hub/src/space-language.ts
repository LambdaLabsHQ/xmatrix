/** The languages the Space setting offers for what xMatrix writes, the About and App notifications among it. */
export type SpaceLanguage = "zh" | "en";

/**
 * The Space's language setting, never a guess from the conversation or a model: the About is
 * written in it. The earlier `preferredLanguage` key is still read; with neither, English.
 */
export function spaceLanguage(metadata: unknown): SpaceLanguage {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "en";
  const record = metadata as Record<string, unknown>;
  const locale = record.locale;
  if (locale && typeof locale === "object" && !Array.isArray(locale)) {
    const defaultLocale = (locale as Record<string, unknown>).defaultLocale;
    if (typeof defaultLocale === "string") {
      if (defaultLocale.toLowerCase().startsWith("zh")) return "zh";
      if (defaultLocale.toLowerCase().startsWith("en")) return "en";
    }
  }
  return record.preferredLanguage === "zh" ? "zh" : "en";
}
