import { extensionEmbedParent } from "./extension-embed";
import { appUrl } from "./site-url";

/**
 * The origin this app's addresses are written and read against. It is the
 * page's own, except in the Chrome extension: there the app is a packaged
 * file at the extension's origin, and a link copied from it, or a link in a
 * message that leads back into it, is an address of the Web.
 */
export function appAddressOrigin(): string {
  if (typeof window === "undefined" || extensionEmbedParent()) return appUrl.origin;
  return window.location.origin;
}

/** This page's address as anyone else would open it (`appAddressOrigin`). */
export function appAddressHref(): string {
  const { pathname, search, hash } = window.location;
  return `${appAddressOrigin()}${pathname}${search}${hash}`;
}
