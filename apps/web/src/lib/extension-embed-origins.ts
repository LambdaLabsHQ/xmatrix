/**
 * The xMatrix Chrome extension (apps/chrome-extension), which packages the
 * app and shows it in its side panel. Its ID is fixed by the Chrome Web Store
 * item's key, which the unpacked development build carries too. The app
 * behaves as the panel's app (extension-embed.ts) only in a page of this
 * origin that this origin frames.
 */
export const EXTENSION_EMBED_ORIGINS: readonly string[] = [
  "chrome-extension://kaickfjmldmlelnfijaahialjpnebnak",
];
