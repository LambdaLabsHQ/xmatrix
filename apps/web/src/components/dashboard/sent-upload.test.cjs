const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { createSentUpload, settleSentUploads, SentUploadFailed } = require("./sent-upload.ts");

function preview(id, name = `${id}.png`) {
  return { id, kind: "image", name, mimeType: "image/png", size: 10 };
}

function sentUpload(id, overrides = {}) {
  const cancelled = [];
  const upload = createSentUpload({
    id,
    preview: preview(id),
    state: { status: "uploading", progress: 40 },
    cancelHandedOver: () => cancelled.push(id),
    rerun: async () => ({ ...preview(`${id}-again`), url: undefined }),
    ...overrides,
  });
  return { upload, cancelled };
}

test("the message waits for the run the composer handed over", async () => {
  const { upload } = sentUpload("a");
  const states = [];
  upload.subscribe(() => states.push(upload.state()));
  upload.handover.update({ progress: 80 });
  upload.handover.resolve({ ...preview("uploaded-a") });

  assert.deepEqual(await upload.result(), preview("uploaded-a"));
  assert.deepEqual(states.map((state) => state.status), ["uploading", "uploaded"]);
  assert.equal(states[0].progress, 80);
});

test("draft attachments keep their order, quality changes replace in place, sent uploads follow", async () => {
  const draft = [preview("x"), preview("y")];
  const added = sentUpload("a").upload;
  const better = sentUpload("b", { replacesId: "x" }).upload;
  added.handover.resolve(preview("uploaded-a"));
  better.handover.resolve(preview("original-x"));

  const attachments = await settleSentUploads(draft, [added, better]);
  assert.deepEqual(attachments.map((attachment) => attachment.id), ["original-x", "y", "uploaded-a"]);
});

test("a failed quality change keeps the draft attachment it would have replaced", async () => {
  const better = sentUpload("b", { replacesId: "x" }).upload;
  better.handover.reject(new Error("network"));
  const attachments = await settleSentUploads([preview("x")], [better]);
  assert.deepEqual(attachments.map((attachment) => attachment.id), ["x"]);
});

test("a failed file fails the message, naming the file and keeping why", async () => {
  const { upload } = sentUpload("a");
  const why = new Error("network");
  upload.handover.reject(why);
  await assert.rejects(settleSentUploads([], [upload]), (error) => {
    assert.ok(error instanceof SentUploadFailed);
    assert.equal(error.fileName, "a.png");
    assert.equal(error.reason, why);
    return true;
  });
  assert.equal(upload.state().status, "failed");
});

test("retry uploads the file again and the message waits for the new run", async () => {
  const runs = [];
  const { upload } = sentUpload("a", {
    rerun: async ({ onState }) => {
      runs.push("again");
      onState({ status: "uploading", progress: 50, name: "ignored" });
      return preview("uploaded-again");
    },
  });
  upload.handover.reject(new Error("network"));
  upload.retry();
  assert.deepEqual(await upload.result(), preview("uploaded-again"));
  assert.deepEqual(runs, ["again"]);
  assert.deepEqual(upload.state(), { status: "uploaded", progress: 100 });
});

test("retry does nothing while the run is still going", () => {
  let reruns = 0;
  const { upload } = sentUpload("a", { rerun: async () => { reruns += 1; return null; } });
  upload.retry();
  assert.equal(reruns, 0);
});

test("cancelling ends the composer's run, and a late answer from it changes nothing", async () => {
  const { upload, cancelled } = sentUpload("a");
  upload.cancel();
  upload.handover.resolve(preview("too-late"));
  await assert.rejects(upload.result(), (error) => error.name === "AbortError");
  assert.deepEqual(cancelled, ["a"]);
  assert.equal(upload.state().status, "failed");
});
