# Test value bar

Agents add tests for every small change, including tests that protect nothing.
A test earns its maintenance cost only when it protects observable behavior, a
credible regression, or an independently meaningful contract. This bar applies
when writing or changing a test and when auditing existing ones; it adapts
OpenClaw's
[test-audit skill](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md).

## Before adding a test

Answer all four; a missing answer means do not add it yet.

1. What observable behavior, invariant, or contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch that failure? Each contract has
   one owner test at its strongest boundary. Extend a table-driven case or
   shared fixture instead of adding a near-duplicate.
4. Does it need an export, flag, wrapper, or hook that no production caller
   needs? Then test at the real boundary instead.

A test that breaks under a behavior-preserving refactor asserts implementation,
not behavior. A bug regression test must fail on the pre-fix code for the
intended reason; one regression at the owner boundary covers the bug.

## Junk patterns

- source-text tests: `readFileSync`/`include_str!` of program source followed by
  regexes over identifiers, call shapes or "only one file does X";
  duplication belongs to `pnpm check:duplicates`, not a grep test;
- assertion-free coverage probes, self-comparisons, identity copies;
- copied fixtures, inventories, manifests, or export lists;
- the same contract asserted again at every layer it crosses;
- expected values produced by the helper under test, or mocks that implement
  the asserted behavior;
- tests whose only purpose is keeping a test-only export or wrapper alive;
- negative controls that pass for an unrelated reason.

## What stays

Keep a test that independently enforces a security, authorization, protocol,
wire-byte, migration, storage, release, or architecture boundary (the
[guardrails](guardrails/project-guardrails.md)), even when the cheapest guard
reads a file: release workflow YAML, Cargo.lock versions, the retired-singleton
check, the Channel-reader allowlist, webhook delivery proof, and connector
action policy ownership are examples. Static or slow is not a reason to delete.
A retained test that fails on the baseline is a product bug to repair, not a
test to remove.

## Auditing

Before removing a test, read it, its production owner, callers, and overlapping
tests, and name the stronger remaining proof. Delete the test-only seams it kept
alive in the same change. Land one coherent batch per pull request.
