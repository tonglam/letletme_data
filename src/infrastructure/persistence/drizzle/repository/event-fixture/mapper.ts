import {
  EventFixtureCreateInput,
  DbEventFixture,
  DbEventFixtureCreateInput,
} from 'repository/event-fixture/types';
import { EventFixtureId, RawEventFixture } from 'types/domain/event-fixture.type';
import { EventId } from 'types/domain/event.type';
import { TeamId } from 'types/domain/team.type';

export const mapDbEventFixtureToDomain = (dbEventFixture: DbEventFixture): RawEventFixture => ({
  id: dbEventFixture.id as EventFixtureId,
  code: dbEventFixture.code,
  eventId: dbEventFixture.eventId as EventId,
  kickoffTime: dbEventFixture.kickoffTime ?? new Date(),
  started: dbEventFixture.started,
  finished: dbEventFixture.finished,
  minutes: dbEventFixture.minutes,
  teamHId: dbEventFixture.teamHId as TeamId,
  teamHDifficulty: dbEventFixture.teamHDifficulty,
  teamHScore: dbEventFixture.teamHScore,
  teamAId: dbEventFixture.teamAId as TeamId,
  teamADifficulty: dbEventFixture.teamADifficulty,
  teamAScore: dbEventFixture.teamAScore,
});

export const mapDomainEventFixtureToDbCreate = (
  domainEventFixture: EventFixtureCreateInput,
): DbEventFixtureCreateInput => ({
  id: Number(domainEventFixture.id),
  code: domainEventFixture.code,
  eventId: domainEventFixture.eventId,
  kickoffTime: domainEventFixture.kickoffTime,
  started: domainEventFixture.started,
  finished: domainEventFixture.finished,
  minutes: domainEventFixture.minutes,
  teamHId: domainEventFixture.teamHId as TeamId,
  teamHDifficulty: domainEventFixture.teamHDifficulty,
  teamHScore: domainEventFixture.teamHScore,
  teamAId: domainEventFixture.teamAId as TeamId,
  teamADifficulty: domainEventFixture.teamADifficulty,
  teamAScore: domainEventFixture.teamAScore,
});
