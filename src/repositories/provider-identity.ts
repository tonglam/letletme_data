import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import {
  entityAliasesInBridge as providerEntityAliases,
  entityLinksInBridge as providerEntityLinks,
  matchLinksInBridge as providerMatchLinks,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type {
  ProviderEntityLink,
  ProviderEntityType,
  ProviderLinkStatus,
  ProviderMatchLink,
} from '../domain/provider-identity';

async function getDatabase(dbInstance?: DbOrTransaction): Promise<DbOrTransaction> {
  return dbInstance ?? (await getDb());
}

function mapEntityLink(row: typeof providerEntityLinks.$inferSelect): ProviderEntityLink {
  return {
    id: row.linkId,
    entityType: row.entityType,
    leftProvider: row.leftProvider,
    leftEntityId: row.leftEntityId,
    rightProvider: row.rightProvider,
    rightEntityId: row.rightEntityId,
    status: row.status,
    method: row.method,
    ruleId: row.ruleId,
    evidence: row.evidence as Record<string, unknown>,
    firstSeenSeason: row.firstSeenSeason,
    lastSeenSeason: row.lastSeenSeason,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
  };
}

function mapMatchLink(row: typeof providerMatchLinks.$inferSelect): ProviderMatchLink {
  return {
    id: row.linkId,
    season: row.seasonCode,
    leftProvider: row.leftProvider,
    leftMatchId: row.leftMatchId,
    rightProvider: row.rightProvider,
    rightMatchId: row.rightMatchId,
    status: row.status,
    method: row.method,
    ruleId: row.ruleId,
    evidence: row.evidence as Record<string, unknown>,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
  };
}

export interface UpsertEntityLinkInput {
  entityType: ProviderEntityType;
  leftProvider: string;
  leftEntityId: string;
  rightProvider: string;
  rightEntityId: string;
  status: ProviderLinkStatus;
  method: string;
  ruleId: string;
  evidence?: Record<string, unknown>;
  season?: string;
  reviewedBy?: string;
  reviewedAt?: Date | null;
}

export interface UpsertMatchLinkInput {
  season: string;
  leftProvider: string;
  leftMatchId: string;
  rightProvider: string;
  rightMatchId: string;
  status: ProviderLinkStatus;
  method: string;
  ruleId: string;
  evidence?: Record<string, unknown>;
  reviewedBy?: string;
}

export const createProviderIdentityRepository = (dbInstance?: DbOrTransaction) => ({
  async upsertEntityLink(input: UpsertEntityLinkInput): Promise<ProviderEntityLink> {
    const db = await getDatabase(dbInstance);
    const reviewed = input.status === 'manual_verified';
    const { season, evidence, reviewedBy, reviewedAt, ...identity } = input;
    const resolvedReviewedAt = reviewed
      ? reviewedAt === undefined
        ? new Date()
        : reviewedAt
      : null;
    const [row] = await db
      .insert(providerEntityLinks)
      .values({
        linkId: randomUUID(),
        ...identity,
        evidence: evidence ?? {},
        updatedAt: sql`clock_timestamp()`,
        firstSeenSeason: season,
        lastSeenSeason: season,
        reviewedBy: reviewed ? reviewedBy : null,
        reviewedAt: resolvedReviewedAt,
      })
      .onConflictDoUpdate({
        target: [
          providerEntityLinks.entityType,
          providerEntityLinks.leftProvider,
          providerEntityLinks.leftEntityId,
          providerEntityLinks.rightProvider,
          providerEntityLinks.rightEntityId,
        ],
        set: {
          status: input.status,
          method: input.method,
          ruleId: input.ruleId,
          evidence: input.evidence ?? {},
          firstSeenSeason: sql`CASE
            WHEN ${providerEntityLinks.firstSeenSeason} IS NULL THEN excluded.first_seen_season
            WHEN excluded.first_seen_season IS NULL THEN ${providerEntityLinks.firstSeenSeason}
            ELSE LEAST(${providerEntityLinks.firstSeenSeason}, excluded.first_seen_season)
          END`,
          lastSeenSeason: sql`CASE
            WHEN ${providerEntityLinks.lastSeenSeason} IS NULL THEN excluded.last_seen_season
            WHEN excluded.last_seen_season IS NULL THEN ${providerEntityLinks.lastSeenSeason}
            ELSE GREATEST(${providerEntityLinks.lastSeenSeason}, excluded.last_seen_season)
          END`,
          reviewedBy: reviewed ? input.reviewedBy : null,
          reviewedAt: resolvedReviewedAt,
          // Candidate links are re-observed on every season repair pass. Keep
          // the source revision stable while a pending/ambiguous candidate is
          // re-observed; otherwise a later season's candidate evidence can
          // make every earlier season look stale again. Explicit review
          // transitions still use the generic branch below and advance the
          // revision, including a verified link moved back to pending.
          updatedAt: sql`CASE
            WHEN ${providerEntityLinks.status} IS NOT DISTINCT FROM excluded.status
              AND ${providerEntityLinks.status} IN ('pending', 'ambiguous')
              AND excluded.status IN ('pending', 'ambiguous')
            THEN ${providerEntityLinks.updatedAt}
            WHEN ${providerEntityLinks.status} IS DISTINCT FROM excluded.status
              OR ${providerEntityLinks.method} IS DISTINCT FROM excluded.method
              OR ${providerEntityLinks.ruleId} IS DISTINCT FROM excluded.rule_id
              OR ${providerEntityLinks.evidence} IS DISTINCT FROM excluded.evidence
              OR ${providerEntityLinks.firstSeenSeason} IS DISTINCT FROM (
                CASE
                  WHEN ${providerEntityLinks.firstSeenSeason} IS NULL THEN excluded.first_seen_season
                  WHEN excluded.first_seen_season IS NULL THEN ${providerEntityLinks.firstSeenSeason}
                  ELSE LEAST(${providerEntityLinks.firstSeenSeason}, excluded.first_seen_season)
                END
              )
              OR ${providerEntityLinks.lastSeenSeason} IS DISTINCT FROM (
                CASE
                  WHEN ${providerEntityLinks.lastSeenSeason} IS NULL THEN excluded.last_seen_season
                  WHEN excluded.last_seen_season IS NULL THEN ${providerEntityLinks.lastSeenSeason}
                  ELSE GREATEST(${providerEntityLinks.lastSeenSeason}, excluded.last_seen_season)
                END
              )
              OR ${providerEntityLinks.reviewedBy} IS DISTINCT FROM excluded.reviewed_by
              OR ${providerEntityLinks.reviewedAt} IS DISTINCT FROM excluded.reviewed_at
            THEN clock_timestamp()
            ELSE ${providerEntityLinks.updatedAt}
          END`,
        },
      })
      .returning();
    return mapEntityLink(row);
  },

  async upsertMatchLink(input: UpsertMatchLinkInput): Promise<ProviderMatchLink> {
    const db = await getDatabase(dbInstance);
    const reviewed = input.status === 'manual_verified';
    const { season, evidence, reviewedBy, ...identity } = input;
    const [row] = await db
      .insert(providerMatchLinks)
      .values({
        linkId: randomUUID(),
        ...identity,
        seasonCode: season,
        evidence: evidence ?? {},
        reviewedBy: reviewed ? reviewedBy : null,
        reviewedAt: reviewed ? new Date() : null,
        updatedAt: sql`clock_timestamp()`,
      })
      .onConflictDoUpdate({
        target: [
          providerMatchLinks.seasonCode,
          providerMatchLinks.leftProvider,
          providerMatchLinks.leftMatchId,
          providerMatchLinks.rightProvider,
          providerMatchLinks.rightMatchId,
        ],
        set: {
          status: input.status,
          method: input.method,
          ruleId: input.ruleId,
          evidence: input.evidence ?? {},
          reviewedBy: reviewed ? input.reviewedBy : null,
          reviewedAt: reviewed ? new Date() : null,
          updatedAt: sql`clock_timestamp()`,
        },
      })
      .returning();
    return mapMatchLink(row);
  },

  async updateEntityStatus(
    id: string,
    status: ProviderLinkStatus,
    reviewedBy?: string,
  ): Promise<ProviderEntityLink | null> {
    const db = await getDatabase(dbInstance);
    const [row] = await db
      .update(providerEntityLinks)
      .set({
        status,
        reviewedBy: reviewedBy ?? null,
        reviewedAt: reviewedBy ? new Date() : null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(providerEntityLinks.linkId, id))
      .returning();
    return row ? mapEntityLink(row) : null;
  },

  async updateMatchStatus(
    id: string,
    status: ProviderLinkStatus,
    reviewedBy?: string,
  ): Promise<ProviderMatchLink | null> {
    const db = await getDatabase(dbInstance);
    const [row] = await db
      .update(providerMatchLinks)
      .set({
        status,
        reviewedBy: reviewedBy ?? null,
        reviewedAt: reviewedBy ? new Date() : null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(providerMatchLinks.linkId, id))
      .returning();
    return row ? mapMatchLink(row) : null;
  },

  async findEntityLinks(
    input: {
      entityType?: ProviderEntityType;
      statuses?: ProviderLinkStatus[];
    } = {},
  ): Promise<ProviderEntityLink[]> {
    const db = await getDatabase(dbInstance);
    const conditions = [];
    if (input.entityType) conditions.push(eq(providerEntityLinks.entityType, input.entityType));
    if (input.statuses?.length)
      conditions.push(inArray(providerEntityLinks.status, input.statuses));
    const rows = await db
      .select()
      .from(providerEntityLinks)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(providerEntityLinks.entityType), asc(providerEntityLinks.createdAt));
    return rows.map(mapEntityLink);
  },

  async findMatchLinks(
    input: {
      season?: string;
      statuses?: ProviderLinkStatus[];
    } = {},
  ): Promise<ProviderMatchLink[]> {
    const db = await getDatabase(dbInstance);
    const conditions = [];
    if (input.season) conditions.push(eq(providerMatchLinks.seasonCode, input.season));
    if (input.statuses?.length) conditions.push(inArray(providerMatchLinks.status, input.statuses));
    const rows = await db
      .select()
      .from(providerMatchLinks)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(providerMatchLinks.seasonCode), asc(providerMatchLinks.createdAt));
    return rows.map(mapMatchLink);
  },

  async upsertAlias(input: {
    entityType: ProviderEntityType;
    provider: string;
    providerEntityId: string;
    alias: string;
    source: string;
    observedAt?: Date;
  }): Promise<void> {
    const db = await getDatabase(dbInstance);
    const observedAt = input.observedAt ?? new Date();
    const { observedAt: _observedAt, ...alias } = input;
    await db
      .insert(providerEntityAliases)
      .values({
        aliasId: randomUUID(),
        ...alias,
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
      })
      .onConflictDoUpdate({
        target: [
          providerEntityAliases.entityType,
          providerEntityAliases.provider,
          providerEntityAliases.providerEntityId,
          providerEntityAliases.alias,
          providerEntityAliases.source,
        ],
        set: { lastObservedAt: observedAt, updatedAt: observedAt },
      });
  },
});

export const providerIdentityRepository = createProviderIdentityRepository();
