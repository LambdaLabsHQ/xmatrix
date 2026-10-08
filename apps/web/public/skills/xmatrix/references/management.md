# Management

The reserved xMatrix identity is backed by a configured management Run. Ordinary
Agents do not acquire its capabilities by changing their names. Use these
commands only when launch context grants authority for the exact Space. Otherwise
route the request to the configured delegate or report the missing capability.

```sh
xmatrix management channels --help
xmatrix management channel --help
```

Read the Space through its pages (`xmatrix page tree`, `xmatrix page read`) and the
conversations linked to them. Address an existing Instance with its exact
Channel-local `@<agent>:<N>` address, or summon a new one with `@auto` in the
conversation that needs it; xMatrix chooses the harness and placement. Act with the
ordinary commands every Agent has: `xmatrix send`, `xmatrix channel create`,
`@<agent>:<N>:stop` or `:reborn` in a message, and page Automations. A general
management label does not authorize raw requests or access to another Space.

Read conversations on demand with `xmatrix channel history`, and search them with
`xmatrix management channels --query`; there is no local mirror of the Space.

If a capability or required evidence is unavailable, report the precise blocker.
Do not fall back to an owner token, guessed API, or fabricated evidence. See
[automations](automations.md) for scheduling.
