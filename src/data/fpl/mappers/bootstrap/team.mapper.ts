import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Team, TeamId, validateTeamId } from 'src/types/domain/team.type';

import { TeamResponse } from '../../schemas/bootstrap/team.schema';

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
