import { randomUUID } from 'node:crypto';
import { and, desc, eq, ne } from 'drizzle-orm';

import { getDb } from '../../db/singleton';
import {
  contentBriefingActivePublication,
  contentPublicationOutbox,
  contentPublicationPayloads,
  contentPublications,
} from '../../db/schemas/content.schema';
import { redisSingleton } from '../../cache/singleton';
import {
  assertWeekPublication,
  serializeWeekPublication,
  validateWeekLocalePair,
  weekPublicationSha256,
  type WeekLocale,
  type WeekPublicationEnvelope,
} from '../contracts/week-publication';

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

export async function publishWeekPublication(
  english: WeekPublicationEnvelope,
  chinese: WeekPublicationEnvelope,
): Promise<WeekPublicationResult> {
  assertWeekPublication(english);
  assertWeekPublication(chinese);
  validateWeekLocalePair(english, chinese);

  const db = await getDb();
  const englishSerialized = serializeWeekPublication(english);
  const chineseSerialized = serializeWeekPublication(chinese);
  const englishBytes = Buffer.byteLength(englishSerialized, 'utf8');
  const chineseBytes = Buffer.byteLength(chineseSerialized, 'utf8');
  const englishHash = weekPublicationSha256(english);
  const chineseHash = weekPublicationSha256(chinese);
  const outboxId = randomUUID();
  let durableOutboxId: string = outboxId;
  const idempotencyKey = `briefing:week:${english.publicationId}:${english.revision}`;
  const activeState = english.state !== 'UNAVAILABLE' && english.state !== 'REMOVED';

  await db.transaction(async (tx) => {
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

    await tx
      .insert(contentPublications)
      .values({
        publicationId: english.publicationId,
        scopeKey: 'week',
        revision: english.revision,
        schemaVersion: english.schemaVersion,
        seasonCode: english.event?.seasonCode ?? '2627',
        targetEventId: english.event?.eventId ?? null,
        eventName: english.event?.name ?? null,
        deadlineTime: english.event ? new Date(english.event.deadlineTime) : null,
        state: english.state,
        status: 'active',
        servable: activeState,
        sourceCheckedAt: new Date(english.sourceCheckedAt),
        publishedAt: new Date(english.publishedAt),
        validUntil: english.validUntil ? new Date(english.validUntil) : null,
        localeManifest: {
          en: { bytes: englishBytes, sha256: englishHash },
          'zh-CN': { bytes: chineseBytes, sha256: chineseHash },
        },
      })
      .onConflictDoUpdate({
        target: contentPublications.publicationId,
        set: {
          status: 'active',
          servable: activeState,
          state: english.state,
          validUntil: english.validUntil ? new Date(english.validUntil) : null,
          localeManifest: {
            en: { bytes: englishBytes, sha256: englishHash },
            'zh-CN': { bytes: chineseBytes, sha256: chineseHash },
          },
        },
      });

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
  });

  let redisPublished = false;
  try {
    const redis = await redisSingleton.getClient();
    await redis.set(weekPayloadKey(english.revision, 'en'), englishSerialized);
    await redis.set(weekPayloadKey(english.revision, 'zh-CN'), chineseSerialized);
    await redis.set(
      WEEK_ACTIVE_POINTER_KEY,
      JSON.stringify({
        schemaVersion: english.schemaVersion,
        publicationId: english.publicationId,
        revision: english.revision,
        state: english.state,
        locales: ['en', 'zh-CN'],
        hashes: { en: englishHash, 'zh-CN': chineseHash },
      }),
    );
    redisPublished = true;
  } catch {
    // PostgreSQL activation is durable. GraphQL must use its same-revision PG
    // fallback when Redis cannot be staged or switched.
    redisPublished = false;
  }

  return {
    publicationId: english.publicationId,
    revision: english.revision,
    state: english.state,
    redisPublished,
    outboxId: durableOutboxId,
  };
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
  return payload;
}
