import { TeamResponse } from 'data/fpl/schemas/bootstrap/team.schema';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Team, TeamId, validateTeamId } from 'types/domain/team.type';

export const mapTeamResponseToTeam = (raw: TeamResponse): E.Either<string, Team> =>
  pipe(
    E.Do,
    E.bind('id', () => validateTeamId(raw.id)),
    E.map((data) => {
      return {
        id: data.id as TeamId,
        code: raw.code,
        name: raw.name,
        shortName: raw.short_name,
        strength: raw.strength,
        position: raw.position,
        points: raw.points,
        win: raw.win,
        draw: raw.draw,
        loss: raw.loss,
      };
    }),
  );
