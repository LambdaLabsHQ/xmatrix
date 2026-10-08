# Agent text encoding

xMatrix's Channel text is Unicode in the Hub/database. Agent commands transport
that text as UTF-8, with no local summary/title files.

## Windows launch policy

The daemon's Run wrapper, provider app-server/stream children, and headless PTY
children receive `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`, `LANG=C.UTF-8`, and
`LC_ALL=C.UTF-8`. Inherited/preset values cannot replace these transport settings.
They apply to child processes, not the machine locale or user shell profiles.

The Agent's PATH starts with xMatrix-managed `powershell.exe`/`pwsh.exe`
entrypoints for shells found on the original PATH. `XMATRIX_UTF8_SHELL` names the
preferred entrypoint; the user/vendor SHELL choice is preserved. Each command configures Console.InputEncoding, Console.OutputEncoding
and PowerShell's OutputEncoding to UTF-8 before executing the command. Commands
are passed using PowerShell's UTF-16LE EncodedCommand transport, preserving
Unicode arguments and shell syntax. No caller script is written to a file.
NoProfile does not bypass this setup. Native exit codes are returned to the
calling provider.

The entrypoints are exact links/copies of the running CLI in its managed config
directory; only two fixed names are retained. A new CLI replaces them atomically;
if an active command prevents replacement, launch fails with a retry instruction.
Real shell targets are resolved before PATH is changed and propagated explicitly,
so nested launches do not recursively invoke the entrypoints. No OS installation,
registry change, global profile edit, or system code-page migration is required.

This policy covers the default managed shell path. An explicit absolute path to
another shell, a provider's private bundled shell, or a command that deliberately
changes its own encoding is outside this entrypoint. Such PowerShell invocations
must configure all three encoding settings themselves; the bootstrap retains
that guidance. PowerShell File invocations preserve script scope/parameter
binding through the native script call. The stdin-script `-Command -` form is
refused; callers submit script text with `-Command` instead.

The CLI still rejects damaged text and non-UTF-8 input before publishing, because
setting a later process's code page cannot recover characters a previous process
already replaced.

## Verification

Regression tests exercise inherited non-UTF-8 overrides and case-insensitive
Windows variable names, Unicode/emoji command encoding, malformed encoded input,
and actual PowerShell 5.1/7 children with native Unicode arguments, UTF-8 pipelines,
and nonzero exit status. Binary integration tests execute the shipped CLI's alias
entrypoint, not a replacement fixture.
