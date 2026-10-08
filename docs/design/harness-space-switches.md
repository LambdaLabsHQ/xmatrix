# Installed harnesses and Space switches

Machines report their installed harness inventory. Web derives `(machine,
harness)` candidates from that observation; listing does not write registrations.
Only the machine owner sees controls for their installed candidates. Inventory
is presentation evidence, not launch authorization.

An installed harness starts off in a Space until its owner enables it. The
Machines table and Agents list offer the same Space switch. First enable uses
the existing idempotent registration `create` command, preserving existing
machine declarations and Space configuration. Registrations remain durable
authorization and execution revision records. Later toggles read current
revisions and use existing Space policy commands. Turning off disables only
this Space and stops its running work there. Enabling a legacy disabled machine
environment also restores that owner environment switch.

The first-run card offers **Bring them in** to enable all detected installed
pairs on the viewer's machines, sequentially, stopping on the first failure.
It reports errors and keeps successful changes; retry continues with pairs
still off. Desktop discovery is a fallback before daemon inventory arrives.
No working folder is selected by this step.

A successful install requested from Machines enables a previously unconfigured
harness in the Space being viewed. Updates, failed installs, restored action
history, and previously disabled or removed registrations do not enable it.
The page must remain open to observe and apply this installation follow-up;
failures are displayed and the owner can retry with the switch.

Existing enabled, disabled, and revoked registrations are retained without a
data rewrite. The UI derives their positions from current grant, policy, and
environment states. Names, grants, revisions, and running work retain existing
contracts, so no data migration is necessary.

Hub evaluates machine ownership, Space membership, creation policy, current
grants, and revisions for every command and launch. Candidates cannot bypass
these checks. A failed catalog read cannot be treated as an empty Space.
