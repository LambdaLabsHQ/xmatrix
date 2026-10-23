import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFaceUrl, faceInitials, faceKey, faceOfSender, staticFace, XMATRIX_FACE_URL } from "../dist/index.js";

test("an Agent's face is its harness's mark, whatever alias the harness was written with", () => {
  const claude = agentFaceUrl("claude");
  assert.ok(claude?.startsWith("/agent-vendors/"));
  assert.equal(agentFaceUrl("claude_code"), claude);
  assert.equal(agentFaceUrl("cursor-agent"), agentFaceUrl("cursor"));
  assert.equal(agentFaceUrl("custom"), undefined, "a custom harness has no mark");
  assert.equal(agentFaceUrl(null), undefined);
});

test("letters stand for a face with no picture: the first letters of its first two words", () => {
  assert.equal(faceInitials("Daniel Melody"), "DM");
  assert.equal(faceInitials("ada.lovelace@example.com"), "AL");
  assert.equal(faceInitials("王小明"), "王");
  assert.equal(faceInitials("   "), "XM");
});

test("only a person, or an Agent known by its Instance alone, is read; every other face is known at once", () => {
  assert.equal(staticFace({ kind: "user", id: "u1", name: "Daniel" }), null);
  assert.equal(staticFace({ kind: "agent", name: "claude:1", id: "c:1" }), null);
  assert.deepEqual(staticFace({ kind: "agent", name: "claude:1", harness: "claude", id: "c:1" }),
    { imageUrl: agentFaceUrl("claude"), initials: "C" });
  assert.deepEqual(staticFace({ kind: "external", name: "Ann Slack", imageUrl: "https://slack.example/ann.png" }),
    { imageUrl: "https://slack.example/ann.png", initials: "AS" });
  assert.deepEqual(staticFace({ kind: "system", name: "xMatrix" }), { imageUrl: XMATRIX_FACE_URL, initials: "X" });
  assert.equal(staticFace({ kind: "app", id: "github", name: "GitHub" }).imageUrl, "/app-connectors/github.svg");
  assert.equal(staticFace({ kind: "machine", name: "srv" }).imageUrl, undefined);
  assert.equal(faceKey({ kind: "user", id: "u1", name: "" }), "user:u1");
  assert.equal(faceKey({ kind: "agent", id: "c:1", name: "" }), "agent:c:1");
});

test("a message's sender is a person by account, an Agent by its registered harness, an import by its source's picture", () => {
  const base = { label: "Daniel", userId: "u1", email: "" };
  assert.deepEqual(faceOfSender({ ...base, kind: "user", avatarUrl: "https://stale.example/old.png" }),
    { kind: "user", id: "u1", name: "Daniel" }, "a person's copied picture is not their face");
  assert.deepEqual(faceOfSender({ ...base, kind: "user", userId: "slack:U1", label: "Ann", avatarUrl: "https://slack.example/a.png" }),
    { kind: "external", name: "Ann", imageUrl: "https://slack.example/a.png" });
  assert.deepEqual(faceOfSender({ ...base, kind: "agent", label: "claude:1", instanceId: "chan:1",
    registration: { ownerUserId: "u1", machineId: "m", harness: "claude" } }),
  { kind: "agent", name: "claude:1", harness: "claude", id: "chan:1" });
  assert.deepEqual(faceOfSender({ ...base, kind: "agent", label: "claude:1", instanceId: "chan:1" }),
    { kind: "agent", name: "claude:1", harness: null, id: "chan:1" }, "an older message's Agent is read by its Instance");
  assert.deepEqual(faceOfSender({ ...base, kind: "app", label: "GitHub", identityId: "app:github" }),
    { kind: "app", id: "github", name: "GitHub" });
  assert.deepEqual(faceOfSender({ ...base, kind: "system", label: "xMatrix" }), { kind: "system", name: "xMatrix" });
  assert.deepEqual(faceOfSender({ ...base, kind: "user", userId: "", label: "Ann", avatarUrl: "https://example.com/old.png" }),
    { kind: "external", name: "Ann" }, "a sender that names no account is no one's face, not a copied picture");
  assert.deepEqual(faceOfSender({ ...base, kind: "user", label: "xMatrix", avatarUrl: XMATRIX_FACE_URL }),
    { kind: "system", name: "xMatrix" }, "a notice written under its owner's authority is xMatrix's");
});
