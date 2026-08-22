# Content worker Grok operations

> Target runtime contract. The current branch has not yet been merged or deployed.

The content worker uses the pinned `@xai-official/grok@1.0.5` binary from the runtime image. The
image installs Node.js for the CLI shebang and its build stage runs `grok inspect --json`; startup
also verifies the expected version and fails closed on drift. No alternate executable override is
supported.

Grok Build strict sandboxing uses nested bubblewrap namespaces and does not run in an ordinary
unprivileged Docker container. Granting `--privileged` only to make nested bubblewrap work is not an
acceptable production trade-off. The target container therefore uses:

- non-root UID/GID 1001, a read-only root filesystem, and a private `noexec,nosuid,nodev` `/tmp`;
- all Linux capabilities dropped and `no-new-privileges` enabled;
- a dedicated writable `grok-home` volume containing only Grok state;
- `--sandbox none` inside that outer container boundary;
- a version-pinned `--disallowed-tools` list, `--no-subagents`, and explicit denies for command,
  file, web, planning, media, and MCP tools;
- a startup-event gate that rejects any advertised tool outside the four residual command-control
  tools expected from Grok Build 1.0.5;
- a sanitized child-process environment that does not inherit database, Redis, Supabase, provider,
  or application secrets;
- an exact-request/single-X-tool trace gate and strict whole-result JSON validation.

The residual command-control tools are unusable under the deny rules; every accepted acquisition
trace must still prove exactly one expected X tool call. This is container isolation plus a pinned
tool-surface contract, not Grok `--sandbox strict`, and must not be described as the latter.

On 2026-08-22, two adversarial Grok Build 1.0.5 probes used the same flags. A requested
`run_terminal_command` was rejected by the Bash deny rule, and a requested `spawn_subagent` was
rejected by the permission policy. Tool-use attempts still appear in the trace and therefore also
fail the acquisition single-tool gate. These probes validate the pinned 1.0.5 contract; version or
tool-inventory drift remains fail closed.

An X budget reservation is released only when failure occurs before the real `grok -p` process is
started. Timeout, malformed output, invalid trace, or any later failure conservatively commits one
call unit even when no attested provider trace can be stored. Such a run is `FAILED`, has
`traceVerified=false`, and never advances its checkpoint or produces a Receipt.

Content flags remain disabled until a separately approved rollout:

```text
CONTENT_PIPELINE_ENABLED=false
CONTENT_X_SCAN_ENABLED=false
CONTENT_REAL_GROK_ENABLED=false
CONTENT_PUBLICATION_ENABLED=false
BRIEFING_PUBLIC_ENABLED=false
```

The VPS Grok authentication already exists. Do not reinstall, export, or print it. Before enabling
real acquisition, validate it from the deployed worker image as UID 1001:

```sh
docker compose run --rm --user 1001 content-worker /app/node_modules/.bin/grok inspect --json
```

The `grok-home` volume is mounted at `/home/appuser/.grok` and is writable only by UID/GID 1001. If
device credentials expire, acquisition remains failed closed; an attended device-auth login may be
repeated only as an explicit operational recovery action.
