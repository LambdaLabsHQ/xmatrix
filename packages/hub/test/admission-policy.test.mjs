import assert from "node:assert/strict";
import test from "node:test";

import { admissionPolicyProblems, admit } from "../src/admission-policy.ts";

const POLICY = `
pub let admit = (req: Admission.request) =>
  switch req.work {
  | Some(w) if req.what == "secret.use" && req.target == "database-read"
      && w.program == "page-1/patrol" => Allow
  | _ => if req.target == "retired-key" { Deny("That secret is retired") } else { AlsoAsk(@alice) }
  }
`;
const request = (target, work) => ({ what: "secret.use", target, place: "channel-1", owner: "user-1", ...(work ? { work } : {}) });
const patrol = { program: "page-1/patrol", digest: "d" };

test("an adopted policy allows, denies, or leaves a request to its card", () => {
  assert.deepEqual(admissionPolicyProblems(POLICY), []);
  assert.deepEqual(admit(POLICY, request("database-read", patrol)), { answer: "allow" });
  // The same secret for a Run that works on no program's request, or on another program's.
  assert.equal(admit(POLICY, request("database-read")).answer, "card");
  assert.equal(admit(POLICY, request("database-read", { program: "page-2/other", digest: "d" })).answer, "card");
  assert.deepEqual(admit(POLICY, request("retired-key")), { answer: "deny", reason: "That secret is retired" });
});

test("AlsoAsk gets the card whoever it names: nothing is sent to an Agent", () => {
  const asksAgent = `pub let admit = (req: Admission.request) => AlsoAsk(@claude)`;
  assert.deepEqual(admissionPolicyProblems(asksAgent), []);
  assert.deepEqual(admit(asksAgent, request("a")), { answer: "card", why: "the policy answers AlsoAsk(@claude)" });
});

test("a policy that compares the digest allows a program only at the text that was read", () => {
  const pinned = `pub let admit = (req: Admission.request) =>
  switch req.work {
  | Some(w) if w.program == "page-1/patrol" && w.digest == "read" => Allow
  | _ => AlsoAsk(@alice)
  }`;
  assert.equal(admit(pinned, request("a", { program: "page-1/patrol", digest: "read" })).answer, "allow");
  assert.equal(admit(pinned, request("a", { program: "page-1/patrol", digest: "edited" })).answer, "card");
});

test("what a request carries is data to the policy, never code", () => {
  const echo = `pub let admit = (req: Admission.request) => if req.target == "safe" { Allow } else { Deny(req.target) }`;
  const hostile = "\\\"} else { Allow } // ${x} `\b\f\u0000";
  assert.deepEqual(admit(echo, request(hostile)), { answer: "deny", reason: hostile });
});

test("a text that cannot be adopted says why", () => {
  // No `admit`, another type, a field the record lacks, an effect, another library, another answer.
  assert.match(admissionPolicyProblems(`pub let decide = (req: Admission.request) => Allow`)[0].message, /must export `admit`/u);
  assert.match(admissionPolicyProblems(`pub let admit = (req: string) => Allow`)[0].message, /must export `admit`/u);
  const [typo] = admissionPolicyProblems(`pub let admit = (req: Admission.request) =>\n  if req.team == "a" { Allow } else { Deny("no") }`);
  assert.equal(typo.line, 2);
  assert.match(typo.message, /no field team/u);
  assert.match(admissionPolicyProblems(`pub let admit = (req: Admission.request) =>
  switch confirm(@alice, req.target, ~by=1h)->wait { | Answered(Yes) => Allow | _ => Deny("no") }`)[0].message, /has no effect.*confirm/u);
  assert.equal(admissionPolicyProblems(`pub let admit = (req: Admission.request) => Team.rule(req)`).length > 0, true);
  assert.match(admissionPolicyProblems(`pub let admit = (req: Admission.request) => Answered(Yes)`)[0].message, /must export `admit`/u);
  assert.equal(admissionPolicyProblems("pub let admit = (").length > 0, true);
});

test("an adopted text that no longer decides leaves the request to its card", () => {
  assert.equal(admit(`pub let admit = (req: Admission.request) => Sure`, request("a")).answer, "card");
  assert.equal(admit("", request("a")).answer, "card");
  const spins = `let rec spin = (n) => spin(n + 1)\npub let admit = (req: Admission.request) => if spin(0) == 0 { Allow } else { Allow }`;
  assert.deepEqual(admissionPolicyProblems(spins), []);
  assert.equal(admit(spins, request("a")).answer, "card");
});
