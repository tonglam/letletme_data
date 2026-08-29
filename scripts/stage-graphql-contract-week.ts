/* eslint-disable no-console */
import postgres from 'postgres';

import {
  stageWeekPublication,
  type WeekPublicationResult,
} from '../src/content/publication/week-publication';
import { redisSingleton } from '../src/cache/singleton';

type WeekPayloadRow = {
  publication_id: string;
  revision: number;
  state: string;
  locale: string;
  payload: unknown;
};

function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error('DATABASE_URL is required');
  return value;
}

function assertPayloadRows(rows: readonly WeekPayloadRow[]): {
  readonly english: WeekPayloadRow;
  readonly chinese: WeekPayloadRow;
} {
  if (rows.length !== 2) {
    throw new Error(`Expected exactly two active Week locale payloads, got ${rows.length}`);
  }
  const english = rows.find((row) => row.locale === 'en');
  const chinese = rows.find((row) => row.locale === 'zh-CN');
  if (!english || !chinese) throw new Error('Active Week publication must contain en and zh-CN');
  if (
    english.publication_id !== chinese.publication_id ||
    Number(english.revision) !== Number(chinese.revision) ||
    english.state !== chinese.state
  ) {
    throw new Error('Active Week locale payloads must share publication, revision, and state');
  }
  return { english, chinese };
}

async function main(): Promise<void> {
  const database = postgres(requireDatabaseUrl(), { max: 1, prepare: false });
  try {
    const rows = await database<WeekPayloadRow[]>`
      WITH active AS (
        SELECT
          publication.publication_id,
          publication.revision,
          publication.state
        FROM content.publications publication
        WHERE publication.scope_key = 'week'
          AND publication.status = 'active'
          AND publication.servable
        ORDER BY publication.revision DESC
        LIMIT 1
      )
      SELECT
        active.publication_id,
        active.revision,
        active.state,
        payload.locale,
        payload.payload
      FROM active
      JOIN content.publication_payloads payload
        ON payload.publication_id = active.publication_id
      ORDER BY payload.locale
    `;
    const { english, chinese } = assertPayloadRows(rows);
    const staged: WeekPublicationResult = await stageWeekPublication(
      english.payload as Parameters<typeof stageWeekPublication>[0],
      chinese.payload as Parameters<typeof stageWeekPublication>[1],
      {
        publicationId: english.publication_id,
        revision: Number(english.revision),
        state: english.state as WeekPublicationResult['state'],
        redisPublished: false,
        // The fixture already inserted the durable content outbox. This value
        // is only carried through the post-commit Redis staging helper.
        outboxId: '00000000-0000-0000-0000-000000000000',
      },
    );
    if (!staged.redisPublished) {
      throw new Error('Week Redis pointer was not activated for the contract fixture');
    }
    console.log(
      JSON.stringify(
        {
          status: 'graphql_contract_week_staged',
          publicationId: staged.publicationId,
          revision: staged.revision,
          state: staged.state,
          redisPublished: staged.redisPublished,
        },
        null,
        2,
      ),
    );
  } finally {
    await redisSingleton.disconnect();
    await database.end();
  }
}

main().catch((error) => {
  console.error('[graphql-contract-week] failed', error);
  process.exitCode = 1;
});
