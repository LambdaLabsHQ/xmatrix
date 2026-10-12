import type { McpResourceContent } from "./mcp-jsonrpc";

export const PAGE_CARD_URI = "ui://xmatrix/page-card-v1.html";
export const PAGE_CARD_MIME = "text/html;profile=mcp-app";

/** A static MCP Apps view. Private page data only arrives in the authorized tool result. */
export function pageCardResource(appUrl: string): McpResourceContent {
  const origin = new URL(appUrl).origin;
  return {
    uri: PAGE_CARD_URI, mimeType: PAGE_CARD_MIME,
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
      "openai/widgetDescription": "An xMatrix page with its title, revision, text preview and source link." },
    text: `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}
body{margin:0;padding:20px}h1{font-size:20px;margin:8px 0;overflow-wrap:anywhere}
p{font-size:13px;opacity:.7}pre{font:14px/1.6 system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto}
button{font:inherit;border:1px solid currentColor;border-radius:8px;background:transparent;color:inherit;padding:8px 12px;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
</style></head><body><p>xMatrix page</p><h1 id="title">Loading page…</h1>
<p id="revision" aria-live="polite"></p><pre id="body"></pre><button id="open" disabled>Open in xMatrix</button>
<script>
const allowedOrigin = ${JSON.stringify(origin).replace(/</gu, "\\u003c")};
const title = document.getElementById("title");
const revision = document.getElementById("revision");
const body = document.getElementById("body");
const open = document.getElementById("open");
let pageUrl;
let initialized = false;
let nextId = 2;
function post(message) { window.parent.postMessage({jsonrpc:"2.0", ...message}, "*"); }
function render(data) {
  if (!data || typeof data.title !== "string" || typeof data.body !== "string") return;
  title.textContent = data.title;
  revision.textContent = "Revision " + String(data.revision ?? "—");
  body.textContent = data.body.slice(0, 4000) + (data.body.length > 4000 ? "\\n…" : "");
  pageUrl = undefined;
  try {
    const url = new URL(data.url);
    if (url.origin === allowedOrigin && !url.username && !url.password && /^\\/app\\/[^/]+\\/pages$/.test(url.pathname)
      && url.searchParams.has("page")) pageUrl = url.href;
  } catch {}
  open.disabled = !pageUrl;
}
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.id === 1 && message.result?.protocolVersion === "2026-01-26" && !initialized) {
    initialized = true;
    post({method:"ui/notifications/initialized",params:{}});
  }
  if (message.method === "ui/resource-teardown" && message.id !== undefined) {
    pageUrl = undefined;
    body.textContent = "";
    open.disabled = true;
    post({id:message.id,result:{}});
  }
  if (message.method === "ui/notifications/tool-cancelled") {
    title.textContent = "Page request cancelled";
    body.textContent = "";
    pageUrl = undefined;
    open.disabled = true;
  }
  if (initialized && message.method === "ui/notifications/tool-result") {
    if (message.params?.isError) { title.textContent = "Page unavailable"; body.textContent = ""; open.disabled = true; pageUrl = undefined; }
    else render(message.params?.structuredContent);
  }
});
open.onclick = () => { if (pageUrl) post({id:nextId++,method:"ui/open-link",params:{url:pageUrl}}); };
post({id:1,method:"ui/initialize",params:{protocolVersion:"2026-01-26",
  appInfo:{name:"xMatrix page",version:"1.0.0"},appCapabilities:{availableDisplayModes:["inline"]}}});
</script></body></html>`,
  };
}
