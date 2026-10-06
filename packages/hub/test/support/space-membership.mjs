import assert from "node:assert/strict";

/** Enroll a member through both real invitation routes using the scenario's request parser and principals. */
export async function acceptSpaceMembership(worker, requestJson, owner, member, spaceId, role = "member") {
  const invited = await requestJson(worker, owner, `/api/spaces/${encodeURIComponent(spaceId)}/invites`, {
    method: "POST", body: JSON.stringify({ role }),
  });
  assert.equal(invited.response.status, 200, JSON.stringify(invited.payload));
  const accepted = await requestJson(worker, member,
    `/api/space-invites/${encodeURIComponent(invited.payload.invite.token)}/accept`, { method: "POST" });
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.payload));
}
