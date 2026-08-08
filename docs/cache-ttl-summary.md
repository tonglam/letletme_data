# Cache retention summary

This page is the quick retention view. The binding key names, manifest validation, ownership, and
cleanup rules are in [redis-contract.md](redis-contract.md).

## Data publications on cache Redis

| State | Key pattern | TTL |
| --- | --- | ---: |
| Core active manifest | `llm:v3:data:fpl:core:{season}:active` | none |
| Core active items | `llm:v3:data:fpl:core:{season}:{revision}:*` | none |
| Live active manifest | `llm:v3:data:fpl:live:{season}:{event}:active` | none |
| Live active items | `llm:v3:data:fpl:live:{season}:{event}:{revision}:*` | none |
| Unactivated staging items | Same immutable item pattern | 15 minutes |
| Items from the replaced revision | Same immutable item pattern | 24 hours |

Core items are `events`, `teams`, `players`, `phases`, `fixtures`, and
`currentEventId`. Live items are `eventLives`, `fixtures`, `liveFixtures`,
`liveFixturesV2`, `liveBonus`, and `liveBonusV2`.

Reads do not extend TTL. Repeating the same publication ID is idempotent. An older competing
revision cannot replace the active pointer.

## Queue and coordination Redis

| Key family | Retention |
| --- | --- |
| `bull:{queue}:*` | BullMQ job/queue retention settings |
| `llm:v3:queue:coordination:mutation-lock:*` | Millisecond TTL from `MUTATION_LOCK_TTL_MS` |
| `llm:v3:queue:coordination:tournament-cascade:*` | 24 hours; refresh lease 120 seconds |
| `llm:v3:queue:coordination:entry-info-sync:daily:*` | Through the next UTC midnight, minimum 60 seconds |
| `llm:v3:queue:coordination:launch-notification:*` | Durable completion marker plus bounded delivery lease |

Queue/coordination keys must never be written with the cache client.

## Deliberately uncached in Data

- Understat facts;
- player market history and value changes;
- player season summaries;
- tournament selection and entry-event reporting.

GraphQL may cache resulting queries under revision-keyed `llm:v3:gql:*`; those keys are not
owned by Data.

## Legacy cleanup

Legacy keys have no normal rollover role. The approval-gated cleanup path inventories only
code-defined v2 patterns with cursor-based `SCAN`, records an exact key hash, enforces a maximum
count, and deletes through bounded `UNLINK` batches. Every `llm:v3:*` key and every unknown key
survives. Never use `KEYS`, `FLUSHDB`, or `FLUSHALL`.
