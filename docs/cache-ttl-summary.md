# Cache and retention summary

This is the quick operational view. The binding key names, validation rules,
ownership, and cleanup guardrails are in [redis-contract.md](redis-contract.md).

## Cache Redis (`CACHE_REDIS_*`)

| State | Key pattern | Retention |
| --- | --- | ---: |
| Core active manifest | `llm:data:fpl:core:{season}:active` | no expiry |
| Core active items | `llm:data:fpl:core:{season}:{revision}:*` | no expiry |
| Live active manifest | `llm:data:fpl:live:{season}:{event}:active` | no expiry |
| Live active items | `llm:data:fpl:live:{season}:{event}:{revision}:*` | no expiry |
| Unactivated publication staging | immutable item key | 15 minutes |
| Replaced publication items | immutable item key | 24 hours |

Core items are `events`, `teams`, `players`, `phases`, `fixtures`, and
`currentEventId`. Live items are `eventLives`, `fixtures`, `liveFixtures`, and
`liveBonus`. A pointer swap is atomic and revision-aware; reads do not extend
retention and a repeated publication ID is idempotent.

GraphQL owns its own bounded `llm:gql:*` query and security cache policy. Data
does not scan or delete those keys.

## Queue Redis (`QUEUE_REDIS_*`)

| Key family | Retention/lifecycle |
| --- | --- |
| `bull:{queue}:*` | completed: 24 hours/500; failed: 7 days/500 |
| `llm:fpl:admission:*` | lease TTL from `FPL_ADMISSION_LEASE_MS`; expired leases are atomically reclaimed |
| `llm:queue:coordination:tournament-cascade:*` | bounded 24-hour barrier; refresh lease 120 seconds |
| `llm:queue:coordination:entry-info-sync:daily:*` | through the next UTC midnight, with a minimum 60-second marker |
| `llm:queue:coordination:launch-notification:*` | durable completion marker plus bounded delivery lease |
| `ops:runtime-heartbeat:*` | short-lived heartbeat; stale values are unhealthy |
| `ops:scheduler-progress` | short-lived progress snapshot; stale values are unhealthy |

Queue/coordination keys must never be written with the cache client. The full
24-queue inventory is maintained in `src/queues/names.ts` and checked against
this documentation by the contract test.

## Deliberately uncached in Data

Understat facts, player market history/value changes, player season summaries,
and tournament selection/entry-event reporting remain PostgreSQL reads. Redis
loss may reduce performance, but cannot remove canonical business data.

Operational removal is always exact and bounded: resolve the intended namespace,
use cursor `SCAN`, enforce a maximum batch/count, and `UNLINK` only validated
keys. Never use `KEYS`, `FLUSHDB`, or `FLUSHALL`.
