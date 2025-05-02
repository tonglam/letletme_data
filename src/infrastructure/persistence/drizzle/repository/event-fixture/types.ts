import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/event-fixture.schema';
import { EventFixtureId, RawEventFixture, RawEventFixtures } from 'types/domain/event-fixture.type';
import { EventId } from 'types/domain/event.type';
import { TeamId } from 'types/domain/team.type';
import { DBError } from 'types/error.type';

export type DbEventFixture = InferSelectModel<typeof schema.eventFixtures>;
export type DbEventFixtureCreateInput = InferInsertModel<typeof schema.eventFixtures>;

export type EventFixtureCreateInput = Omit<RawEventFixture, 'id'> & { id: EventFixtureId };
export type EventFixtureCreateInputs = readonly EventFixtureCreateInput[];

export interface EventFixtureRepository {
  readonly findByTeamId: (teamId: TeamId) => TE.TaskEither<DBError, RawEventFixtures>;
  readonly findByEventId: (eventId: EventId) => TE.TaskEither<DBError, RawEventFixtures>;
  readonly saveBatchByEventId: (
    eventFixtureInputs: EventFixtureCreateInputs,
  ) => TE.TaskEither<DBError, RawEventFixtures>;
  readonly deleteByEventId: (eventId: EventId) => TE.TaskEither<DBError, void>;
}
