import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { expandWorkflowAnchors } from "./workflow-source.mjs";

test("policy source expands shared runner selectors and steps without changing workflow meaning", () => {
  const source = `jobs:
  first:
    runs-on: &runner ubuntu-24.04
    steps:
      - &checkout
        uses: actions/checkout@v6
        with:
          ref: '\${{ inputs.ref }}'
      - &verify
        name: Verify checkout
        run: |
          test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"
  second:
    runs-on: *runner
    steps:
      - *checkout
      - *verify
`;
  const expanded = expandWorkflowAnchors(source);
  assert.deepEqual(parse(expanded), parse(source));
  assert.doesNotMatch(expanded, /[&*](?:runner|checkout|verify)/u);
  assert.equal(expanded.match(/test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"/gu).length, 2);
});

test("invalid workflow aliases fail closed", () => {
  assert.throws(() => expandWorkflowAnchors("jobs: *missing\n"), /Unknown workflow anchor/u);
});
