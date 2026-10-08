# iOS App Store continuous delivery

Request iOS through the existing `production-release-intent.yml` workflow. The
release train still freezes `main`, validates the candidate, creates the immutable
tag, checks live compatibility, and invokes `ios-testflight.yml` in the protected
production environment. Public repositories always use an ephemeral GitHub-hosted
macOS runner, even if a stale self-hosted fleet variable remains. There is no new dispatch, PR-secret, unsigned-build, or
browser-session release path.

## Public and private data

- `apps/ios/app-store/metadata.json` contains only public listing copy, the public
  bundle identifier, and copyright. The schema rejects additional fields, including
  review credentials. Changes receive normal PR CI. The 1024px icon remains in the
  native asset catalog and travels with the build, not an independent upload.
- Existing production secrets `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID`, `ASC_P8_BASE64`
  and iOS signing secrets stay in the protected environment. The API key needs
  permission to manage the app's versions and review submissions, not just uploads.
  If Apple refuses access, correct its role through the account administrator;
  automation never widens permissions or falls back to an Apple ID password.
- Contact and demo-account fields stay at Apple. A new version inherits only the
  required review fields from an existing configured version. Existing fields are
  preserved. Configure the first version in App Store Connect before enabling use.
- Optional production secret `ASC_REVIEW_NOTES` replaces the review notes and adds
  the exact release version/build. Without it the existing private notes remain.
  Maintain current reviewer login/setup instructions and private evidence links
  there or at Apple; don't place them in the public metadata JSON.
- Screenshots, recordings, review attachments, and credentials are **not** uploaded
  from checkout or published as Actions artifacts. Review assets separately in
  App Store Connect. Use demonstration data; never upload internal workspaces or
  recordings containing personal account information without a reviewed basis.
- API JWTs last ten minutes, stay in memory, and go only to Apple's fixed HTTPS API
  origin. Redirects and foreign pagination links are refused. Neither requests nor
  Apple response/error bodies are printed. Safe receipts contain only version,
  build number, outcome and state. Temporary API key files are removed even after
  a failed step; the upload helper uses `API_PRIVATE_KEYS_DIR`, not `$HOME` storage.

## Version and retry behavior

The build number is the Production Release run ID. It is stable across attempts of
that run and unique across release runs. Before archiving, the workflow queries
Apple by app, iOS marketing version, and that build number. An existing exact build
is reused; expired/invalid or ambiguous builds stop the job. Otherwise the signed
binary is uploaded normally. No `latest build` lookup is used.

Submission waits up to 60 build-processing observations at 20-second intervals;
individual API calls time out at 30 seconds. Only read requests retry transient
429/5xx failures. Mutation failures stop without blindly replaying requests. A
retry reconciles Apple's version, build relationship, submission and items first.

The job updates only declared localizations, preserving other languages, screenshots,
pricing, territories, privacy declarations and release settings. It uses an editable
version or creates a new one; an existing higher editable version is never downgraded.
New versions use manual release after approval. Existing release settings are kept.
The exact build relationship is read back before submission. Apple must return a
waiting/in-review/completed submission receipt before `submitted` is reported.

Outcomes in the Actions job summary:

- `submitted`: Apple accepted the review submission. This is **not** approval or live
  App Store distribution.
- `already-submitted`: that exact version and build were already submitted or approved.
- `deferred-existing-review`: another review/release is in progress. The current build
  is available in TestFlight; no existing review is canceled or replaced.
- `deferred-review-response-required`: Apple has unresolved rejection issues. The build
  remains in TestFlight, and the editable draft receives the current public metadata
  and exact build (including its icon). Complete the requested evidence and response
  at Apple first;
  the script does not declare issues resolved or fabricate a reviewer demonstration.

Deferred outcomes do not turn a successful binary upload into a failed production
release. The next iOS release re-evaluates the app record and submits its own exact
build when possible. There is no hidden background queue that will later submit a
stale deferred binary. Operators must not describe a deferred result as submitted.

## Migration and recovery

This adds metadata/review operations after the existing upload and does not change
signing identity, bundle identifier, deployment authority or release gates. Existing
historical timestamp build numbers remain untouched; the run-ID convention applies
only to newly released versions. First rollout must inspect existing rejected or
in-flight submissions and confirm the private review contact, access instructions,
screenshots, evidence and policy declarations are current. Apple review requirements
are not waived by green CI.

On an uncertain mutation, inspect the private app record and rerun the **same** failed
Production Release job; do not create a new build to guess around it. Partial version
or localization writes are reconciled by their identifiers and locale on retry. A
published release's deferred result is addressed by a new regular iOS release after
the review blocker is resolved, not by bypassing version-order checks. If the API
contract changes, fix the script in a normal PR and release forward. Never cancel
someone else's review, clear audit evidence, change tags, or dump raw API bodies to
public logs while diagnosing.

Validation: `node --test scripts/ios-app-store.test.mjs` and
`node scripts/ios-app-store.mjs validate`. The tests use only generated signing keys
and synthetic Apple responses; they cannot access production secrets.

References: [Apple API](https://developer.apple.com/documentation/appstoreconnectapi),
[review submissions](https://developer.apple.com/documentation/appstoreconnectapi/review-submissions),
[submit an app](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app).
