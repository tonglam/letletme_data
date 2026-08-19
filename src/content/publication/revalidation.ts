import { createHmac, randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { getDb } from '../../db/singleton';
import { contentPublicationOutbox } from '../../db/schemas/content.schema';
import { getContentRuntimeFlags } from '../config';

export function signRevalidationPayload(input: {
  timestamp: string;
  nonce: string;
  body: string;
  secret: string;
}): string {
  return createHmac('sha256', input.secret)
    .update(`${input.timestamp}.${input.nonce}.${input.body}`, 'utf8')
    .digest('hex');
}

export async function dispatchPublicationOutbox(limit = 20): Promise<number> {
  const flags = getContentRuntimeFlags();
  if (!flags.revalidationUrl || !flags.revalidationSecret) return 0;
  const db = await getDb();
  const rows = await db
    .select({
      outboxId: contentPublicationOutbox.outboxId,
      idempotencyKey: contentPublicationOutbox.idempotencyKey,
      payload: contentPublicationOutbox.payload,
    })
    .from(contentPublicationOutbox)
    .where(isNull(contentPublicationOutbox.deliveredAt))
    .orderBy(asc(contentPublicationOutbox.createdAt))
    .limit(Math.max(1, Math.min(limit, 100)));
  let delivered = 0;
  for (const row of rows) {
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const body = JSON.stringify(row.payload);
    const signature = signRevalidationPayload({
      timestamp,
      nonce,
      body,
      secret: flags.revalidationSecret,
    });
    try {
      const response = await fetch(flags.revalidationUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-briefing-timestamp': timestamp,
          'x-briefing-nonce': nonce,
          'x-briefing-signature': signature,
          'x-briefing-idempotency-key': row.idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`revalidation status ${response.status}`);
      await db
        .update(contentPublicationOutbox)
        .set({ deliveredAt: new Date(), attempts: sql`${contentPublicationOutbox.attempts} + 1` })
        .where(eq(contentPublicationOutbox.outboxId, row.outboxId));
      delivered += 1;
    } catch {
      await db
        .update(contentPublicationOutbox)
        .set({ attempts: sql`${contentPublicationOutbox.attempts} + 1` })
        .where(
          and(
            eq(contentPublicationOutbox.outboxId, row.outboxId),
            isNull(contentPublicationOutbox.deliveredAt),
          ),
        );
    }
  }
  return delivered;
}
