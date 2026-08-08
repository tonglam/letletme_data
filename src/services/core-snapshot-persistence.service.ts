import { inArray, sql } from 'drizzle-orm';

import { acquireActiveSeasonWriteFence } from '../cache/cache-season';
import { events, players, teams } from '../db/schemas/index.schema';
import { readDatabaseOrderingTimestamp } from '../db/ordering-timestamp';
import {
  getDb,
  type DbHandle,
  type DbOrTransaction,
  type TransactionHandle,
} from '../db/singleton';
import { createEventRepository } from '../repositories/events';
import { createFixtureRepository } from '../repositories/fixtures';
import { createPhaseRepository } from '../repositories/phases';
import { createPlayerRepository } from '../repositories/players';
import { createTeamRepository } from '../repositories/teams';
import {
  findCoreSnapshotAuthority,
  recordCoreSnapshotAuthority,
} from '../repositories/core-snapshot-authority';
import { DatabaseError } from '../utils/errors';

import type { CoreSnapshot } from '../domain/core-snapshot';

const CORE_SNAPSHOT_AUTHORITY_LOCK_KEY = 912_883_472;

export async function withCoreSnapshotAuthorityLock<T>(
  operation: (transaction: TransactionHandle) => Promise<T>,
  dbInstance?: DbHandle,
): Promise<T> {
  const db = dbInstance ?? (await getDb());
  return db.transaction(async (transaction) => {
    // Season authority is always acquired before core authority. Partial
    // repairs use the same order with a shared season fence, so a complete
    // publication can neither race a repair nor deadlock with fixture writers.
    await acquireActiveSeasonWriteFence(transaction);
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(${CORE_SNAPSHOT_AUTHORITY_LOCK_KEY})`,
    );
    return operation(transaction);
  });
}

export interface CoreSnapshotPersistenceResult {
  events: number;
  teams: number;
  players: number;
  phases: number;
  fixtures: number;
}

export interface CoreSnapshotCommitResult<T> {
  status: 'committed' | 'stale';
  persistence: CoreSnapshotPersistenceResult | null;
  finalization: T | null;
}

export interface CoreSnapshotPublicationOptions<T> {
  revision: number;
  publicationId: string;
  previousActiveSeason: string | null;
  /** PostgreSQL ordering evidence captured before the upstream reads began. */
  sourceCheckedAt?: Date;
  finalize: (snapshot: CoreSnapshot) => Promise<T>;
  compensate: (finalization: T) => Promise<void>;
  afterCommit: (finalization: T) => Promise<void>;
}

export async function readCoreSnapshotOrderingTimestamp(dbInstance?: DbHandle): Promise<Date> {
  return (await readDatabaseOrderingTimestamp(dbInstance)).date;
}

function requirePersistedCount(label: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new DatabaseError(
      `Core snapshot ${label} persistence was incomplete`,
      'CORE_SNAPSHOT_PERSISTENCE_INCOMPLETE',
    );
  }
}

async function persistCoreSnapshotRows(
  snapshot: CoreSnapshot,
  db: DbOrTransaction,
  sourceCheckedAt?: Date,
): Promise<CoreSnapshotPersistenceResult> {
  // The cache can represent fixtures that FPL has not assigned to a gameweek,
  // while older deployed database schemas still require event_id. Keep those
  // fixtures in the cache snapshot and persist only schedulable rows.
  const schedulableFixtures = snapshot.fixtures.filter((fixture) => fixture.event !== null);
  const savedEvents = await createEventRepository(db).upsertBatch(snapshot.events);
  const savedTeams = await createTeamRepository(db).upsertBatch(snapshot.teams);
  const savedPlayers = await createPlayerRepository(db).upsertBatch(
    snapshot.players,
    sourceCheckedAt,
  );
  const savedPhases = await createPhaseRepository(db).upsertBatch(snapshot.phases);
  const fixtureRepository = createFixtureRepository(db);
  const unscheduledFixtureIds = snapshot.fixtures
    .filter((fixture) => fixture.event === null)
    .map((fixture) => fixture.id);
  if (unscheduledFixtureIds.length > 0) {
    await fixtureRepository.markUnscheduled(unscheduledFixtureIds);
  }
  // Retire rows omitted from the authoritative snapshot before inserting any
  // replacement fixture. The unique (event, home, away) index otherwise lets
  // an upstream fixture-id replacement fail before the old row can be cleared.
  await fixtureRepository.markAbsentUnscheduled(
    snapshot.fixtures.map((fixture) => fixture.id),
    sourceCheckedAt,
    snapshot.fixtures.map((fixture) => fixture.code),
  );
  const savedFixtures = await fixtureRepository.upsertBatch(schedulableFixtures);

  requirePersistedCount('events', savedEvents.length, snapshot.events.length);
  requirePersistedCount('teams', savedTeams.length, snapshot.teams.length);
  requirePersistedCount('players', savedPlayers.length, snapshot.players.length);
  requirePersistedCount('phases', savedPhases.length, snapshot.phases.length);
  requirePersistedCount('fixtures', savedFixtures.length, schedulableFixtures.length);

  return {
    events: savedEvents.length,
    teams: savedTeams.length,
    players: savedPlayers.length,
    phases: savedPhases.length,
    fixtures: savedFixtures.length,
  };
}

/**
 * Retain fields owned by durable writers that completed after this core
 * snapshot started fetching. The returned snapshot is used for both database
 * persistence and cache publication, so neither surface can regress.
 */
async function reconcileDurableWinners(
  snapshot: CoreSnapshot,
  sourceCheckedAt: Date | undefined,
  db: DbOrTransaction,
): Promise<CoreSnapshot> {
  if (!sourceCheckedAt) return snapshot;

  // Lock the same canonical rows the later upserts will replace. A partial
  // writer that committed first is visible below; one that starts later waits
  // and becomes the final winner after this short transaction commits.
  const storedPlayers = await db
    .select({
      id: players.id,
      price: players.price,
      priceSourceCheckedAt: players.priceSourceCheckedAt,
    })
    .from(players)
    .where(
      inArray(
        players.id,
        snapshot.players.map((player) => player.id),
      ),
    )
    .for('update');
  const newerPriceById = new Map(
    storedPlayers
      .filter(
        (row) =>
          row.priceSourceCheckedAt &&
          row.priceSourceCheckedAt.getTime() >= sourceCheckedAt.getTime(),
      )
      .map((row) => [row.id, row.price]),
  );

  // The event rows are the durable Live ownership fence. Lock all 38 before
  // reading their markers so a Live write can neither slip between this audit
  // and the fixture upsert nor deadlock on a changing event subset.
  const storedEvents = await db
    .select({ id: events.id, checkedAt: events.liveSnapshotCheckedAt })
    .from(events)
    .for('update');
  const liveOwnedEventIds = new Set(
    storedEvents
      .filter((row) => row.checkedAt && row.checkedAt.getTime() >= sourceCheckedAt.getTime())
      .map((row) => row.id),
  );
  const storedFixtures =
    liveOwnedEventIds.size > 0 ? await createFixtureRepository(db).findAll() : [];
  const storedFixturesById = new Map(storedFixtures.map((fixture) => [fixture.id, fixture]));
  const fixtures = snapshot.fixtures.map((fixture) => {
    const stored = storedFixturesById.get(fixture.id);
    const storedEventId = stored?.event;
    const isLiveOwned =
      (fixture.event !== null && liveOwnedEventIds.has(fixture.event)) ||
      (storedEventId !== null &&
        storedEventId !== undefined &&
        liveOwnedEventIds.has(storedEventId));
    if (!isLiveOwned) return fixture;
    if (!stored) {
      throw new DatabaseError(
        'A Live-owned fixture is missing from canonical storage.',
        'CORE_SNAPSHOT_LIVE_FIXTURE_MISSING',
      );
    }
    // Repository timestamps are storage metadata and are not part of the FPL
    // cache contract. Keep the candidate representation while retaining every
    // newer upstream-owned fixture field.
    return {
      ...stored,
      createdAt: fixture.createdAt,
      updatedAt: fixture.updatedAt,
    };
  });

  return {
    ...snapshot,
    players: snapshot.players.map((player) => {
      const price = newerPriceById.get(player.id);
      return price === undefined ? player : { ...player, price };
    }),
    fixtures,
  };
}

async function assertIdentityCompatibility(
  snapshot: CoreSnapshot,
  previousActiveSeason: string | null,
  authoritySeason: string | null,
  db: DbOrTransaction,
): Promise<void> {
  const previousSeason = authoritySeason ?? previousActiveSeason;
  if (previousSeason && previousSeason !== snapshot.season) {
    throw new DatabaseError(
      'Core snapshot season rollover requires the separately approved database rollover runbook.',
      'CORE_SNAPSHOT_MANUAL_ROLLOVER_REQUIRED',
    );
  }

  const [storedTeams, storedPlayers] = await Promise.all([
    db.select({ id: teams.id, code: teams.code, pulseId: teams.pulseId }).from(teams),
    db.select({ id: players.id, code: players.code }).from(players),
  ]);
  const candidateTeamsById = new Map(snapshot.teams.map((team) => [team.id, team]));
  const candidateTeamIdsByCode = new Map(snapshot.teams.map((team) => [team.code, team.id]));
  const candidateTeamIdsByPulse = new Map(snapshot.teams.map((team) => [team.pulseId, team.id]));
  const candidatePlayersById = new Map(snapshot.players.map((player) => [player.id, player]));
  const candidatePlayerIdsByCode = new Map(
    snapshot.players.map((player) => [player.code, player.id]),
  );

  const teamConflict = storedTeams.some((stored) => {
    const candidate = candidateTeamsById.get(stored.id);
    return (
      (candidate && (candidate.code !== stored.code || candidate.pulseId !== stored.pulseId)) ||
      (candidateTeamIdsByCode.get(stored.code) ?? stored.id) !== stored.id ||
      (candidateTeamIdsByPulse.get(stored.pulseId) ?? stored.id) !== stored.id
    );
  });
  const playerConflict = storedPlayers.some((stored) => {
    const candidate = candidatePlayersById.get(stored.id);
    return (
      (candidate && candidate.code !== stored.code) ||
      (candidatePlayerIdsByCode.get(stored.code) ?? stored.id) !== stored.id
    );
  });

  if (teamConflict || playerConflict) {
    throw new DatabaseError(
      'Core snapshot identities conflict with canonical rows.',
      'CORE_SNAPSHOT_IDENTITY_CONFLICT',
    );
  }
}

export async function persistCoreSnapshot(
  snapshot: CoreSnapshot,
  dbInstance?: DbHandle,
): Promise<CoreSnapshotPersistenceResult> {
  const db = dbInstance ?? (await getDb());
  return db.transaction((transaction) => persistCoreSnapshotRows(snapshot, transaction));
}

export async function persistCoreSnapshotWithFinalizer<T>(
  snapshot: CoreSnapshot,
  options: CoreSnapshotPublicationOptions<T>,
  dbInstance?: DbHandle,
): Promise<CoreSnapshotCommitResult<T>> {
  const db = dbInstance ?? (await getDb());
  let persistence: CoreSnapshotPersistenceResult | null = null;
  let finalization: T | null = null;
  let finalized = false;
  let transactionCommitted = false;

  try {
    const result = await withCoreSnapshotAuthorityLock(async (transaction) => {
      const authority = await findCoreSnapshotAuthority(transaction, { lock: true });
      if (authority && authority.revision >= options.revision) {
        return {
          status: 'stale',
          persistence: null,
          finalization: null,
        } satisfies CoreSnapshotCommitResult<T>;
      }

      await assertIdentityCompatibility(
        snapshot,
        options.previousActiveSeason,
        authority?.season ?? null,
        transaction,
      );
      const reconciledSnapshot = await reconcileDurableWinners(
        snapshot,
        options.sourceCheckedAt,
        transaction,
      );
      persistence = await persistCoreSnapshotRows(
        reconciledSnapshot,
        transaction,
        options.sourceCheckedAt,
      );
      finalization = await options.finalize(reconciledSnapshot);
      finalized = true;
      await recordCoreSnapshotAuthority(
        {
          season: snapshot.season,
          revision: options.revision,
          publicationId: options.publicationId,
        },
        transaction,
      );
      return {
        status: 'committed',
        persistence,
        finalization,
      } satisfies CoreSnapshotCommitResult<T>;
    }, db);
    transactionCommitted = result.status === 'committed';
    if (result.status === 'committed' && result.finalization !== null) {
      await options.afterCommit(result.finalization);
    }
    return result;
  } catch (error) {
    if (finalized && !transactionCommitted && finalization !== null) {
      let committedPublication = false;
      try {
        committedPublication = await withCoreSnapshotAuthorityLock(async (transaction) => {
          const authority = await findCoreSnapshotAuthority(transaction, { lock: true });
          return authority?.publicationId === options.publicationId;
        }, db);
      } catch (reconciliationError) {
        // The transaction result is ambiguous and durable authority cannot be
        // read. Preserve the pending Redis receipt so a later recovery attempt
        // can decide whether to finalize or compensate safely.
        throw new DatabaseError(
          'Core snapshot commit outcome could not be reconciled.',
          'CORE_SNAPSHOT_COMMIT_OUTCOME_UNKNOWN',
          reconciliationError instanceof Error ? reconciliationError : undefined,
        );
      }

      if (committedPublication) {
        await options.afterCommit(finalization);
        return {
          status: 'committed',
          persistence,
          finalization,
        };
      }

      try {
        await options.compensate(finalization);
      } catch (compensationError) {
        throw new DatabaseError(
          'Core snapshot database commit and cache compensation both failed.',
          'CORE_SNAPSHOT_COMPENSATION_FAILED',
          compensationError instanceof Error ? compensationError : undefined,
        );
      }
    }
    throw error;
  }
}
