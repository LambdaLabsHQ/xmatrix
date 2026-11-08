# App Store website management

These capabilities require the saved Apple web session. They use the private
contracts implemented by fastlane's [Tunes client](https://github.com/fastlane/fastlane/blob/master/spaceship/lib/spaceship/connect_api/tunes/tunes.rb)
and [SandboxTester model](https://github.com/fastlane/fastlane/blob/master/spaceship/lib/spaceship/connect_api/models/sandbox_tester.rb).
Apple can change these endpoints independently of its public API.

## Version rating reset

Read `@appstoreconnect:rating_reset:<bundle id> <version>` to obtain the current
digest, then use `set_rating_reset:<bundle id> <version> on|off <digest>`.
The version must be editable and the snapshot unchanged. The connector sends
the change once and reads the result back. Scheduling a reset affects the
summary rating when that version is released; written reviews remain. This
action does not release a version. Inspect Apple before retrying an uncertain
result. Do not schedule resets as a connectivity test.

## New sandbox testers

Save the optional **Sandbox tester setup** credential in Apps → App Store
Connect → Credentials. Its private JSON contains `firstName`, `lastName`,
`email`, `password`, `secretQuestion`, `secretAnswer`, `birthDate` (YYYY-MM-DD)
and `appStoreTerritory` (Apple's three-letter territory identifier). Then invoke
`@appstoreconnect:create_sandbox_tester:<matching email>`, with no text body.
Passwords and security answers never belong in commands or Channel messages.

The Hub proves absence through a bounded complete tester list, creates once,
and checks the returned identity. An existing email leaves the tester and its
password unchanged. Private fields and provider error echoes are excluded
from results. A transport failure or unverified creation is uncertain; inspect
the tester list before retrying. Apple's role restrictions and password rules
still apply. This is a Sandbox account, not a production Apple ID.

Contract and failure-boundary tests cover these actions. Live account creation
needs an authorized Sandbox profile in Credentials; local tests do not prove
Apple accepted a new account. Review reply attachment upload and automatic
commerce review-state notifications remain separate work.
