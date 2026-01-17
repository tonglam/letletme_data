# League Jobs Architecture Review

## Overview

League Jobs handle syncing picks and results for potentially **thousands of entries** across multiple tournaments/leagues within a tight time window.

---

## Current Architecture

### Jobs

**1. league-event-picks-sync**
- **Schedule:** Every 5 minutes (`*/5 * * * *`)
- **Condition:** Select time (before matches start)
- **Purpose:** Fetch and store entry picks for all league participants

**2. league-event-results-sync**
- **Schedule:** 3x daily (`0 8,10,12 * * *`) at 8 AM, 10 AM, 12 PM
- **Condition:** After match day
- **Purpose:** Calculate and store league standings with detailed stats

---

## Data Flow

### League Event Picks

```
Cron (every 5 min)
  ↓
Get active tournaments
  ↓
For each tournament:
  → Resolve entry IDs (from storage or fetch from FPL API)
  → Check which entries already synced
  ↓
Concurrent sync (concurrency: 5)
  → For each missing entry:
    → Fetch picks from FPL API
    → Transform & save to DB
```

### League Event Results

```
Cron (3x daily)
  ↓
Get active tournaments
  ↓
Resolve all entry IDs
  ↓
Load required data:
  → Entry infos
  → Event lives (player performance)
  → Entry event results (if available)
  ↓
For missing results:
  → Fetch picks from FPL API (concurrency: 5)
  ↓
Calculate league results:
  → Captain stats, bench points, highest scorer
  → Overall/event points and ranks
  ↓
Batch upsert to DB (batch size: 500)
```

---

## Scale & Performance Analysis

### Current Implementation

#### Concurrency Control
```typescript
const DEFAULT_CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<R>,
): Promise<R[]>
```

**Custom concurrent mapper:**
- Uses worker pool pattern
- Processes up to 5 entries in parallel
- Sequential iteration with controlled parallelism

---

### Scalability Issues

#### 🔴 Issue 1: Single Long-Running Sync

**Picks Sync:**
```typescript
// If 1,000 entries need syncing:
// Time = (1,000 entries / 5 concurrency) × ~200ms per API call
// = 40,000ms = 40 seconds minimum

// If 5,000 entries:
// = 200 seconds = 3.3 minutes
```

**Problem:**
- All work in a single cron execution
- No progress tracking
- Failure = start over
- Blocks worker for entire duration

---

#### 🔴 Issue 2: No Deduplication

```typescript
// Cron: */5 * * * * (every 5 minutes)

// If sync takes 6 minutes:
00:00 - Sync starts (1,000 entries)
00:05 - Cron triggers again → New sync starts!
00:06 - First sync completes
00:10 - Cron triggers again → Another sync starts!
```

**Problem:**
- Multiple syncs can run concurrently
- Duplicate FPL API calls
- Database race conditions
- Wasted resources

---

#### 🔴 Issue 3: Fixed Schedule Misses Window

**Picks Sync:**
- Runs every 5 minutes during select time
- Select time = before first match (e.g., 11:00 AM - 1:30 PM)
- **Good:** Frequent enough for deadline rushes

**Results Sync:**
- Runs 3x daily: 8 AM, 10 AM, 12 PM
- **Problem:** If matches end at 10:30 PM, waits until next day 8 AM
- **Impact:** League standings stale for 9+ hours

---

#### 🔴 Issue 4: No Retry on Partial Failure

```typescript
const results = await mapWithConcurrency(entriesToSync, concurrency, async (entryId) => {
  try {
    await syncEntryEventPicks(entryId, eventId);
    return { entryId, success: true };
  } catch (error) {
    logError('Failed to sync league entry picks', error, { eventId, entryId });
    return { entryId, success: false }; // ❌ Logged but not retried
  }
});
```

**Problem:**
- Failed entries logged but not retried
- Next sync will try again (5 min or next day)
- No exponential backoff for transient failures

---

#### 🔴 Issue 5: All-or-Nothing Results Sync

**Results sync is complex:**
1. Fetch all tournament entries (potentially 1,000s)
2. Load entry infos (DB)
3. Load event lives (DB) - ~600 players
4. Load entry results (DB)
5. Fetch missing picks (FPL API) - potentially hundreds
6. Calculate stats for all entries
7. Batch upsert (500 per batch)

**Problem:**
- If step 3 fails (no event lives), entire sync fails
- No partial completion
- All work wasted

---

#### ⚠️ Issue 6: Hardcoded Concurrency

```typescript
const DEFAULT_CONCURRENCY = 5;
const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
```

**Limitations:**
- 5 concurrent requests may be too conservative
- No rate limiting (could hit FPL API limits)
- Not configurable per tournament size

**Considerations:**
- Small leagues (50 entries): 5 concurrency fine (10 seconds)
- Large leagues (5,000 entries): 5 concurrency slow (16 minutes)
- Multiple large leagues: Very slow

---

## Specific Challenges

### Challenge 1: Many Entries

**Scenario:**
- Tournament 1: 2,000 entries
- Tournament 2: 1,500 entries
- Tournament 3: 500 entries
- **Total: 4,000 unique entries**

**Current picks sync:**
```
4,000 entries / 5 concurrency × 200ms = 160 seconds = 2.7 minutes
```

**Current results sync:**
```
- Fetch missing picks: ~80 seconds (if 50% missing)
- Process all results: ~10 seconds
- Batch upsert: ~20 seconds
Total: ~110 seconds = 1.8 minutes
```

**Acceptable? Depends on:**
- Window size (select time might be 2 hours)
- API rate limits
- Failure rates

---

### Challenge 2: Time Window

**Picks Sync Window (Select Time):**
```
Example:
- First match: 1:30 PM Saturday
- Select time starts: ~11:00 AM (2.5 hours before)
- Sync every 5 minutes = 30 sync opportunities
```

**Good:** Many chances to sync before deadline

**Results Sync Window (After Match Day):**
```
- Last match ends: 10:00 PM Sunday
- Next sync: 8:00 AM Monday (10 hours later!)
- Only 3 sync opportunities per day
```

**Bad:** Long delay, infrequent retries

---

### Challenge 3: Deduplication Needed

**Current:**
- No job deduplication
- Multiple crons can trigger overlapping syncs

**Example:**
```
00:00 - Cron triggers picks sync (4,000 entries, takes 3 minutes)
00:05 - Cron triggers again while first sync still running
       - Fetches same tournament entries
       - Checks DB for already-synced entries
       - Most are now synced by first run
       - Wastes API calls checking
```

---

## Comparison with Entry Sync & Live Sync

### Entry Sync (Already BullMQ)

```typescript
// src/queues/entry-sync.queue.ts
// Handles: entry-info, entry-picks, entry-transfers, entry-results

Features:
- ✅ BullMQ background jobs
- ✅ Deduplication via jobId
- ✅ Automatic retry (3x exponential backoff)
- ✅ Chunking (process in batches)
- ✅ Configurable concurrency/throttling
```

### Live Sync (Now BullMQ)

```typescript
// src/queues/live-data.queue.ts
// Handles: event-lives-cache, event-lives-db, summary, explain, overall

Features:
- ✅ BullMQ background jobs
- ✅ Cascade execution
- ✅ Automatic retry
- ✅ Deduplication
- ✅ Job tracking with IDs
```

### League Sync (Still Direct Execution)

```typescript
// src/jobs/league-event-picks.jobs.ts
// src/jobs/league-event-results.jobs.ts

Current state:
- ❌ Direct cron execution
- ❌ No deduplication
- ❌ No automatic retry (per-entry errors logged only)
- ✅ Has concurrency control
- ❌ No chunking
- ❌ No progress tracking
```

**Inconsistency:** All other multi-entry jobs use BullMQ, but league jobs don't

---

## Recommended Architecture: BullMQ Background Jobs

### Proposed Queue Structure

```typescript
// src/queues/league-sync.queue.ts

export const LEAGUE_JOBS = {
  LEAGUE_EVENT_PICKS: 'league-event-picks',
  LEAGUE_EVENT_RESULTS: 'league-event-results',
} as const;

export type LeagueSyncJobName = (typeof LEAGUE_JOBS)[keyof typeof LEAGUE_JOBS];

export interface LeagueSyncJobData {
  eventId: number;
  tournamentId?: number; // Optional: sync specific tournament
  chunkOffset?: number;  // For chunked processing
  chunkSize?: number;
  source: 'cron' | 'manual' | 'cascade';
  triggeredAt: string;
}

export const leagueSyncQueue = new Queue<LeagueSyncJobData>('league-sync', {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60_000, // 1 minute
    },
    removeOnComplete: {
      age: 86400, // 24 hours
      count: 100,
    },
    removeOnFail: {
      age: 172800, // 48 hours
      count: 50,
    },
  },
});
```

---

### Proposed Worker Implementation

**Option A: Per-Tournament Jobs (Recommended)**

```typescript
// Worker processes one tournament at a time

async function processLeagueEventPicksJob(job: Job<LeagueSyncJobData>) {
  const { eventId, tournamentId } = job.data;

  if (!tournamentId) {
    // Coordinator job: enqueue one job per tournament
    const tournaments = await tournamentInfoRepository.findActive();
    for (const tournament of tournaments) {
      await leagueSyncQueue.add(
        LEAGUE_JOBS.LEAGUE_EVENT_PICKS,
        {
          eventId,
          tournamentId: tournament.id,
          source: 'cascade',
          triggeredAt: new Date().toISOString(),
        },
        {
          jobId: `picks:${eventId}:${tournament.id}`,
        },
      );
    }
    return { enqueued: tournaments.length };
  }

  // Process specific tournament
  const tournament = await tournamentInfoRepository.findById(tournamentId);
  if (!tournament) {
    throw new Error(`Tournament ${tournamentId} not found`);
  }

  const entryIds = await resolveTournamentEntries(tournament);
  const existingEntryIds = await entryEventPicksRepository.findEntryIdsByEvent(
    eventId,
    entryIds,
  );
  const entriesToSync = entryIds.filter((id) => !existingEntryIds.has(id));

  // Sync entries with concurrency control
  const results = await mapWithConcurrency(entriesToSync, 5, async (entryId) => {
    try {
      await syncEntryEventPicks(entryId, eventId);
      return { entryId, success: true };
    } catch (error) {
      logError('Failed to sync entry picks', error, { eventId, entryId, tournamentId });
      throw error; // Let BullMQ retry
    }
  });

  return { tournamentId, synced: results.filter((r) => r.success).length };
}
```

**Benefits:**
- ✅ Each tournament is a separate job
- ✅ Tournaments process in parallel (up to worker concurrency)
- ✅ Failure in one tournament doesn't block others
- ✅ Can retry per-tournament
- ✅ Progress tracking per tournament
- ✅ Deduplication via jobId

---

**Option B: Chunked Entry Jobs**

```typescript
// Worker processes a chunk of entries at a time

async function processLeagueEventPicksJob(job: Job<LeagueSyncJobData>) {
  const { eventId, chunkOffset = 0, chunkSize = 100 } = job.data;

  // Get all entries across all tournaments
  const tournaments = await tournamentInfoRepository.findActive();
  const allEntryIds = /* ... resolve all entries ... */;

  const entriesToSync = /* ... filter already synced ... */;

  if (chunkOffset === 0) {
    // First chunk: enqueue all other chunks
    const totalChunks = Math.ceil(entriesToSync.length / chunkSize);
    for (let i = 1; i < totalChunks; i++) {
      await leagueSyncQueue.add(
        LEAGUE_JOBS.LEAGUE_EVENT_PICKS,
        {
          eventId,
          chunkOffset: i * chunkSize,
          chunkSize,
          source: 'cascade',
          triggeredAt: new Date().toISOString(),
        },
        {
          jobId: `picks:${eventId}:chunk:${i}`,
        },
      );
    }
  }

  // Process this chunk
  const chunk = entriesToSync.slice(chunkOffset, chunkOffset + chunkSize);
  const results = await mapWithConcurrency(chunk, 5, syncEntryEventPicks);

  return { chunkOffset, processed: chunk.length };
}
```

**Benefits:**
- ✅ Finer-grained progress tracking
- ✅ Smaller job units (easier to retry)
- ✅ Better concurrency (more chunks = more parallel jobs)
- ⚠️ More complex coordination
- ⚠️ Harder to track overall progress

---

### Recommendation: **Option A (Per-Tournament Jobs)**

**Reasons:**
1. **Natural boundaries:** Tournaments are logical units
2. **Simpler:** Less coordination complexity
3. **Better failure isolation:** One tournament failure doesn't affect others
4. **Easier tracking:** Progress per tournament
5. **Consistent with domain model:** Tournaments are entities

---

### Proposed Cron Changes

**Before:**
```typescript
// Direct execution every 5 minutes
cron({
  name: 'league-event-picks-sync',
  pattern: '*/5 * * * *',
  async run() {
    await runLeagueEventPicksSync(); // Direct execution
  },
});
```

**After:**
```typescript
// Enqueue coordinator job
cron({
  name: 'league-event-picks-trigger',
  pattern: '*/5 * * * *',
  async run() {
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) return;

    await enqueueLeagueEventPicks(currentEvent.id, 'cron');
    // Coordinator job will fan out to per-tournament jobs
  },
});
```

---

### Proposed Scheduling Changes

**Picks Sync:**
- **Keep:** Every 5 minutes during select time
- **Add:** Deduplication via jobId
- **Add:** Per-tournament parallelization

**Results Sync:**
- **Before:** 3x daily (8, 10, 12)
- **After:** Every 10 minutes after match day (aligned with live-events-db-sync)
- **Benefit:** Faster updates (10 min vs 2-12 hours)

**Alignment with Live Sync:**
```
event-lives-db-sync completes
  ↓
Cascade: enqueue league-event-results
  ↓
Use fresh event_lives data for calculations
```

---

## Implementation Plan

### Phase 1: Create Infrastructure

**Files to create:**
- `src/queues/league-sync.queue.ts`
- `src/jobs/league-sync.jobs.ts` (enqueue helpers)
- `src/workers/league-sync.worker.ts`
- `tests/integration/league-sync-jobs.test.ts`

---

### Phase 2: Modify Services

**`src/services/league-event-picks.service.ts`:**
- Add `syncLeagueEventPicksByTournament(tournamentId, eventId)`
- Keep existing `syncLeagueEventPicks` for backward compat

**`src/services/league-event-results.service.ts`:**
- Add `syncLeagueEventResultsByTournament(tournamentId, eventId)`
- Keep existing `syncLeagueEventResults` for backward compat

---

### Phase 3: Update Cron Jobs

**`src/jobs/league-event-picks.jobs.ts`:**
- Change to enqueue coordinator job
- Remove direct execution

**`src/jobs/league-event-results.jobs.ts`:**
- Change to enqueue coordinator job
- Update schedule to align with live-events-db-sync

---

### Phase 4: Update API

**`src/api/jobs.api.ts`:**
- Return job IDs instead of immediate results
- Add manual trigger endpoints

---

### Phase 5: Register Worker

**`src/worker.ts`:**
- Import and initialize league sync worker
- Add to shutdown handler

---

## Benefits of BullMQ Approach

### ✅ Deduplication
```typescript
jobId: `picks:${eventId}:${tournamentId}`
// Multiple crons won't create duplicate jobs
```

### ✅ Automatic Retry
```typescript
// Per-tournament retry with exponential backoff
// Failed entries throw error → BullMQ retries tournament job
attempts: 3,
backoff: { type: 'exponential', delay: 60_000 }
```

### ✅ Parallelization
```
Worker concurrency: 10
→ Process 10 tournaments in parallel
→ Each tournament syncs 5 entries concurrently
→ Total: 50 entries in parallel (vs 5 currently)
```

### ✅ Progress Tracking
```typescript
// Can query queue for job status
const job = await leagueSyncQueue.getJob(jobId);
console.log(job.progress(), job.returnvalue);
```

### ✅ Better Scheduling
```typescript
// Results sync every 10 min (vs 3x daily)
// Aligned with event-lives-db-sync
// Fresh data always available
```

### ✅ Monitoring
```
- BullMQ dashboard shows queue depth
- Job success/failure rates per tournament
- Processing times per tournament
- Identify slow/problematic tournaments
```

---

## Comparison: Before vs After

| Aspect | Before (Direct Exec) | After (BullMQ) |
|--------|----------------------|----------------|
| **Concurrency** | 5 entries | 50+ entries (10 tournaments × 5) |
| **Deduplication** | None | Via jobId |
| **Retry** | Log only | 3x exponential backoff |
| **Failure isolation** | All-or-nothing | Per-tournament |
| **Progress tracking** | None | Per-tournament job status |
| **Results frequency** | 3x daily | Every 10 min |
| **Results freshness** | Up to 12 hours | < 10 min |
| **Monitoring** | Logs only | BullMQ dashboard + logs |
| **Parallelization** | Single sync | Per-tournament jobs |

---

## Estimated Performance

### Scenario: 5 Tournaments, 4,000 Total Entries

**Before (Direct Execution):**
```
Picks sync: 4,000 entries / 5 concurrency × 200ms = 160 seconds
Results sync: Similar (~120 seconds)
```

**After (BullMQ with Per-Tournament Jobs):**
```
Coordinator job: Enqueue 5 jobs (instant)
  ↓
Worker (concurrency: 10) processes tournaments in parallel:
  → Tournament 1: 2,000 entries / 5 concurrency × 200ms = 80 seconds
  → Tournament 2: 1,500 entries / 5 concurrency × 200ms = 60 seconds
  → Tournament 3: 500 entries / 5 concurrency × 200ms = 20 seconds
  → Tournament 4: ...
  → Tournament 5: ...

Total time: ~80 seconds (limited by largest tournament)
// vs 160 seconds before (2x faster)
```

**If increase per-tournament concurrency to 10:**
```
Total time: ~40 seconds (4x faster)
```

---

## Risks & Mitigations

### Risk 1: FPL API Rate Limiting

**Problem:** More parallel requests might hit rate limits

**Mitigation:**
- Add configurable max concurrency per job
- Add delay between tournament jobs
- Monitor API error rates
- Implement exponential backoff

### Risk 2: Database Load

**Problem:** More parallel writes

**Mitigation:**
- Keep batch size at 500
- Use existing upsert methods (already optimized)
- Monitor database CPU/connections

### Risk 3: Worker Resource Usage

**Problem:** Processing 10 tournaments × 5 entries = 50 concurrent API calls

**Mitigation:**
- Start with conservative worker concurrency (5-10)
- Monitor memory/CPU usage
- Scale horizontally if needed (multiple worker processes)

---

## Recommendation

### ✅ YES - Convert League Jobs to BullMQ

**Priority: HIGH**

**Reasoning:**
1. **Consistency:** All other multi-entry jobs use BullMQ
2. **Scalability:** Handle 1,000s of entries efficiently
3. **Reliability:** Automatic retry per tournament
4. **Monitoring:** Track progress and failures
5. **Performance:** 2-4x faster with parallelization
6. **Better scheduling:** Results every 10 min (vs 3x daily)

**Immediate Benefits:**
- Deduplication (prevent overlapping syncs)
- Per-tournament retry (failure isolation)
- Faster results updates (10 min vs 12 hours)

**Long-term Benefits:**
- Scalable to 10,000+ entries
- Better observability (BullMQ dashboard)
- Easier debugging (job IDs, progress tracking)

---

## Questions for Decision

1. **Worker concurrency for league jobs?**
   - Recommendation: Start with 5-10 tournaments in parallel

2. **Per-tournament entry concurrency?**
   - Recommendation: Keep at 5, increase to 10 if no API issues

3. **Results sync frequency?**
   - Recommendation: Every 10 min during after-match-day window
   - Or: Cascade after event-lives-db-sync

4. **Chunking entries vs per-tournament?**
   - Recommendation: Per-tournament (simpler, better isolation)

5. **Cascade from live-events-db-sync?**
   - Recommendation: YES for results sync (needs fresh event_lives)
   - Recommendation: NO for picks sync (independent schedule)

---

## Files to Review

- `src/services/league-event-picks.service.ts` (185 lines)
- `src/services/league-event-results.service.ts` (451 lines)
- `src/jobs/league-event-picks.jobs.ts` (53 lines)
- `src/jobs/league-event-results.jobs.ts` (53 lines)

**Next step:** Implement BullMQ architecture for league jobs?
