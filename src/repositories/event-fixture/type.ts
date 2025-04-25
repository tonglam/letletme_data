import { Prisma, EventFixture as PrismaEventFixtureType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import {
  EventFixtureId,
  RawEventFixture,
  RawEventFixtures,
} from 'src/types/domain/event-fixture.type';
import { EventId } from 'src/types/domain/event.type';
import { TeamId } from 'src/types/domain/team.type';
import { DBError } from 'src/types/error.type';

export type PrismaEventFixtureCreateInput = Prisma.EventFixtureCreateInput;
export type PrismaEventFixture = PrismaEventFixtureType;

export type EventFixtureCreateInput = Omit<RawEventFixture, 'id'> & { id: EventFixtureId };
export type EventFixtureCreateInputs = readonly EventFixtureCreateInput[];

export interface EventFixtureRepository {
  readonly findByTeamId: (teamId: TeamId) => TE.TaskEither<DBError, RawEventFixtures>;
  readonly findByEventId: (eventId: EventId) => TE.TaskEither<DBError, RawEventFixtures>;
  readonly saveBatchByEventId: (
    eventFixtures: EventFixtureCreateInputs,
  ) => TE.TaskEither<DBError, RawEventFixtures>;
  readonly deleteByEventId: (eventId: EventId) => TE.TaskEither<DBError, void>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}
