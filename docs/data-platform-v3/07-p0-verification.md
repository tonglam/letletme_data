# Data Platform v3 P0 Verification

Verified: 2026-08-08

Branch: `codex/data-platform-v3-baseline`

Baseline: `62f134aab250d1daeee423381689924a16d438b1`

## Deploy-lock design

V3 activation uses an external immutable release manifest generated only after the candidate Data
commit and container image digest are known. The canonical manifest bytes, SHA-256, exact Data
commit, exact image digest, run ID, and activation phrase are all checked before migration `0079`.
The manifest is intentionally not committed into the candidate commit and is not embedded in the
candidate image; doing either would make the Git SHA or image digest self-referential.

The production workflow behavior is:

- commits without `0079` retain the existing automatic/manual deployment behavior;
- a commit containing `0079` cannot deploy from `workflow_run`;
- v3 manual deployment requires a prebuilt lowercase GHCR reference pinned by digest;
- the gate blocks locked/invalid manifests and any SHA, image digest, run ID, manifest checksum, or
  activation-token mismatch;
- the local deploy helper applies the same digest-pinned-image and release-manifest gate.

## Verification evidence

| Check | Environment | Result |
| --- | --- | --- |
| Release-gate unit tests | Bun 1.3.3 container | 12 passed, 0 failed |
| Complete unit suite | Bun 1.3.3 container | 781 passed, 0 failed, 3,675 assertions |
| TypeScript typecheck | Bun 1.3.3 container | passed |
| ESLint | Bun 1.3.3 container | 0 errors; 7 pre-existing warnings |
| Production build | Bun 1.3.3 container | passed; both entrypoints bundled |
| GitHub Actions validation | `rhysd/actionlint` container | passed |
| Shell validation | `shellcheck` container + `bash -n` | passed |
| Compose model | `docker compose config --quiet` | passed |
| YAML parser | Ruby `YAML.load_file` | passed |
| Formatting/diff | Prettier + `git diff --check` | passed |
| Pre-0079 compatibility | `bun scripts/v3-release-gate.ts` | gate skipped as designed |

The B0 restore audit then extended the original relation-only inventory to include 22 public
sequences, 20 public enum types, and effective schema/relation/sequence/function/default ACLs. The
updated inventory SQL classifies all of them and the full/selective restore evidence compares
sequence values, schema definitions, and 1,571 ACL rows exactly.

Running the raw Bun binary command `bun test` also demonstrated that integration tests fail closed
without `RUN_INTEGRATION=1` and isolated test PostgreSQL/Redis. The accepted unit command is
`bun run test`; integration tests are executed later against the isolated migration environment,
never against production credentials.
