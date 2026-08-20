# Cache retention summary

This page is the quick retention view. The binding key names, manifest validation, ownership, and
cleanup rules are in [redis-contract.md](redis-contract.md).

## Data publications on cache Redis

| State | Key pattern | TTL |
| --- | --- | ---: |
| Core active manifest | `llm:data:fpl:core:{season}:active` | none |
| Core active items | `llm:data:fpl:core:{season}:{revision}:*` | none |
| Live active manifest | `llm:data:fpl:live:{season}:{event}:active` | none |
| Live active items | `llm:data:fpl:live:{season}:{event}:{revision}:*` | none |
| Unactivated staging items | Same immutable item pattern | 15 minutes |
| Items from the replaced revision | Same immutable item pattern | 24 hours |

Core items are `events`, `teams`, `players`, `phases`, `fixtures`, and
`currentEventId`. Live items are `eventLives`, `fixtures`, `liveFixtures`, and `liveBonus`.

Reads do not extend TTL. Repeating the same publication ID is idempotent. An older competing
revision cannot replace the active pointer.

## Queue and coordination Redis

| Key family | Retention |
| --- | --- |
| `bull:{queue}:*` | BullMQ job/queue retention settings |
| `llm:fpl:admission:*` | Lease TTL is `FPL_ADMISSION_LEASE_MS`; expired leases are reclaimed atomically |
| `llm:queue:coordination:tournament-cascade:*` | 24 hours; refresh lease 120 seconds |
| `llm:queue:coordination:entry-info-sync:daily:*` | Through the next UTC midnight, minimum 60 seconds |
| `llm:queue:coordination:launch-notification:*` | Durable completion marker plus bounded delivery lease |

Queue/coordination keys must never be written with the cache client.

## Deliberately uncached in Data

- Understat facts;
- player market history and value changes;
- player season summaries;
- tournament selection and entry-event reporting.

GraphQL may cache resulting queries under revision-keyed `llm:gql:*`; those keys are not
owned by Data.

Operational removal must use bounded cursor-based `SCAN` plus exact-key `UNLINK`. Never use
`KEYS`, `FLUSHDB`, or `FLUSHALL`.
