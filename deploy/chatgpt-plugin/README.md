# ChatGPT and Codex directory package

Build the portable Agent Plugins ZIP from the repository root:

```sh
python3 scripts/package-chatgpt-plugin.py /tmp/xmatrix-chatgpt-1.0.0.zip
```

The ZIP uses OpenAI's supported Codex compatibility format: a
`.codex-plugin/plugin.json` manifest and a root `.mcp.json`. This supports the
documented OpenAI OAuth configuration, which the portable MCP 1.0.0 public
schema currently rejects as an additional property.

The ZIP contains only the two manifests, the canonical product icon, and the
license. It has one remote Streamable HTTP MCP server, OAuth dynamic client
registration, listing metadata, and five positive and three negative review
cases. It contains no credentials, skills, app references, or hooks.

Use the **Plugins** page at <https://platform.openai.com/plugins> to upload it
under the verified MadeByRobot publishing identity. See the current official
[submission guide](https://developers.openai.com/plugins/deploy/submission)
and [package guide](https://developers.openai.com/plugins/build/plugins).

## Submission prerequisites

- An organization owner or member with Apps Management Write must complete
  individual or business verification and select the publishing organization
  and project. This repository's GitHub connection cannot do that.
- Connect and scan the MCP server in the portal. OAuth discovery supplies its
  endpoints; the package asks for reading, writing, and offline refresh access.
- Publish the portal's exact domain-verification token as plain text at the
  challenge URL it supplies, through a reviewed repository change and the
  production release workflow. The token is public, not a credential. Do not
  replace an existing challenge used by another plugin.
- Prepare a dedicated reviewer account with password login and an **App
  review** Space containing a Roadmap page and a **review** channel with sample
  content. Keep real customer data out of this account. Email codes, magic
  links, MFA approvals, and private-network access cannot be prerequisites
  for the reviewer. Enter credentials only in the portal's secure Review
  details form, never in the ZIP or a Channel.
- Run the five positive and three negative cases in `plugin.json` using that
  account and the ChatGPT client. Server tests verify the protocol and access
  boundaries, but do not establish model behavior or portal compatibility.
  The read-only negative case needs a separate read-only OAuth grant.
- Record those cases and provide an accessible video URL in Review details.
  The package deliberately omits a demo URL until a real recording exists.
- Inspect imported metadata, availability countries, reviewer details, and
  automated findings; submit the draft and complete policy attestations in
  the portal. Once approved, its publishing owner chooses when to publish.

## UI and privacy

`show_page` renders an MCP Apps page card. It re-reads the page using the same
authorization as `read_page`; its static resource has no private data, external
scripts, or network requests. Page text renders as text, not executable HTML.
The source button asks the host to open only the canonical xMatrix page URL.
Clients without MCP Apps still receive the current page as text and a link.

The live privacy policy describes outside AI applications, data sent to their
providers, consent, writes as the person, and the up-to-15-minute access-token
window after removal. See <https://xmatrix.sh/privacy#agents>.
