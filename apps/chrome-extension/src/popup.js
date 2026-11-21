import { capturableUrl, composeMessage } from "./compose.js";
import { DEFAULT_APP_URL, channelUrl } from "./hub-client.js";

const $ = (id) => document.getElementById(id);
const views = ["view-signed-out", "view-signing-in", "view-compose", "view-sent"];

function show(view) {
  for (const id of views) $(id).hidden = id !== view;
}

async function ask(type, args) {
  const answer = await chrome.runtime.sendMessage({ type, args });
  if (!answer?.ok) {
    const error = new Error(answer?.error ?? "xMatrix could not be reached.");
    error.code = answer?.code;
    throw error;
  }
  return answer.value;
}

function fail(element, error) {
  element.textContent = error instanceof Error ? error.message : String(error);
  element.hidden = false;
}

function fill(select, items, selectedId) {
  select.replaceChildren(...items.map((item) => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.needsYou ? `● ${item.name}` : item.name;
    option.selected = item.id === selectedId;
    return option;
  }));
}

/** The page the popup was opened on, with the selected text when the page allows reading it. */
async function activeTabCapture() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = capturableUrl(tab?.url ?? "");
  if (!tab || !url) return null;
  let selection = "";
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => String(globalThis.getSelection?.() ?? ""),
    });
    selection = typeof result?.result === "string" ? result.result : "";
  } catch {
    // Pages the extension may not script (the Web Store, other extensions) still send their link.
  }
  return { url, title: tab.title ?? "", selection };
}

let capture = null;
let channelsBySpace = new Map();

function renderCapture() {
  $("capture").hidden = !capture;
  if (!capture) return;
  $("capture-title").textContent = capture.title || capture.url;
  $("capture-title").title = capture.url;
  $("capture-selection").hidden = !capture.selection;
  $("capture-selection").textContent = capture.selection;
}

async function loadChannels(spaceId, selectedId) {
  const select = $("channel");
  select.disabled = true;
  try {
    const channels = channelsBySpace.get(spaceId) ?? await ask("channels", { spaceId });
    channelsBySpace.set(spaceId, channels);
    fill(select, channels, selectedId);
    $("send").disabled = channels.length === 0;
    if (channels.length === 0) fail($("compose-error"), "This Space has no conversations yet. Start one in xMatrix first.");
  } finally {
    select.disabled = false;
  }
}

async function renderCompose(state) {
  show("view-compose");
  $("who").textContent = state.user?.name ?? "";
  $("sign-out").hidden = false;
  capture = state.capture ?? await activeTabCapture();
  renderCapture();
  const [spaces, last] = await Promise.all([ask("spaces"), ask("lastTarget")]);
  if (spaces.length === 0) {
    fail($("compose-error"), "You are not in any Space yet.");
    $("send").disabled = true;
    return;
  }
  const spaceId = spaces.some((space) => space.id === last?.spaceId) ? last.spaceId : spaces[0].id;
  fill($("space"), spaces, spaceId);
  await loadChannels(spaceId, last?.spaceId === spaceId ? last.channelId : undefined);
  $("note").focus();
}

async function render() {
  $("compose-error").hidden = true;
  const state = await ask("state");
  if (state.signedIn) return renderCompose(state);
  $("who").textContent = "";
  $("sign-out").hidden = true;
  if (state.signIn) {
    show("view-signing-in");
    $("user-code").textContent = state.signIn.userCode ?? "";
    $("sign-in-error").hidden = !state.signIn.error;
    $("sign-in-error").textContent = state.signIn.error ?? "";
    return;
  }
  show("view-signed-out");
}

$("sign-in").addEventListener("click", async () => {
  $("sign-in").disabled = true;
  $("signed-out-error").hidden = true;
  try {
    await ask("signIn");
    await render();
  } catch (error) {
    fail($("signed-out-error"), error);
  } finally {
    $("sign-in").disabled = false;
  }
});

$("cancel-sign-in").addEventListener("click", async () => {
  await ask("cancelSignIn");
  await render();
});

$("sign-out").addEventListener("click", async () => {
  await ask("signOut");
  channelsBySpace = new Map();
  await render();
});

$("space").addEventListener("change", (event) => {
  $("compose-error").hidden = true;
  loadChannels(event.target.value).catch((error) => fail($("compose-error"), error));
});

$("view-compose").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("compose-error").hidden = true;
  const body = composeMessage({
    note: $("note").value,
    title: capture?.title,
    url: capture?.url,
    selection: capture?.selection,
    includePage: Boolean(capture) && $("include-page").checked,
  });
  if (!body) {
    fail($("compose-error"), "Write a message or include the page.");
    return;
  }
  const spaceId = $("space").value;
  const channelId = $("channel").value;
  $("send").disabled = true;
  try {
    await ask("send", { channelId, body, clientMessageId: crypto.randomUUID() });
    await ask("rememberTarget", { spaceId, channelId });
    $("open-channel").href = channelUrl(DEFAULT_APP_URL, spaceId, channelId);
    show("view-sent");
  } catch (error) {
    if (error.code === "signed_out") await render();
    else fail($("compose-error"), error);
  } finally {
    $("send").disabled = false;
  }
});

// The sign-in finishes in the service worker while this popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "local" && changes.session) || (area === "session" && changes.signIn)) {
    if ($("view-compose").hidden) render().catch(() => undefined);
  }
});

render().catch((error) => {
  show("view-signed-out");
  fail($("signed-out-error"), error);
});
