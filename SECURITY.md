# Security

Report a vulnerability through GitHub private vulnerability reporting on this repository. Do not open a public issue or a pull request for it.

We acknowledge a report within 3 business days and send a status or a fix plan within 10 business days. Those clocks start when the report reaches the maintainers. There is no bug bounty.

In scope: hub authentication and device login, channel and page access control, Space secrets, the daemon credential helper, and release artifacts. Out of scope: a vulnerability in a third-party coding harness, or a missing hardening that the product already documents as the owner's own machine and user account.

## Trust model

xMatrix is a hosted multi-user collaboration Hub paired with a local daemon on your own machines. Traffic uses HTTPS/TLS and Hub storage is encrypted at rest, with additional authenticated encryption for Saved Secrets and daemon local replicas. Channels, Pages, and attachments are **not end-to-end encrypted**, because the Hub processes readable collaboration content for multi-user sync, search, Agent routing, collaborative Pages, and automations. Source code, git history, SSH keys, and local provider credentials stay on your machine unless explicitly shared, and connecting a machine requires explicit approval by the signed-in owner. See `docs/guide/privacy.md` (`/docs/privacy`) and `/privacy` for the full privacy and data-handling boundary.
