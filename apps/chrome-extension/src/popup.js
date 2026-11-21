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

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let spaces = [];
let spaceId = null;
let channelId = null;

function renderSpaces() {
  const current = spaces.find((space) => space.id === spaceId);
  $("space-name").textContent = current?.name ?? "";
  $("space-button").disabled = spaces.length < 2;
  $("space-menu").replaceChildren(...spaces.map((space) => {
    const item = element("button", "", space.name);
    item.type = "button";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(space.id === spaceId));
    if (space.id === spaceId) item.append(element("span", "", "✓"));
    item.addEventListener("click", () => {
      closeSpaceMenu();
      if (space.id === spaceId) return;
      spaceId = space.id;
      renderSpaces();
      $("compose-error").hidden = true;
      loadChannels(space.id).catch((error) => fail($("compose-error"), error));
    });
    return item;
  }));
}

function closeSpaceMenu() {
  $("space-menu").hidden = true;
  $("space-button").setAttribute("aria-expanded", "false");
}

function channelRow(channel) {
  const row = element("button", "row");
  row.type = "button";
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", String(channel.id === channelId));
  row.append(element("span", "hash", "#"), element("span", "name", channel.name), element("span", "check", "✓"));
  row.addEventListener("click", () => {
    channelId = channel.id;
    for (const other of $("channels").querySelectorAll(".row")) other.setAttribute("aria-selected", String(other === row));
  });
  return row;
}

/** "Needs you" first, then "Recent", as the app's conversation list. */
function renderChannels(channels) {
  const list = $("channels");
  if (channels.length === 0) {
    list.replaceChildren(element("p", "empty", "This Space has no conversations yet. Start one in xMatrix first."));
    return;
  }
  const waiting = channels.filter((channel) => channel.needsYou);
  const rest = channels.filter((channel) => !channel.needsYou);
  const nodes = [];
  if (waiting.length) nodes.push(element("div", "heading waiting", "Needs you"), ...waiting.map(channelRow));
  if (rest.length) nodes.push(element("div", "heading recent", "Recent"), ...rest.map(channelRow));
  list.replaceChildren(...nodes);
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
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

function includePage() {
  return $("include-page").getAttribute("aria-checked") === "true";
}

async function loadChannels(id, selectedId) {
  $("channels").replaceChildren(element("p", "empty", "Loading conversations…"));
  const channels = channelsBySpace.get(id) ?? await ask("channels", { spaceId: id });
  channelsBySpace.set(id, channels);
  if (id !== spaceId) return;
  channelId = channels.some((channel) => channel.id === selectedId) ? selectedId : channels[0]?.id ?? null;
  renderChannels(channels);
  $("send").disabled = !channelId;
}

async function renderCompose(state) {
  show("view-compose");
  $("who").textContent = state.user?.name ?? "";
  $("sign-out").hidden = false;
  capture = state.capture ?? await activeTabCapture();
  renderCapture();
  const [list, last] = await Promise.all([ask("spaces"), ask("lastTarget")]);
  spaces = list;
  if (spaces.length === 0) {
    fail($("compose-error"), "You are not in any Space yet.");
    $("send").disabled = true;
    return;
  }
  spaceId = spaces.some((space) => space.id === last?.spaceId) ? last.spaceId : spaces[0].id;
  renderSpaces();
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

$("space-button").addEventListener("click", () => {
  const open = $("space-menu").hidden;
  $("space-menu").hidden = !open;
  $("space-button").setAttribute("aria-expanded", String(open));
  if (open) $("space-menu").querySelector('[aria-checked="true"]')?.focus();
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".space-row")) closeSpaceMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("space-menu").hidden) {
    event.preventDefault();
    closeSpaceMenu();
    $("space-button").focus();
  }
});

$("include-page").addEventListener("click", () => {
  const on = !includePage();
  $("include-page").setAttribute("aria-checked", String(on));
  $("capture").classList.toggle("off", !on);
});

$("view-compose").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("compose-error").hidden = true;
  const body = composeMessage({
    note: $("note").value,
    title: capture?.title,
    url: capture?.url,
    selection: capture?.selection,
    includePage: Boolean(capture) && includePage(),
  });
  if (!body) {
    fail($("compose-error"), "Write a message or include the page.");
    return;
  }
  if (!channelId) return;
  const target = { spaceId, channelId };
  $("send").disabled = true;
  try {
    await ask("send", { channelId: target.channelId, body, clientMessageId: crypto.randomUUID() });
    await ask("rememberTarget", target);
    const name = channelsBySpace.get(target.spaceId)?.find((channel) => channel.id === target.channelId)?.name;
    $("sent-to").textContent = name ? `Posted to #${name}.` : "";
    $("open-channel").href = channelUrl(DEFAULT_APP_URL, target.spaceId, target.channelId);
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
