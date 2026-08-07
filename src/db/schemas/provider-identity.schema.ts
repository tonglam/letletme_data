import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { timestamps } from './_helpers.schema';
import { providerEntityTypeEnum, providerLinkStatusEnum } from './enums.schema';

export type ProviderLinkEvidence = Record<string, unknown>;

export const providerEntityLinks = pgTable(
  'provider_entity_links',
  {
    id: uuid('id').primaryKey(),
    entityType: providerEntityTypeEnum('entity_type').notNull(),
    leftProvider: text('left_provider').notNull(),
    leftEntityId: text('left_entity_id'),
    rightProvider: text('right_provider').notNull(),
    rightEntityId: text('right_entity_id').notNull(),
    status: providerLinkStatusEnum('status').notNull(),
    method: text('method').notNull(),
    ruleVersion: text('rule_version').notNull(),
    evidence: jsonb('evidence').$type<ProviderLinkEvidence>().default({}).notNull(),
    firstSeenSeason: text('first_seen_season'),
    lastSeenSeason: text('last_seen_season'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    check(
      'provider_entity_links_verified_left_check',
      sql`${table.status} NOT IN ('auto_verified', 'manual_verified') OR ${table.leftEntityId} IS NOT NULL`,
    ),
    uniqueIndex('uq_provider_entity_links_pair').on(
      table.entityType,
      table.leftProvider,
      table.leftEntityId,
      table.rightProvider,
      table.rightEntityId,
    ),
    uniqueIndex('uq_provider_entity_links_verified_left')
      .on(table.entityType, table.leftProvider, table.leftEntityId, table.rightProvider)
      .where(sql`${table.status} IN ('auto_verified', 'manual_verified')`),
    uniqueIndex('uq_provider_entity_links_not_observed_right')
      .on(table.entityType, table.rightProvider, table.rightEntityId, table.leftProvider)
      .where(sql`${table.status} = 'not_observed'`),
    uniqueIndex('uq_provider_entity_links_verified_right')
      .on(table.entityType, table.rightProvider, table.rightEntityId, table.leftProvider)
      .where(sql`${table.status} IN ('auto_verified', 'manual_verified')`),
    index('idx_provider_entity_links_status').on(table.entityType, table.status),
  ],
);

export const providerMatchLinks = pgTable(
  'provider_match_links',
  {
    id: uuid('id').primaryKey(),
    season: text('season').notNull(),
    leftProvider: text('left_provider').notNull(),
    leftMatchId: text('left_match_id').notNull(),
    rightProvider: text('right_provider').notNull(),
    rightMatchId: text('right_match_id').notNull(),
    status: providerLinkStatusEnum('status').notNull(),
    method: text('method').notNull(),
    ruleVersion: text('rule_version').notNull(),
    evidence: jsonb('evidence').$type<ProviderLinkEvidence>().default({}).notNull(),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('uq_provider_match_links_pair').on(
      table.season,
      table.leftProvider,
      table.leftMatchId,
      table.rightProvider,
      table.rightMatchId,
    ),
    uniqueIndex('uq_provider_match_links_verified_left')
      .on(table.season, table.leftProvider, table.leftMatchId, table.rightProvider)
      .where(sql`${table.status} IN ('auto_verified', 'manual_verified')`),
    uniqueIndex('uq_provider_match_links_verified_right')
      .on(table.season, table.rightProvider, table.rightMatchId, table.leftProvider)
      .where(sql`${table.status} IN ('auto_verified', 'manual_verified')`),
    index('idx_provider_match_links_status').on(table.season, table.status),
  ],
);

export const providerEntityAliases = pgTable(
  'provider_entity_aliases',
  {
    id: uuid('id').primaryKey(),
    entityType: providerEntityTypeEnum('entity_type').notNull(),
    provider: text('provider').notNull(),
    providerEntityId: text('provider_entity_id').notNull(),
    alias: text('alias').notNull(),
    source: text('source').notNull(),
    firstObservedAt: timestamp('first_observed_at', { withTimezone: true }).notNull(),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('uq_provider_entity_aliases').on(
      table.entityType,
      table.provider,
      table.providerEntityId,
      table.alias,
      table.source,
    ),
    index('idx_provider_entity_aliases_lookup').on(
      table.entityType,
      table.provider,
      table.providerEntityId,
    ),
  ],
);
