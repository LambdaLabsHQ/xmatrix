import assert from "node:assert/strict";
import test from "node:test";
import { hostnameMetadata } from "../dist/hostname-metadata.js";

test("persisted hostname observations preserve exact Machine and execution evidence", () => {
  const source={machineId:"machine:exact",executionKey:"execution:exact",ownerUserId:"owner",hostId:"old",hostName:"observed",machineName:"Chosen"};
  assert.deepEqual(hostnameMetadata(source),{machineId:"machine:exact",executionKey:"execution:exact",ownerUserId:"owner",hostname:"observed",machineName:"Chosen"});
  assert.equal(source.hostId,"old","normalizing persistence never mutates caller input or its request digest");
  assert.deepEqual(hostnameMetadata({...source,hostname:"current"}),{machineId:"machine:exact",executionKey:"execution:exact",ownerUserId:"owner",hostname:"current",machineName:"Chosen"});
});
test("legacy observations never manufacture Machine or owner identity", () => {
  assert.deepEqual(hostnameMetadata({hostId:"cursor"}),{hostname:"cursor"});
  assert.deepEqual(hostnameMetadata({hostId:"cursor",hostname:null}),{hostname:null});
  assert.deepEqual(hostnameMetadata({}),{});
});
