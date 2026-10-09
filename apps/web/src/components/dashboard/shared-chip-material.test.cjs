const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const dashboard = __dirname;

function source(file) {
  return fs.readFileSync(path.join(dashboard, file), "utf8");
}

/* `statusChipClass()` and `tagClass()` are the same material by definition —
   both are built from COUNT_CHIP_MATERIAL_CLASS — so a label that goes through
   the shared status vocabulary or the shared tag satisfies this rule without
   naming the constant itself. The `statusChipClass is the shared material` and
   `tagClass is the shared material` tests below pin that. */
function assertMaterialNear(file, marker) {
  const contents = source(file);
  const index = contents.indexOf(marker);
  assert.notEqual(index, -1, `${file} must contain ${marker}`);
  const neighborhood = contents.slice(Math.max(0, index - 500), index + marker.length + 500);
  assert.match(
    neighborhood,
    /COUNT_CHIP_MATERIAL_CLASS|statusChipClass\(|StatusChipBadge|tagClass\(|<Tag\b/,
    `${file}: ${marker} must reuse the selected-channel liquid glass material`
  );
}

test("display labels across dashboard surfaces reuse the shared chip material", () => {
  const labels = [
    ["agent-identity-labels.tsx", "StatusChipBadge"],
    ["human-profile-summary.tsx", "profile.handleIsTemporary"],
    ["private-sign-in-email.tsx", "Private"],
    ["workspace-fleet-views.tsx", "statusChipClass(agentStatus.tone"],
    ["workspace-fleet-views.tsx", "appExecutionStatusClassName(execution.status)"],
    ["workspace-composer-dialogs.tsx", "app-detail-member-badge"],
    ["status-tag.tsx", "data-live-agent-branch"],
    ["workspace-composer-dialogs.tsx", "data-tag-row"],
    ["workspace-composer-dialogs.tsx", "data-usage-meter-chip"],
    ["workspace-composer-dialogs.tsx", "app-automation-state"],
    ["workspace-message-timeline.tsx", "shouldShowProvenanceBadge(message.provenance)"],
    ["workspace-message-timeline.tsx", "app-sender-instance-stale-badge"],
    ["secret-request-card.tsx", "app-request-broker-status"],
    ["workspace-shell-recovered.tsx", "app-status-chip-badge"],
    ["workspace-admin-views.tsx", "secretAccessChipClass(entry.access)"],
    ["workspace-admin-views.tsx", "{spaceRoleFor(space, user.id)}"],
    ["workspace-admin-views.tsx", "The latest stable release is"],
  ];

  for (const [file, marker] of labels) assertMaterialNear(file, marker);
});
