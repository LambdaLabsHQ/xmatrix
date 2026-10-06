const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const sourceRoot = path.resolve(__dirname, "../..");
const {
  loadWorkspaceShellModuleMap,
  loadWorkspaceShellSource,
  extractFunctionFromShellModules,
  countOccurrences,
} = require("./workspace-shell-source-fixture.cjs");
const shellModules = loadWorkspaceShellModuleMap(__dirname);
const shellSource = loadWorkspaceShellSource(__dirname);
const agentTraceOnDemandSource = fs.readFileSync(
  path.join(__dirname, "agent-trace-on-demand.ts"),
  "utf8"
);
const agentTraceHistorySyncSource = fs.readFileSync(
  path.join(__dirname, "use-agent-trace-history-sync.ts"),
  "utf8"
);
/**
 * @param {string} source
 * @param {string} functionName
 * @param {{ allowNested?: boolean, file?: string }} [options]
 */
function extractFunctionSource(source, functionName, options = {}) {
  // Prefer map-wide unique AST lookup when source is the concatenated graph.
  if (source === shellSource) {
    return extractFunctionFromShellModules(shellModules, functionName, options).source;
  }
  const { extractFunctionSource: extractInModule } = require("./workspace-shell-source-fixture.cjs");
  return extractInModule(source, functionName, options);
}

const productTailCacheStoreSource = fs.readFileSync(
  path.join(sourceRoot, "lib/relay-v2/product-tail-cache-store.ts"),
  "utf8"
);
const channelHumanMembersSource = fs.readFileSync(
  path.join(__dirname, "channel-human-members.ts"),
  "utf8"
);
const workspaceShellActionsSource = fs.readFileSync(
  path.join(__dirname, "use-workspace-shell-actions.ts"),
  "utf8"
);
const messageSendDeadlineSource = fs.readFileSync(
  path.join(sourceRoot, "lib/relay-v2/message-send-deadline.ts"),
  "utf8"
);
const messageTimelineSource = fs.readFileSync(
  path.join(__dirname, "workspace-message-timeline.tsx"),
  "utf8"
);
const messageJumpSource = fs.readFileSync(
  path.join(__dirname, "use-message-jump.ts"),
  "utf8"
);
const workspaceShellStateSource = fs.readFileSync(
  path.join(__dirname, "use-workspace-shell-state.ts"),
  "utf8"
);
const recipientScopedNativeNotificationSource = fs.readFileSync(
  path.join(__dirname, "recipient-scoped-native-message-notification.ts"),
  "utf8"
);
const workspaceShellChromeSource = fs.readFileSync(
  path.join(__dirname, "workspace-shell-chrome.tsx"),
  "utf8"
);
const humanFocusHistoryFallbackSource = fs.readFileSync(
  path.join(__dirname, "use-human-focus-history-http-fallback.ts"),
  "utf8"
);
const channelHistoryApiSource = fs.readFileSync(
  path.join(__dirname, "workspace-admin-views.tsx"),
  "utf8"
);
const humanProfileViewSource = fs.readFileSync(
  path.join(__dirname, "human-profile-view.tsx"),
  "utf8"
);
const humanProfileEditorSource = fs.readFileSync(
  path.join(__dirname, "human-profile-editor.tsx"),
  "utf8"
);
const identityAvatarSource = fs.readFileSync(path.join(__dirname, "identity-avatar.tsx"), "utf8");
const navigationSource = fs.readFileSync(
  path.join(__dirname, "workspace-shell-navigation.ts"),
  "utf8"
);
const androidBackSource = fs.readFileSync(
  path.join(__dirname, "use-android-back.ts"),
  "utf8"
);
// The iOS shell replaces the web dock with a native UITabBar, so the two tab
// lists have to be kept in step from here.
const iosTabBarSource = fs.readFileSync(
  path.resolve(sourceRoot, "../../ios/xMatrix/MobileTabBarView.swift"),
  "utf8"
);
const globalsCss = fs.readFileSync(path.join(sourceRoot, "app/globals.css"), "utf8");
const liquidGlassCss = fs.readFileSync(path.join(sourceRoot, "app/liquid-glass.css"), "utf8");
const materialsCss = fs.readFileSync(path.join(sourceRoot, "app/themes/materials.css"), "utf8");
const woodThemeCss = fs.readFileSync(path.join(sourceRoot, "app/themes/wood.css"), "utf8");
const landingCardSources = [
  "architecture.tsx",
  "desktop-download.tsx",
  "pricing.tsx",
  "problem-statement.tsx",
].map((file) => fs.readFileSync(path.join(sourceRoot, "components/landing", file), "utf8"));

module.exports = {
  assert,
  fs,
  path,
  test,
  sourceRoot,
  loadWorkspaceShellModuleMap,
  loadWorkspaceShellSource,
  extractFunctionFromShellModules,
  countOccurrences,
  shellModules,
  shellSource,
  agentTraceOnDemandSource,
  agentTraceHistorySyncSource,
  extractFunctionSource,
  productTailCacheStoreSource,
  channelHumanMembersSource,
  workspaceShellActionsSource,
  messageSendDeadlineSource,
  messageTimelineSource,
  messageJumpSource,
  workspaceShellStateSource,
  recipientScopedNativeNotificationSource,
  workspaceShellChromeSource,
  humanFocusHistoryFallbackSource,
  channelHistoryApiSource,
  humanProfileViewSource,
  humanProfileEditorSource,
  identityAvatarSource,
  navigationSource,
  androidBackSource,
  iosTabBarSource,
  globalsCss,
  liquidGlassCss,
  materialsCss,
  woodThemeCss,
  landingCardSources,
};
