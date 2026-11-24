# Playwright's accessibility snapshot, vendored

These files are Playwright's own, copied from
[microsoft/playwright](https://github.com/microsoft/playwright) at tag
`v1.61.1` under the Apache License 2.0 (`LICENSE`, `NOTICE`):

| Here | Upstream |
| --- | --- |
| `injected/ariaSnapshot.ts` | `packages/injected/src/ariaSnapshot.ts` |
| `injected/roleUtils.ts` | `packages/injected/src/roleUtils.ts` |
| `injected/domUtils.ts` | `packages/injected/src/domUtils.ts` |
| `isomorphic/ariaSnapshot.ts` | `packages/isomorphic/ariaSnapshot.ts` |
| `isomorphic/stringUtils.ts` | `packages/isomorphic/stringUtils.ts` |
| `isomorphic/yaml.ts` | `packages/isomorphic/yaml.ts` |
| `isomorphic/cssTokenizer.ts` | `packages/isomorphic/cssTokenizer.ts` |

**The one change:** imports of `@isomorphic/<name>` (a path alias in
Playwright's build) are rewritten to `../isomorphic/<name>`. Nothing else is
edited; `test/page-snapshot.test.mjs` checks each file against its upstream
copy with that rewrite undone.

The extension uses them to give an Agent the page it reads (`xmatrix browse`)
as Playwright's `locator.ariaSnapshot()` writes it, in the side panel's
`../page-snapshot.ts`. Nothing at run time depends on Playwright: this copy is
ours. To move to a newer Playwright, copy the same files from its tag, apply
the import rewrite, update the tag and hashes in the test, and compare the
output with `node test/page-snapshot-parity.mjs <url>…`.
