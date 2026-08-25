import { and, desc, eq } from 'drizzle-orm';

import { fplSourceArtifactsInOps } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';

export type FplSourceArtifactCounts = Readonly<{
  events: number;
  teams: number;
  elements: number;
  phases: number;
}>;

export type FplSourceArtifact = Readonly<{
  artifactId: string;
  seasonId: number;
  sourceDay: string;
  sourceTimezone: 'Asia/Shanghai';
  sourceUrl: string;
  bucket: string;
  objectKey: string;
  sha256: string;
  byteSize: number;
  contentType: 'application/json';
  retrievedAt: Date;
  schemaVersion: 1;
  itemCounts: FplSourceArtifactCounts;
  createdAt: Date;
}>;

export type NewFplSourceArtifact = Omit<FplSourceArtifact, 'createdAt'>;

function databaseDay(sourceDay: string): string {
  if (!/^\d{8}$/.test(sourceDay)) throw new Error(`Invalid FPL source day: ${sourceDay}`);
  return `${sourceDay.slice(0, 4)}-${sourceDay.slice(4, 6)}-${sourceDay.slice(6, 8)}`;
}

function sourceDayKey(value: Date | string): string {
  const day = value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
  return day.replaceAll('-', '');
}

function mapArtifact(row: typeof fplSourceArtifactsInOps.$inferSelect): FplSourceArtifact {
  const counts = row.itemCounts as Partial<FplSourceArtifactCounts>;
  if (
    !Number.isSafeInteger(counts.events) ||
    !Number.isSafeInteger(counts.teams) ||
    !Number.isSafeInteger(counts.elements) ||
    !Number.isSafeInteger(counts.phases)
  ) {
    throw new Error(`FPL source artifact ${row.artifactId} has invalid item counts`);
  }
  if (row.sourceTimezone !== 'Asia/Shanghai' || row.contentType !== 'application/json') {
    throw new Error(`FPL source artifact ${row.artifactId} has invalid fixed metadata`);
  }
  if (row.schemaVersion !== 1) {
    throw new Error(`FPL source artifact ${row.artifactId} has unsupported schema version`);
  }
  return {
    artifactId: row.artifactId,
    seasonId: row.seasonId,
    sourceDay: sourceDayKey(row.sourceDay),
    sourceTimezone: row.sourceTimezone,
    sourceUrl: row.sourceUrl,
    bucket: row.bucket,
    objectKey: row.objectKey,
    sha256: row.sha256,
    byteSize: row.byteSize,
    contentType: row.contentType,
    retrievedAt: row.retrievedAt,
    schemaVersion: row.schemaVersion,
    itemCounts: counts as FplSourceArtifactCounts,
    createdAt: row.createdAt,
  };
}

export const createFplSourceArtifactsRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    findLatestForDay: async (
      season: FplSeasonRef,
      sourceDay: string,
    ): Promise<FplSourceArtifact | null> => {
      const db = await getDbInstance();
      const rows = await db
        .select()
        .from(fplSourceArtifactsInOps)
        .where(
          and(
            eq(fplSourceArtifactsInOps.seasonId, season.seasonId),
            eq(fplSourceArtifactsInOps.sourceDay, databaseDay(sourceDay)),
          ),
        )
        .orderBy(
          desc(fplSourceArtifactsInOps.retrievedAt),
          desc(fplSourceArtifactsInOps.artifactId),
        )
        .limit(1);
      return rows[0] ? mapArtifact(rows[0]) : null;
    },

    insertIfAbsent: async (artifact: NewFplSourceArtifact): Promise<FplSourceArtifact> => {
      const db = await getDbInstance();
      const inserted = await db
        .insert(fplSourceArtifactsInOps)
        .values({
          artifactId: artifact.artifactId,
          provider: 'fpl',
          dataset: 'bootstrap-static',
          seasonId: artifact.seasonId,
          sourceDay: databaseDay(artifact.sourceDay),
          sourceTimezone: artifact.sourceTimezone,
          sourceUrl: artifact.sourceUrl,
          bucket: artifact.bucket,
          objectKey: artifact.objectKey,
          sha256: artifact.sha256,
          byteSize: artifact.byteSize,
          contentType: artifact.contentType,
          retrievedAt: artifact.retrievedAt,
          schemaVersion: artifact.schemaVersion,
          itemCounts: artifact.itemCounts,
        })
        // Both the capture identity and the content-addressed object path are
        // unique. Targetless conflict handling safely covers either constraint
        // when concurrent collectors archive identical bytes.
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) return mapArtifact(inserted[0]);

      const existing = await db
        .select()
        .from(fplSourceArtifactsInOps)
        .where(
          and(
            eq(fplSourceArtifactsInOps.provider, 'fpl'),
            eq(fplSourceArtifactsInOps.dataset, 'bootstrap-static'),
            eq(fplSourceArtifactsInOps.seasonId, artifact.seasonId),
            eq(fplSourceArtifactsInOps.sourceDay, databaseDay(artifact.sourceDay)),
            eq(fplSourceArtifactsInOps.sha256, artifact.sha256),
          ),
        )
        .limit(1);
      if (!existing[0]) {
        throw new Error('FPL source artifact insert lost without a matching immutable row');
      }
      return mapArtifact(existing[0]);
    },
  };
};

export const fplSourceArtifactsRepository = createFplSourceArtifactsRepository();
