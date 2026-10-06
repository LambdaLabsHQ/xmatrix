import assert from "node:assert/strict";

import { test } from "node:test";

import {
  RUNTIME_ROUTE_DIRECTORY_GENERATION,
  RUNTIME_ROUTE_DIRECTORY_ENTRY_TTL_MS,
  RUNTIME_ROUTE_DIRECTORY_MAX_SCOPE_IDS_PER_REQUEST,
  RUNTIME_ROUTE_DIRECTORY_OWNER_CELL_TTL_MS,
  RUNTIME_ROUTE_DIRECTORY_SHARD_COUNT,
  isRuntimeRouteDirectoryCell,
  isRuntimeRouteDirectoryScopeId,
  runtimeRouteDirectoryEntryTtlMs,
  runtimeRouteDirectoryShardName,
} from "../src/runtime-transport/runtime-route-directory-locator.ts";

test("runtime route directory has a fixed closed shard set", () => {
  assert.equal(RUNTIME_ROUTE_DIRECTORY_GENERATION, "runtime-route-directory-v1");
  assert.equal(RUNTIME_ROUTE_DIRECTORY_SHARD_COUNT, 16);
  assert.equal(RUNTIME_ROUTE_DIRECTORY_MAX_SCOPE_IDS_PER_REQUEST, 100);
  const names = new Set();
  for (let index = 0; index < 16_000; index += 1) {
    names.add(runtimeRouteDirectoryShardName(`channel:route-directory-${index}`));
  }
  assert.deepEqual([...names].sort(), Array.from(
    { length: RUNTIME_ROUTE_DIRECTORY_SHARD_COUNT },
    (_, index) => `runtime-route-directory-v1-${index.toString(10).padStart(2, "0")}`,
  ));
});

test("scope ids are bounded before they can select a directory Durable Object", () => {
  assert.equal(isRuntimeRouteDirectoryScopeId("channel:ch-1"), true);
  assert.equal(runtimeRouteDirectoryShardName(""), undefined);
  assert.equal(runtimeRouteDirectoryShardName("scope\u0000injected"), undefined);
  assert.equal(runtimeRouteDirectoryShardName("x".repeat(201)), undefined);
});

test("a user's own cell is routable and keeps its long-lived sockets listed", () => {
  assert.equal(isRuntimeRouteDirectoryCell("user-abc_123"), true);
  assert.equal(isRuntimeRouteDirectoryCell("user-"), false);
  assert.equal(isRuntimeRouteDirectoryCell("user-a/b"), false);
  assert.equal(isRuntimeRouteDirectoryCell("cell-0"), true);
  assert.equal(runtimeRouteDirectoryEntryTtlMs("user-abc"), RUNTIME_ROUTE_DIRECTORY_OWNER_CELL_TTL_MS);
  assert.equal(runtimeRouteDirectoryEntryTtlMs("cell-v1-03"), RUNTIME_ROUTE_DIRECTORY_ENTRY_TTL_MS);
  assert.ok(RUNTIME_ROUTE_DIRECTORY_OWNER_CELL_TTL_MS > RUNTIME_ROUTE_DIRECTORY_ENTRY_TTL_MS);
});
