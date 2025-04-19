import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { EventFixture, validateEventFixtureId } from 'src/types/domain/event-fixture.type';
import { EventFixtureResponse } from '../../schemas/fixture/fixture.schema';

export const mapEventFixtureResponseToDomain = (
  raw: EventFixtureResponse,
): E.Either<string, EventFixture> => {
  return pipe(
    E.Do,
    E.bind('id', () => validateEventFixtureId(raw.id)),
    E.map(
      ({ id }): EventFixture => ({
        id: id,
        code: raw.code,
        event: raw.event,
        kickoffTime: raw.kickoff_time ? new Date(raw.kickoff_time) : null,
        started: raw.started,
        finished: raw.finished,
        minutes: raw.minutes,
        teamH: raw.team_h,
        teamHDifficulty: raw.team_h_difficulty,
        teamHScore: raw.team_h_score,
        teamA: raw.team_a,
        teamADifficulty: raw.team_a_difficulty,
        teamAScore: raw.team_a_score,
      }),
    ),
  );
};
