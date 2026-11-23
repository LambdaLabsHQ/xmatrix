const assert = require("node:assert/strict");
const test = require("node:test");

require("./typescript-require.cjs").installTypeScriptRequire();
const {
  attachmentPanelKey,
  loadNativePickedAttachments,
} = require("./composer-attachment-picker.ts");

test("attachment panel keyboard navigation wraps across sources and picks on Enter", () => {
  assert.equal(attachmentPanelKey({ open: false, active: 0, key: "Escape" }), null);
  assert.deepEqual(attachmentPanelKey({ open: true, active: -1, key: "ArrowDown" }), { active: 0 });
  assert.deepEqual(attachmentPanelKey({ open: true, active: -1, key: "ArrowUp" }), { active: 2 });
  assert.equal(attachmentPanelKey({ open: true, active: -1, key: "Enter" }), null);
  assert.deepEqual(attachmentPanelKey({ open: true, active: 0, key: "ArrowDown" }), { active: 1 });
  assert.deepEqual(attachmentPanelKey({ open: true, active: 2, key: "ArrowDown" }), { active: 0 });
  assert.deepEqual(attachmentPanelKey({ open: true, active: 0, key: "ArrowUp" }), { active: 2 });
  assert.deepEqual(attachmentPanelKey({ open: true, active: 1, key: "Enter" }), { active: null, pick: "camera" });
  assert.deepEqual(attachmentPanelKey({ open: true, active: 1, key: "Escape" }), { active: null });
  assert.equal(attachmentPanelKey({ open: true, active: 0, key: "a" }), null);
});

test("loadNativePickedAttachments reassembles multi-chunk files and always releases staged tokens", async () => {
  const payload = Buffer.from("0123456789abcdef-native-video");
  const released = [];
  const reads = [];

  const bridge = {
    async pickAttachments({ source }) {
      assert.equal(source, "photos");
      return [{ token: "tok-1", name: "clip.mp4", mimeType: "video/mp4", size: payload.length }];
    },
    async readPickedAttachmentChunk({ token, offset, length }) {
      reads.push({ token, offset, length });
      const slice = payload.subarray(offset, offset + length);
      return {
        dataBase64: slice.toString("base64"),
        bytesRead: slice.length,
        eof: offset + slice.length >= payload.length,
      };
    },
    async releasePickedAttachment({ token }) {
      released.push(token);
    },
  };

  const files = await loadNativePickedAttachments(bridge, "photos", 1024, "1 KB", 8);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "clip.mp4");
  assert.equal(files[0].type, "video/mp4");
  assert.equal(Buffer.from(await files[0].arrayBuffer()).toString("utf8"), payload.toString("utf8"));
  assert.equal(reads.length, 4);
  assert.deepEqual(released, ["tok-1"]);
});

test("loadNativePickedAttachments rejects oversized or stalled reads while still releasing tokens", async () => {
  const released = [];
  const oversizedBridge = {
    async pickAttachments() {
      return [{ token: "tok-big", name: "huge.mov", mimeType: "video/quicktime", size: 2048 }];
    },
    async readPickedAttachmentChunk() {
      throw new Error("should not read oversized file");
    },
    async releasePickedAttachment({ token }) {
      released.push(token);
    },
  };

  await assert.rejects(
    () => loadNativePickedAttachments(oversizedBridge, "files", 1024, "1 KB", 256),
    /1 KB or smaller/
  );
  assert.deepEqual(released, ["tok-big"]);

  const stalledReleased = [];
  const stalledBridge = {
    async pickAttachments() {
      return [{ token: "tok-stall", name: "broken.bin", mimeType: "application/octet-stream", size: 16 }];
    },
    async readPickedAttachmentChunk() {
      return { dataBase64: "", bytesRead: 0, eof: false };
    },
    async releasePickedAttachment({ token }) {
      stalledReleased.push(token);
    },
  };

  await assert.rejects(
    () => loadNativePickedAttachments(stalledBridge, "files", 1024, "1 KB", 8),
    /Could not read the selected file/
  );
  assert.deepEqual(stalledReleased, ["tok-stall"]);
});
