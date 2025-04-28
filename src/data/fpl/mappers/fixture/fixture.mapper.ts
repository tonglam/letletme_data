import { EventFixtureResponse } from 'data/fpl/schemas/fixture/fixture.schema';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { RawEventFixture, validateEventFixtureId } from 'types/domain/event-fixture.type';
import { EventId } from 'types/domain/event.type';
import { TeamId } from 'types/domain/team.type';

export const mapEventFixtureResponseToDomain = (
  raw: EventFixtureResponse,
): E.Either<string, RawEventFixture> => {
  return pipe(
    E.Do,
    E.bind('id', () => validateEventFixtureId(raw.id)),
    E.map(
      ({ id }): RawEventFixture => ({
        id: id,
        code: raw.code,
        eventId: raw.event as EventId,
        kickoffTime: raw.kickoff_time ? new Date(raw.kickoff_time) : null,
        started: raw.started,
        finished: raw.finished,
        minutes: raw.minutes,
        teamHId: raw.team_h as TeamId,
        teamHDifficulty: raw.team_h_difficulty,
        teamHScore: raw.team_h_score,
        teamAId: raw.team_a as TeamId,
        teamADifficulty: raw.team_a_difficulty,
        teamAScore: raw.team_a_score,
      }),
    ),
  );
};
