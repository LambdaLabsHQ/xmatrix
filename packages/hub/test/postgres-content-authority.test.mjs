import assert from "node:assert/strict";
import test from "node:test";

import { sealMessageAttachments } from "../src/postgres-content-authority.ts";

test("sealing attachments fails closed without the PostgreSQL binding", async () => {
  await assert.rejects(sealMessageAttachments({}, {}), /PostgreSQL content bindings are unavailable/u);
});
