import { and, eq, inArray, sql } from 'drizzle-orm';

import { eventsInFpl, playersInFpl, seasonsInFpl, teamsInFpl } from '../db/schemas/index.schema';
import { readDatabaseOrderingTimestamp } from '../db/ordering-timestamp';
import { getDb, type DbHandle, type DbOrTransaction } from '../db/singleton';
import { explicitSeasonRef, type FplSeasonRef } from '../domain/fpl-season';
import { createEventRepository } from '../repositories/events';
import { createFixtureRepository } from '../repositories/fixtures';
import { createPhaseRepository } from '../repositories/phases';
import { createPlayerRepository } from '../repositories/players';
import { createTeamRepository } from '../repositories/teams';
import { DatabaseError } from '../utils/errors';

import type { CoreSnapshot } from '../domain/core-snapshot';

export const CORE_SNAPSHOT_WRITE_LOCK_KEY = 912_883_472;

export interface CoreSnapshotPersistenceResult {
  readonly events: number;
  readonly teams: number;
  readonly players: number;
  readonly phases: number;
  readonly fixtures: number;
}

export async function readCoreSnapshotOrderingTimestamp(dbInstance?: DbHandle): Promise<Date> {
  return (await readDatabaseOrderingTimestamp(dbInstance)).date;
}

export async function withCoreSnapshotWriteLock<T>(
  season: FplSeasonRef,
  operation: (transaction: DbOrTransaction) => Promise<T>,
  dbInstance?: DbHandle,
): Promise<T> {
  const db = dbInstance ?? (await getDb());
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(${CORE_SNAPSHOT_WRITE_LOCK_KEY})`);
    const current = await transaction
      .select({
        seasonId: seasonsInFpl.seasonId,
        seasonCode: seasonsInFpl.seasonCode,
      })
      .from(seasonsInFpl)
      .where(eq(seasonsInFpl.isCurrent, true))
      .for('update');
    if (
      current.length !== 1 ||
      current[0].seasonId !== season.seasonId ||
      current[0].seasonCode !== season.seasonCode
    ) {
      throw new DatabaseError(
        `Core snapshot ${season.seasonCode} is not the sole current database season`,
        'CORE_SNAPSHOT_CURRENT_SEASON_MISMATCH',
      );
    }
    return operation(transaction);
  });
}

export async function withCoreSnapshotReadLock<T>(
  season: FplSeasonRef,
  operation: (transaction: DbOrTransaction) => Promise<T>,
  dbInstance?: DbHandle,
): Promise<T> {
  const db = dbInstance ?? (await getDb());
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock_shared(${CORE_SNAPSHOT_WRITE_LOCK_KEY})`,
    );
    const current = await transaction
      .select({
        seasonId: seasonsInFpl.seasonId,
        seasonCode: seasonsInFpl.seasonCode,
      })
      .from(seasonsInFpl)
      .where(eq(seasonsInFpl.isCurrent, true))
      .for('share');
    if (
      current.length !== 1 ||
      current[0].seasonId !== season.seasonId ||
      current[0].seasonCode !== season.seasonCode
    ) {
      throw new DatabaseError(
        `FPL season ${season.seasonCode} is not the sole current database season`,
        'CURRENT_SEASON_MISMATCH',
      );
    }
    return operation(transaction);
  });
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
  season: FplSeasonRef,
  snapshot: CoreSnapshot,
  db: DbOrTransaction,
  sourceCheckedAt?: Date,
): Promise<CoreSnapshotPersistenceResult> {
  const savedEvents = await createEventRepository(db).upsertBatch(season, snapshot.events);
  const savedTeams = await createTeamRepository(db).upsertBatch(season, snapshot.teams);
  const savedPlayers = await createPlayerRepository(db).upsertBatch(
    season,
    snapshot.players,
    sourceCheckedAt,
  );
  const savedPhases = await createPhaseRepository(db).upsertBatch(season, snapshot.phases);
  const fixtureRepository = createFixtureRepository(db);
  await fixtureRepository.markAbsentUnscheduled(
    season,
    snapshot.fixtures.map((fixture) => fixture.id),
    sourceCheckedAt,
    snapshot.fixtures.map((fixture) => fixture.code),
  );
  const savedFixtures = await fixtureRepository.upsertBatch(season, snapshot.fixtures);

  requirePersistedCount('events', savedEvents.length, snapshot.events.length);
  requirePersistedCount('teams', savedTeams.length, snapshot.teams.length);
  requirePersistedCount('players', savedPlayers.length, snapshot.players.length);
  requirePersistedCount('phases', savedPhases.length, snapshot.phases.length);
  requirePersistedCount('fixtures', savedFixtures.length, snapshot.fixtures.length);

  return {
    events: savedEvents.length,
    teams: savedTeams.length,
    players: savedPlayers.length,
    phases: savedPhases.length,
    fixtures: savedFixtures.length,
  };
}

async function reconcileDurableWinners(
  season: FplSeasonRef,
  snapshot: CoreSnapshot,
  sourceCheckedAt: Date | undefined,
  db: DbOrTransaction,
): Promise<CoreSnapshot> {
  if (!sourceCheckedAt) return snapshot;

  const storedPlayers = await db
    .select({
      elementId: playersInFpl.elementId,
      price: playersInFpl.price,
      priceSourceCheckedAt: playersInFpl.priceSourceCheckedAt,
    })
    .from(playersInFpl)
    .where(
      and(
        eq(playersInFpl.seasonId, season.seasonId),
        inArray(
          playersInFpl.elementId,
          snapshot.players.map((player) => player.id),
        ),
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
      .map((row) => [row.elementId, row.price]),
  );

  const storedEvents = await db
    .select({
      eventId: eventsInFpl.eventId,
      checkedAt: eventsInFpl.liveSnapshotCheckedAt,
    })
    .from(eventsInFpl)
    .where(eq(eventsInFpl.seasonId, season.seasonId))
    .for('update');
  const liveOwnedEventIds = new Set(
    storedEvents
      .filter((row) => row.checkedAt && row.checkedAt.getTime() >= sourceCheckedAt.getTime())
      .map((row) => row.eventId),
  );
  const storedFixtures =
    liveOwnedEventIds.size > 0 ? await createFixtureRepository(db).findAll(season) : [];
  const storedFixturesById = new Map(storedFixtures.map((fixture) => [fixture.id, fixture]));

  return {
    ...snapshot,
    players: snapshot.players.map((player) => {
      const price = newerPriceById.get(player.id);
      return price === undefined ? player : { ...player, price };
    }),
    fixtures: snapshot.fixtures.map((fixture) => {
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
          'A Live-owned fixture is missing from canonical storage',
          'CORE_SNAPSHOT_LIVE_FIXTURE_MISSING',
        );
      }
      return {
        ...stored,
        createdAt: fixture.createdAt,
        updatedAt: fixture.updatedAt,
      };
    }),
  };
}

async function assertIdentityCompatibility(
  season: FplSeasonRef,
  snapshot: CoreSnapshot,
  db: DbOrTransaction,
): Promise<void> {
  const [storedTeams, storedPlayers] = await Promise.all([
    db
      .select({
        teamId: teamsInFpl.teamId,
        code: teamsInFpl.code,
        pulseId: teamsInFpl.pulseId,
      })
      .from(teamsInFpl)
      .where(eq(teamsInFpl.seasonId, season.seasonId)),
    db
      .select({ elementId: playersInFpl.elementId, code: playersInFpl.code })
      .from(playersInFpl)
      .where(eq(playersInFpl.seasonId, season.seasonId)),
  ]);
  const candidateTeamsById = new Map(snapshot.teams.map((team) => [team.id, team]));
  const candidateTeamIdsByCode = new Map(snapshot.teams.map((team) => [team.code, team.id]));
  const candidateTeamIdsByPulse = new Map(snapshot.teams.map((team) => [team.pulseId, team.id]));
  const candidatePlayersById = new Map(snapshot.players.map((player) => [player.id, player]));
  const candidatePlayerIdsByCode = new Map(
    snapshot.players.map((player) => [player.code, player.id]),
  );

  const teamConflict = storedTeams.some((stored) => {
    const candidate = candidateTeamsById.get(stored.teamId);
    return (
      (candidate && (candidate.code !== stored.code || candidate.pulseId !== stored.pulseId)) ||
      (candidateTeamIdsByCode.get(stored.code) ?? stored.teamId) !== stored.teamId ||
      (candidateTeamIdsByPulse.get(stored.pulseId) ?? stored.teamId) !== stored.teamId
    );
  });
  const playerConflict = storedPlayers.some((stored) => {
    const candidate = candidatePlayersById.get(stored.elementId);
    return (
      (candidate && candidate.code !== stored.code) ||
      (candidatePlayerIdsByCode.get(stored.code) ?? stored.elementId) !== stored.elementId
    );
  });
  if (teamConflict || playerConflict) {
    throw new DatabaseError(
      'Core snapshot identities conflict with canonical rows',
      'CORE_SNAPSHOT_IDENTITY_CONFLICT',
    );
  }
}

export async function persistCoreSnapshot(
  snapshot: CoreSnapshot,
  sourceCheckedAt?: Date,
  dbInstance?: DbHandle,
): Promise<{ snapshot: CoreSnapshot; persistence: CoreSnapshotPersistenceResult }> {
  const season = explicitSeasonRef(snapshot.season);
  return withCoreSnapshotWriteLock(
    season,
    async (transaction) => {
      await assertIdentityCompatibility(season, snapshot, transaction);
      const reconciled = await reconcileDurableWinners(
        season,
        snapshot,
        sourceCheckedAt,
        transaction,
      );
      const persistence = await persistCoreSnapshotRows(
        season,
        reconciled,
        transaction,
        sourceCheckedAt,
      );
      return { snapshot: reconciled, persistence };
    },
    dbInstance,
  );
}
