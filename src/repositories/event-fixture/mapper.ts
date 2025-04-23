import { SourceEventFixture } from 'src/types/domain/event-fixture.type';
import { EventFixtureId } from 'src/types/domain/event-fixture.type';

import { EventFixtureCreateInput, PrismaEventFixture, PrismaEventFixtureCreateInput } from './type';

export const mapPrismaEventFixtureToDomain = (
  prismaEventFixture: PrismaEventFixture,
): SourceEventFixture => ({
  id: prismaEventFixture.id as EventFixtureId,
  code: prismaEventFixture.code,
  event: prismaEventFixture.event,
  kickoffTime: prismaEventFixture.kickoffTime ?? new Date(),
  started: prismaEventFixture.started,
  finished: prismaEventFixture.finished,
  minutes: prismaEventFixture.minutes,
  teamH: prismaEventFixture.teamH ?? null,
  teamHDifficulty: prismaEventFixture.teamHDifficulty,
  teamHScore: prismaEventFixture.teamHScore,
  teamA: prismaEventFixture.teamA ?? null,
  teamADifficulty: prismaEventFixture.teamADifficulty,
  teamAScore: prismaEventFixture.teamAScore,
});

export const mapDomainEventFixtureToPrismaCreate = (
  domainEventFixture: EventFixtureCreateInput,
): PrismaEventFixtureCreateInput => ({
  id: Number(domainEventFixture.id),
  code: domainEventFixture.code,
  event: domainEventFixture.event,
  kickoffTime: domainEventFixture.kickoffTime,
  started: domainEventFixture.started,
  finished: domainEventFixture.finished,
  minutes: domainEventFixture.minutes,
  teamH: domainEventFixture.teamH,
  teamHDifficulty: domainEventFixture.teamHDifficulty,
  teamHScore: domainEventFixture.teamHScore,
  teamA: domainEventFixture.teamA,
});
