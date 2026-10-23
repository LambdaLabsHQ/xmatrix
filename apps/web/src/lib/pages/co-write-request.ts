/**
 * A page opened to be co-written at once: whoever made it for that (the welcome's
 * "write a page with an agent") leaves which Agent to call, and the page calls it
 * when it opens, as a tap on that Agent's face would. Read once, in this tab only.
 */
const key = (pageId: string) => `xmatrix:co-write:${pageId}`;

export function keepCoWriteRequest(pageId: string, harness: string): void {
  window.sessionStorage.setItem(key(pageId), harness);
}

export function takeCoWriteRequest(pageId: string): string | null {
  const harness = window.sessionStorage.getItem(key(pageId));
  window.sessionStorage.removeItem(key(pageId));
  return harness;
}
