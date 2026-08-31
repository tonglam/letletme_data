# Cache and retention summary

This is the quick operational view. The binding key names, validation rules,
ownership, and cleanup guardrails are in [redis-contract.md](redis-contract.md).

## Cache Redis (`CACHE_REDIS_*`)

| State | Key pattern | Retention |
| --- | --- | ---: |
| Core active manifest | `llm:data:fpl:core:{season}:active` | no expiry |
| Core active items | `llm:data:fpl:core:{season}:{revision}:*` | no expiry |
| Live V2 current manifest | `llm:data:v2:fpl:live:{season}:{event}:active` | event validity + 48h after final |
| Live V2 previous manifest | `llm:data:v2:fpl:live:{season}:{event}:previous` | 24 hours |
| Live V2 immutable items | `llm:data:v2:fpl:live:{season}:{event}:{generation}:*` | active lifetime; 24h after replacement |
| Entry Live V2 current manifest | `llm:data:v2:fpl:entry-live:{season}:{event}:{entry}:active` | event validity + 48h after final |
| Entry Live V2 previous manifest | `llm:data:v2:fpl:entry-live:{season}:{event}:{entry}:previous` | 24 hours |
| Entry Live V2 immutable input | `llm:data:v2:fpl:entry-live:{season}:{event}:{entry}:{generation}:*` | active lifetime; 24h after replacement |
| Live Matches V2 active-event pointer | `llm:data:v2:fpl:live-match:{season}:active-event` | active season control pointer |
| Live Matches V2 desk current/active items | `llm:data:v2:fpl:live-match:desk:{season}:{event}:...` | no expiry until final; 48h after final |
| Live Matches V2 desk previous | `llm:data:v2:fpl:live-match:desk:{season}:{event}:previous` | 24 hours |
| Live Matches V2 detail current/manifest/items | `llm:data:v2:fpl:live-match:detail:{season}:{event}:...` | no expiry until final; 48h after final |
| Live Matches V2 detail previous/items | `llm:data:v2:fpl:live-match:detail:{season}:{event}:previous` and immutable items | 24 hours |
| Live Matches V2 checkpoint desired/watermark | `llm:data:v2:fpl:live-match:checkpoint:{season}:{event}:{kind}*` | desired: 24h; watermark: 48h |
| Unactivated publication staging | immutable item key | 15 minutes |
| Replaced publication items | immutable item key | 24 hours |

Core items are `events`, `teams`, `players`, `phases`, `fixtures`, and
`currentEventId`. Live V2 global items are `eventLive` and `fixtures`; entry
items are the complete `input` envelope. A pointer swap is atomic and
generation-aware; readers validate the manifest, item type, bytes, count, and
SHA-256 before serving it. Reads do not extend retention and a repeated
publication ID is idempotent. PostgreSQL is an asynchronous complete
checkpoint/cold fallback, not a heartbeat write path.

Live Matches V2 has one external root but two internal publications: compact
desk and fixture-grain detail. Detail may lag desk but may never lead its desk
generation or cross fixture identity. The detail item hash is part of its key,
so unchanged fixture detail is reused instead of rewritten.

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
