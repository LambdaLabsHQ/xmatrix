/**
 * The only pages allowed to frame the app: the xMatrix Chrome extension's side
 * panel (apps/chrome-extension). Its ID is fixed by the Chrome Web Store item's
 * key, which the unpacked development build carries too. The CSP
 * `frame-ancestors` (next.config.ts) and the embed handshake
 * (extension-embed.ts) both read this list; any other page still cannot frame
 * the app.
 */
export const EXTENSION_EMBED_ORIGINS: readonly string[] = [
  "chrome-extension://kaickfjmldmlelnfijaahialjpnebnak",
];
