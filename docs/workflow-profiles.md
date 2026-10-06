# Workflow Profiles

xMatrix issue work should be configured as data, not repeated prompt text.
The target user path is:

```text
@github:subscribe LambdaLabsHQ/xmatrix#151
@codex:new
```

The first message binds the channel or thread to a source issue. The second
message activates an agent against that bound work context. The human should
not have to repeat workspace, branch, test, PR, review, merge, or boundary rules
inside the mention text.

## Model

The source issue is the goal. Its current title, body, comments, labels, and
linked pull request state are the acceptance input.

Workflows are made of three layers:

- primitive: a machine-readable capability such as `issue.claim`,
  `branch.create`, `test.run`, or `pr.open`.
- role: a narrowed set of primitive capabilities, such as `coder`,
  `reviewer`, or `maintainer`.
- profile: a versioned configuration that maps source types to roles,
  capability sets, state rules, and enforcement mode.

`issue-dev/default` starts in `advisory` mode. It recommends the standard
issue development path while still allowing agents to explain deviations. The
same profile can run in `required` mode when the channel/thread config chooses
hard enforcement.

## Enforcement

- `free`: no profile constraint; the agent plans with broad runtime authority.
- `advisory`: profile recommends the path; deviations are allowed but should be
  visible in state/trace.
- `required`: profile structurally narrows executable capabilities. A role
  without `merge.perform` receives a daemon/runtime policy that marks
  `merge.perform` denied, regardless of channel text.

## Implementation Surface

The protocol package defines:

- `WorkflowPrimitiveDefinition`
- `WorkflowProfileDefinition`
- `WorkflowTaskContext`
- `WorkflowActivationContext`
- `WORKFLOW_PRIMITIVES`
- `ISSUE_DEV_DEFAULT_WORKFLOW_PROFILE`

The Hub now attaches a `workflowTaskContext` to GitHub issue subscribe/channel
metadata and includes a `workflowActivation` object when starting an agent from
a bound issue context. The spawn intent also carries a `workflowRuntimePolicy`;
the daemon consumes it at the launch boundary and exposes the allowed and denied
capability sets as runtime environment, so `required` mode is no longer only a
prompt convention.

Agent startup never pauses for a deferred workspace-selection flow. Ordinary
product summons require an explicit repo/workspace selection; bare `@agent:new`
is rejected. A workflow that requires repository contents must provide that
repo/workspace in the structured launch request.
