import { RawEventFixture, validateEventFixtureId } from '@app/domain/models/event-fixture.model';
import { EventID, TeamID } from '@app/domain/shared/types/id.types';
import { EventFixtureResponse } from '@app/infrastructure/external/fpl/schemas/fixture/fixture.schema';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

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
        eventId: raw.event as EventID,
        kickoffTime: raw.kickoff_time ? new Date(raw.kickoff_time) : null,
        started: raw.started,
        finished: raw.finished,
        minutes: raw.minutes,
        teamHId: raw.team_h as TeamID,
        teamHDifficulty: raw.team_h_difficulty,
        teamHScore: raw.team_h_score,
        teamAId: raw.team_a as TeamID,
        teamADifficulty: raw.team_a_difficulty,
        teamAScore: raw.team_a_score,
      }),
    ),
  );
};
