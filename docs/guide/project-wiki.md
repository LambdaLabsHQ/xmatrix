# Build a project wiki with Claude Code or Codex

Turn project notes into a living wiki with your own Claude Code or Codex agent in xMatrix. Create a project status page, check its decisions and open work, then update it from the same conversation when something changes.

For an open-source project, start with the next release: what is agreed, what blocks it and who owns the next step. You can try this with a few notes and a local folder before connecting GitHub or inviting anyone.

## Before you start

You need a computer with Claude Code or Codex installed and signed in, plus an xMatrix account. Agents use your existing tool account and run on your computer; keep it online while they work. The web app is where you talk and read Pages.

Follow [Install and Sign in](index.md#install) if you have not connected this computer yet. Open your Space in the [web app](https://xmatrix.sh/app).

## Give the agent a folder

For this first page, an empty folder is enough. These commands create one on macOS or Linux and add Codex to your Space:

```sh
mkdir -p ~/xmatrix/project-wiki
xmatrix spaces
xmatrix agent add codex --space <space-id> --workspace ~/xmatrix/project-wiki
```

Replace `<space-id>` with the id of the Space you opened. For Claude Code, replace `codex` with `claude`. On Windows, create a folder such as `C:\xmatrix\project-wiki` and use that path for `--workspace`.

Find the folder's full path with `realpath ~/xmatrix/project-wiki` on macOS or Linux, or `Resolve-Path C:\xmatrix\project-wiki` in PowerShell. Use that path in the message below, including the quotes. [Working with agents](agents.md) explains registration and supported tools.

## Ask for the first page

Create a conversation in your Space. Paste the message below, replacing the path and the example notes with your project's actual facts. Use `@claude` if you added Claude Code.

```text
@codex pwd:"/full/path/to/project-wiki" Create a page called Release status from these notes. Use sections for Goal, Decisions, Open work and Next steps. Keep unknown owners or dates marked unknown. Work from these notes and link the page here when it is ready.

Goal: Ship the next release with an installation guide people can follow.
Decided: Support macOS and Windows first. Linux support is still open.
Open work: Check the Windows instructions. The owner and release date are not decided.
Next: Ask a maintainer to try the instructions on a clean Windows machine.
```

The folder selects where the agent runs. Your notes supply the content; this task does not need repository access. Windows messages use the same `pwd:` syntax with your full Windows path.

Wait for the agent's reply and open its page link, or find **Release status** in **Pages**. Check that the page separates decisions from open questions and keeps missing owners and dates unknown. Correct anything it got wrong in the conversation.

If no agent replies, check `xmatrix status` and `xmatrix agent list --space <space-id>` on the computer. Confirm the agent is enabled and its coding tool is signed in. The conversation's invocation details show a failed start; [agent setup](agents.md) covers the next checks.

## Change a decision and see the page update

Reply to the instance that answered. For example, if it appeared as `codex:1`, send:

```text
@codex:1 Windows installation has now been checked. Update Release status: remove that open item and make the next step choosing a release date. Leave the date unknown until we agree on it.
```

Use the actual name and number from your conversation. Reopen the same page and verify the old open item is gone and the next step has changed. This is the useful result: one current page you can return to, instead of rereading the thread to reconstruct the plan.

## Use it for real project work

Bring in the next decision, issue summary or release note through the conversation and ask the agent to update the existing page. Give it access to your real project folder when it needs to inspect code. If you want it to read GitHub issues or pull requests, connect [GitHub](connectors.md#github) to the Space first and specify the repository in the task.

Keep each fact in one place. Add child pages when the project needs them, and link to them from Release status. [Pages and Automations](pages.md) explains the tree, concurrent edits and scheduled updates.

Pages stay private until a Space owner or admin chooses to publish one. Review its content and access before sharing it outside the team; creating this wiki does not publish it.
