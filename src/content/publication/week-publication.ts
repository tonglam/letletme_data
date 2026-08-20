import { randomUUID } from 'node:crypto';
import { and, desc, eq, ne, sql } from 'drizzle-orm';

import { getDb, type DbOrTransaction } from '../../db/singleton';
import {
  contentBriefingActivePublication,
  contentPublicationDependencies,
  contentPublicationOutbox,
  contentPublicationPayloads,
  contentPublications,
} from '../../db/schemas/content.schema';
import { mutationScopesInOps } from '../../db/schemas/platform.schema';
import { redisSingleton } from '../../cache/singleton';
import {
  assertWeekPublication,
  serializeWeekPublication,
  validateWeekLocalePair,
  weekPublicationSha256,
  type WeekLocale,
  type WeekPublicationEnvelope,
} from '../contracts/week-publication';
import { dispatchPublicationOutbox } from './revalidation';

export const WEEK_ACTIVE_POINTER_KEY = 'llm:content:briefing:week:active';

export function weekPayloadKey(revision: number, locale: WeekLocale): string {
  if (!Number.isSafeInteger(revision) || revision <= 0) throw new Error('Invalid Week revision');
  return `llm:content:briefing:week:${revision}:${locale}`;
}

export type WeekPublicationResult = Readonly<{
  publicationId: string;
  revision: number;
  state: WeekPublicationEnvelope['state'];
  redisPublished: boolean;
  outboxId: string;
}>;

const WEEK_PUBLICATION_MUTATION_SCOPE = 'content-publication:week';

const ACTIVE_POINTER_CAS_SCRIPT = `
local candidate = cjson.decode(ARGV[1])
local currentRaw = redis.call('GET', KEYS[1])
local current = nil
if currentRaw then
  local ok, decoded = pcall(cjson.decode, currentRaw)
  if not ok or type(decoded) ~= 'table' or type(decoded.revision) ~= 'number' then
    return 'invalid_current'
  end
  current = decoded
end
local candidateRevision = tonumber(candidate.revision)
if candidate.state == 'UNAVAILABLE' then
  if current and tonumber(current.revision) > candidateRevision then return 'stale' end
  redis.call('DEL', KEYS[1])
  return 'tombstoned'
end
if current and candidateRevision < tonumber(current.revision) then return 'stale' end
redis.call('SET', KEYS[1], ARGV[1])
return 'activated'
`;

async function compareAndSetWeekPointer(
  redis: Awaited<ReturnType<typeof redisSingleton.getClient>>,
  candidate: Record<string, unknown>,
): Promise<'activated' | 'tombstoned' | 'stale'> {
  const result = await redis.eval(
    ACTIVE_POINTER_CAS_SCRIPT,
    1,
    WEEK_ACTIVE_POINTER_KEY,
    JSON.stringify(candidate),
  );
  if (result === 'invalid_current') throw new Error('Invalid active Week pointer');
  return result === 'tombstoned' ? 'tombstoned' : result === 'stale' ? 'stale' : 'activated';
}

async function lockWeekPublicationScope(tx: DbOrTransaction): Promise<void> {
  await tx
    .insert(mutationScopesInOps)
    .values({ scopeKey: WEEK_PUBLICATION_MUTATION_SCOPE, lastUsedAt: new Date() })
    .onConflictDoUpdate({
      target: mutationScopesInOps.scopeKey,
      set: { lastUsedAt: new Date() },
    });
  await tx
    .select({ scopeKey: mutationScopesInOps.scopeKey })
    .from(mutationScopesInOps)
    .where(eq(mutationScopesInOps.scopeKey, WEEK_PUBLICATION_MUTATION_SCOPE))
    .for('update');
}

/** Persist the canonical publication and outbox entry inside the caller's
 * transaction. Redis is deliberately staged only after that transaction
 * commits, so a cache outage cannot roll back PostgreSQL authority. */
export async function persistWeekPublication(
  tx: DbOrTransaction,
  english: WeekPublicationEnvelope,
  chinese: WeekPublicationEnvelope,
): Promise<WeekPublicationResult> {
  assertWeekPublication(english);
  assertWeekPublication(chinese);
  validateWeekLocalePair(english, chinese);
  await lockWeekPublicationScope(tx);

  const englishSerialized = serializeWeekPublication(english);
  const chineseSerialized = serializeWeekPublication(chinese);
  const englishBytes = Buffer.byteLength(englishSerialized, 'utf8');
  const chineseBytes = Buffer.byteLength(chineseSerialized, 'utf8');
  const englishHash = weekPublicationSha256(english);
  const chineseHash = weekPublicationSha256(chinese);
  const outboxId = randomUUID();
  let durableOutboxId: string = outboxId;
  const idempotencyKey = `briefing:week:${english.publicationId}:${english.revision}`;
  // UNAVAILABLE is deliberately fail-closed and therefore has no active
  // public pointer. REMOVED/OFFSEASON remain readable states so Web can
  // render the explicit correction/off-season treatment instead of silently
  // serving a previous revision.
  const activeState = english.state !== 'UNAVAILABLE';

  const latestRows = await tx
    .select({
      revision: sql<number>`COALESCE(MAX(${contentPublications.revision}), 0)`,
    })
    .from(contentPublications)
    .where(eq(contentPublications.scopeKey, 'week'));
  const latestRevision = Number(latestRows[0]?.revision ?? 0);
  const existingRows = await tx
    .select({
      publicationId: contentPublications.publicationId,
      revision: contentPublications.revision,
      localeManifest: contentPublications.localeManifest,
    })
    .from(contentPublications)
    .where(eq(contentPublications.publicationId, english.publicationId))
    .limit(1);
  const existing = existingRows[0];
  if (existing) {
    if (Number(existing.revision) !== english.revision) {
      throw new Error('Publication ID cannot change its revision');
    }
    if (english.revision !== latestRevision) {
      throw new Error('A retired Week revision cannot be reactivated');
    }
    const manifest = existing.localeManifest as {
      en?: { sha256?: string };
      'zh-CN'?: { sha256?: string };
    };
    if (manifest.en?.sha256 !== englishHash || manifest['zh-CN']?.sha256 !== chineseHash) {
      throw new Error('Published revision is immutable');
    }
  } else if (english.revision <= latestRevision) {
    throw new Error('Week publication revision must increase monotonically');
  }

  await tx
    .update(contentPublications)
    .set({ status: 'retired', servable: false, retiredAt: new Date() })
    .where(
      and(
        eq(contentPublications.scopeKey, 'week'),
        eq(contentPublications.status, 'active'),
        ne(contentPublications.publicationId, english.publicationId),
      ),
    );

  const publicationValues = {
    publicationId: english.publicationId,
    scopeKey: 'week' as const,
    revision: english.revision,
    schemaVersion: english.schemaVersion,
    seasonCode: english.event?.seasonCode ?? '2627',
    targetEventId: english.event?.eventId ?? null,
    eventName: english.event?.name ?? null,
    deadlineTime: english.event ? new Date(english.event.deadlineTime) : null,
    state: english.state,
    status: 'active' as const,
    servable: activeState,
    sourceCheckedAt: new Date(english.sourceCheckedAt),
    publishedAt: new Date(english.publishedAt),
    validUntil: english.validUntil ? new Date(english.validUntil) : null,
    localeManifest: {
      en: { bytes: englishBytes, sha256: englishHash },
      'zh-CN': { bytes: chineseBytes, sha256: chineseHash },
    },
  };
  if (existing) {
    await tx
      .update(contentPublications)
      .set({
        status: 'active',
        servable: activeState,
        state: english.state,
        validUntil: publicationValues.validUntil,
        retiredAt: null,
      })
      .where(eq(contentPublications.publicationId, english.publicationId));
  } else {
    await tx.insert(contentPublications).values(publicationValues);
  }

  await tx
    .insert(contentPublicationPayloads)
    .values({
      publicationId: english.publicationId,
      locale: 'en',
      payload: english,
      payloadBytes: englishBytes,
      payloadSha256: englishHash,
    })
    .onConflictDoUpdate({
      target: [contentPublicationPayloads.publicationId, contentPublicationPayloads.locale],
      set: { payload: english, payloadBytes: englishBytes, payloadSha256: englishHash },
    });
  await tx
    .insert(contentPublicationPayloads)
    .values({
      publicationId: english.publicationId,
      locale: 'zh-CN',
      payload: chinese,
      payloadBytes: chineseBytes,
      payloadSha256: chineseHash,
    })
    .onConflictDoUpdate({
      target: [contentPublicationPayloads.publicationId, contentPublicationPayloads.locale],
      set: { payload: chinese, payloadBytes: chineseBytes, payloadSha256: chineseHash },
    });

  await tx
    .insert(contentPublicationDependencies)
    .values([
      {
        publicationId: english.publicationId,
        dependencyKind: 'scope',
        dependencyKey: english.scopeKey,
        dependencyRevision: String(english.revision),
      },
      ...(english.event
        ? [
            {
              publicationId: english.publicationId,
              dependencyKind: 'event',
              dependencyKey: String(english.event.eventId),
              dependencyRevision: english.event.seasonCode,
            },
          ]
        : []),
    ])
    .onConflictDoNothing();

  const insertedOutbox = await tx
    .insert(contentPublicationOutbox)
    .values({
      outboxId,
      eventType: 'briefing.publication.activated',
      publicationId: english.publicationId,
      idempotencyKey,
      payload: {
        scopeKey: 'week',
        publicationId: english.publicationId,
        revision: english.revision,
        locales: ['en', 'zh-CN'],
      },
    })
    .onConflictDoNothing({ target: contentPublicationOutbox.idempotencyKey })
    .returning({ outboxId: contentPublicationOutbox.outboxId });
  if (insertedOutbox[0]) {
    durableOutboxId = insertedOutbox[0].outboxId;
  } else {
    const existingOutbox = await tx
      .select({ outboxId: contentPublicationOutbox.outboxId })
      .from(contentPublicationOutbox)
      .where(eq(contentPublicationOutbox.idempotencyKey, idempotencyKey))
      .limit(1);
    durableOutboxId = existingOutbox[0]?.outboxId ?? outboxId;
  }

  return {
    publicationId: english.publicationId,
    revision: english.revision,
    state: english.state,
    redisPublished: false,
    outboxId: durableOutboxId,
  };
}

export async function stageWeekPublication(
  english: WeekPublicationEnvelope,
  chinese: WeekPublicationEnvelope,
  persisted: WeekPublicationResult,
): Promise<WeekPublicationResult> {
  const englishSerialized = serializeWeekPublication(english);
  const chineseSerialized = serializeWeekPublication(chinese);
  const englishHash = weekPublicationSha256(english);
  const chineseHash = weekPublicationSha256(chinese);
  let redisPublished = false;
  try {
    const redis = await redisSingleton.getClient();
    await redis.set(weekPayloadKey(english.revision, 'en'), englishSerialized);
    await redis.set(weekPayloadKey(english.revision, 'zh-CN'), chineseSerialized);
    const pointerResult = await compareAndSetWeekPointer(redis, {
      schemaVersion: english.schemaVersion,
      publicationId: english.publicationId,
      revision: english.revision,
      state: english.state,
      locales: ['en', 'zh-CN'],
      hashes: { en: englishHash, 'zh-CN': chineseHash },
    });
    redisPublished = pointerResult !== 'stale';
  } catch {
    // PostgreSQL activation is durable. GraphQL must use its same-revision PG
    // fallback when Redis cannot be staged or switched.
    redisPublished = false;
  }

  try {
    await dispatchPublicationOutbox();
  } catch {
    // Outbox rows remain pending for a later dispatcher pass.
  }

  return { ...persisted, redisPublished };
}

export async function publishWeekPublication(
  english: WeekPublicationEnvelope,
  chinese: WeekPublicationEnvelope,
): Promise<WeekPublicationResult> {
  const db = await getDb();
  const persisted = await db.transaction((tx) => persistWeekPublication(tx, english, chinese));
  return stageWeekPublication(english, chinese, persisted);
}

export async function readActiveWeekPublication(
  locale: WeekLocale,
): Promise<WeekPublicationEnvelope | null> {
  const db = await getDb();
  const rows = await db
    .select({
      publicationId: contentBriefingActivePublication.publicationId,
      revision: contentBriefingActivePublication.revision,
    })
    .from(contentBriefingActivePublication)
    .where(eq(contentBriefingActivePublication.scopeKey, 'week'))
    .orderBy(desc(contentBriefingActivePublication.revision))
    .limit(1);
  const active = rows[0];
  if (!active) return null;
  const payloadRows = await db
    .select({ payload: contentPublicationPayloads.payload })
    .from(contentPublicationPayloads)
    .where(
      and(
        eq(contentPublicationPayloads.publicationId, active.publicationId),
        eq(contentPublicationPayloads.locale, locale),
      ),
    )
    .limit(1);
  const payload = payloadRows[0]?.payload;
  if (!payload) return null;
  assertWeekPublication(payload);
  if (payload.publicationId !== active.publicationId || payload.revision !== active.revision)
    return null;
  if (payload.validUntil && Date.parse(payload.validUntil) <= Date.now()) return null;
  return payload;
}
