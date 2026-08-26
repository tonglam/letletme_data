import { and, asc, eq } from 'drizzle-orm';

import { tournamentOfficialH2HPageManifestsInCompetition } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { ConflictError } from '../utils/errors';
import type { OfficialH2HPageManifest } from '../domain/official-h2h-manifest';

function mapRow(
  row: typeof tournamentOfficialH2HPageManifestsInCompetition.$inferSelect,
): OfficialH2HPageManifest {
  return {
    pageNumber: row.pageNumber,
    scheduleHash: row.scheduleHash,
    matchIds: row.matchIds,
    eventIds: row.eventIds,
    immutablePageHash: row.immutablePageHash,
    capturedAt: row.capturedAt.toISOString(),
    lockedAt: row.lockedAt?.toISOString() ?? null,
  };
}

export const tournamentOfficialH2HManifestRepository = {
  async findByTournament(season: FplSeasonRef, tournamentId: number) {
    const db = await getDb();
    const rows = await db
      .select()
      .from(tournamentOfficialH2HPageManifestsInCompetition)
      .where(
        and(
          eq(tournamentOfficialH2HPageManifestsInCompetition.seasonId, season.seasonId),
          eq(tournamentOfficialH2HPageManifestsInCompetition.tournamentId, tournamentId),
        ),
      )
      .orderBy(asc(tournamentOfficialH2HPageManifestsInCompetition.pageNumber));
    return rows.map(mapRow);
  },

  async replaceForTournament(
    season: FplSeasonRef,
    tournamentId: number,
    manifests: readonly OfficialH2HPageManifest[],
  ): Promise<void> {
    if (manifests.length === 0) throw new Error('Cannot persist an empty H2H page manifest');
    const db = await getDb();
    await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(tournamentOfficialH2HPageManifestsInCompetition)
        .where(
          and(
            eq(tournamentOfficialH2HPageManifestsInCompetition.seasonId, season.seasonId),
            eq(tournamentOfficialH2HPageManifestsInCompetition.tournamentId, tournamentId),
          ),
        );
      const existingByPage = new Map(existing.map((row) => [row.pageNumber, row]));
      for (const manifest of manifests) {
        const previous = existingByPage.get(manifest.pageNumber);
        if (
          previous?.lockedAt &&
          (previous.immutablePageHash !== manifest.immutablePageHash ||
            previous.scheduleHash !== manifest.scheduleHash ||
            previous.matchIds.join(',') !== manifest.matchIds.join(',') ||
            previous.eventIds.join(',') !== manifest.eventIds.join(','))
        ) {
          throw new ConflictError(
            `Official H2H page ${manifest.pageNumber} changed after it was locked.`,
            'TOURNAMENT_OFFICIAL_H2H_PAGE_CHANGED',
          );
        }
        await tx
          .insert(tournamentOfficialH2HPageManifestsInCompetition)
          .values({
            seasonId: season.seasonId,
            tournamentId,
            pageNumber: manifest.pageNumber,
            scheduleHash: manifest.scheduleHash,
            matchIds: [...manifest.matchIds],
            eventIds: [...manifest.eventIds],
            immutablePageHash: manifest.immutablePageHash,
            capturedAt: new Date(manifest.capturedAt),
            lockedAt: manifest.lockedAt
              ? new Date(manifest.lockedAt)
              : (previous?.lockedAt ?? null),
          })
          .onConflictDoUpdate({
            target: [
              tournamentOfficialH2HPageManifestsInCompetition.seasonId,
              tournamentOfficialH2HPageManifestsInCompetition.tournamentId,
              tournamentOfficialH2HPageManifestsInCompetition.pageNumber,
            ],
            set: {
              scheduleHash: manifest.scheduleHash,
              matchIds: [...manifest.matchIds],
              eventIds: [...manifest.eventIds],
              immutablePageHash: manifest.immutablePageHash,
              capturedAt: new Date(manifest.capturedAt),
              lockedAt:
                previous?.lockedAt ?? (manifest.lockedAt ? new Date(manifest.lockedAt) : null),
            },
          });
      }
    });
  },
};
