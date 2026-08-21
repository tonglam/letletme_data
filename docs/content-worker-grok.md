# Content worker Grok operations

The content worker uses the pinned `@xai-official/grok@1.0.5` binary from the
runtime image. No alternate executable override is supported; the worker
verifies the tracked skill SHA before every real run and fails closed on a
mismatch.

Content flags remain disabled until a separately approved rollout:

```text
CONTENT_PIPELINE_ENABLED=false
CONTENT_REAL_GROK_ENABLED=false
CONTENT_PUBLICATION_ENABLED=false
BRIEFING_PUBLIC_ENABLED=false
```

When a real shadow run is explicitly authorized, sign in once on the VPS as
the worker UID. The command is interactive and must not run in CI:

```sh
docker compose run --rm --user 1001 content-worker grok login --device-auth
docker compose run --rm --user 1001 content-worker grok inspect --json
```

The `grok-home` volume is mounted at `/home/appuser/.grok` and is writable only
by UID/GID 1001. Do not copy the volume, print its contents, export its token,
or run `grok -p` against X without a separate operator authorization. If device
credentials expire, the worker remains failed closed until an operator repeats
the device-auth login.
