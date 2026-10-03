# roborev for Pi

Bring background review findings into an active Pi session. This package sends
shell-tool and settlement events through `roborev agent-hook run --agent pi`.
The regular roborev daemon owns reminder thresholds, session counters, review
acknowledgements, snoozes, and fix-session ownership.

## Install from Git

Use Pi 0.99.2 or later and a roborev CLI that supports the `pi` hook profile.
Start your regular roborev daemon before using the extension. Installing this
package does not install or start roborev.

Install Bun and merge this setting into `~/.pi/agent/settings.json` before
installing the Git package:

```json
{
  "npmCommand": ["bun"]
}
```

This repository uses Bun workspaces. Pi's default npm installer rejects the
existing `workspace:*` dependency. Pi 0.99.2 supports Bun through
`npmCommand`; this setting applies to all Pi package installations.

Then install:

```sh
pi install git:github.com/kenn-io/roborev
```

Restart Pi or run `/reload`. Add `--local` to install for one project instead of
your user configuration.

Pi clones the repository and reads its root `package.json`. That manifest
exposes this workspace's extension and the existing `roborev-fix` CLI skill.
Pi does not support a workspace subdirectory suffix in a Git source. The
workspace manifest also supports local extension loading, but the shared skill
is exposed by the repository-root manifest.

To pin a version, append `@<tag-or-commit>` to the repository source. Choose a
revision containing both the root manifest and this package. Install an
unversioned source to follow the repository's default branch.

```sh
pi update git:github.com/kenn-io/roborev
pi remove git:github.com/kenn-io/roborev
```

An update does not advance a configured tag or commit. Remove the pinned source
and install the new revision to change the pin.

See the official [Pi package documentation][packages] for Git sources, resource
manifests, filtering, and project trust. Installation and event contracts were
checked against Pi 0.99.2.

## Runtime behavior

- `tool_call` reports `bash` as `PreToolUse` with the normalized tool name
  `Bash`.
- `tool_result` reports `bash` as `PostToolUse`, including failed results.
  A reminder is appended to the tool result without replacing its output,
  structured data, or error status. Nested shell calls are included.
- `agent_before_settle` reports a completed activity as `Stop`. A reminder
  becomes a custom message and requests one continuation with
  `continue: true`. Aborted runs, errors, and already-queued continuations do
  not count as Stops.
- A continuation caused by a Stop reminder sets `stop_hook_active` on its
  next Stop event. The daemon skips this recursive event, just as it does for
  external hook profiles.

Pi 0.99.2 does not supply an abort signal at final settlement. Cancelling there
prevents the continuation, but an in-flight daemon request may wait for the
CLI's existing 5-second HTTP timeout. A reminder recorded before cancellation
may already be acknowledged; hook delivery remains at most once.

The session ID comes from Pi's session manager on every event. Resuming a
session or reloading the extension keeps its daemon counters. A fork has its own
session ID. The extension stores no counters or review acknowledgement state.

Only Pi's `bash` tool is observed. User-entered `!` commands and PowerShell
tools are not included.

The extension invokes `roborev` from `PATH`, so version-manager shims work.
Set `ROBOREV_PI_BINARY` to an executable path to select another binary. It is a
path, not a shell command. No shell wrapper or Claude-compatible bridge is used.

Thresholds, instructions, fix guidelines, daemon address overrides, and
`ROBOREV_DATA_DIR` retain their existing roborev behavior. Read the
[Agent Hook documentation][hooks] for configuration and inspection commands.

A missing CLI, invalid configuration, malformed response, or unavailable daemon
produces a diagnostic and allows Pi to continue normally. Errors go to stderr
and also show a warning when Pi provides a UI. The extension does not enqueue
reviews, edit files, or start or restart the daemon. Reminder
instructions may ask the active agent to evaluate findings and make in-scope
fixes.

`roborev agent-hook install` still manages the nine external hook integrations.
It does not install this package. Keep the extension, the CLI, and the daemon
compatible when upgrading.

## Develop locally

From the repository root:

```sh
bun install
bun run pi:check
bun run pi:test
pi -e .
```

The tests load the repository manifest through Pi's real package loader. They
build roborev into a temporary directory and use an isolated HTTP fixture. They
never install a development binary into `PATH` or contact your live daemon.

[packages]: https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/packages.md
[hooks]: https://roborev.io/docs/agent-hook/
