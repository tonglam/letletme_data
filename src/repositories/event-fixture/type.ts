import { Prisma, EventFixture as PrismaEventFixtureType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import {
  EventFixtureId,
  SourceEventFixture,
  SourceEventFixtures,
} from 'src/types/domain/event-fixture.type';
import { DBError } from 'src/types/error.type';

export type PrismaEventFixtureCreateInput = Prisma.EventFixtureCreateInput;
export type PrismaEventFixture = PrismaEventFixtureType;

export type EventFixtureCreateInput = Omit<SourceEventFixture, 'id'> & { id: EventFixtureId };
export type EventFixtureCreateInputs = readonly EventFixtureCreateInput[];

export interface EventFixtureRepository {
  readonly findById: (id: EventFixtureId) => TE.TaskEither<DBError, SourceEventFixture>;
  readonly findAll: () => TE.TaskEither<DBError, SourceEventFixtures>;
  readonly saveBatch: (
    events: EventFixtureCreateInputs,
  ) => TE.TaskEither<DBError, SourceEventFixtures>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}
