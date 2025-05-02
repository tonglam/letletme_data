import { TeamID, validateTeamId } from '@app/domain/types/id.types';
import { TeamResponse } from '@app/infrastructure/external/fpl/schemas/bootstrap/team.schema';
import { Team } from '@app/shared/types/domain/team.type';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

export const mapTeamResponseToTeam = (raw: TeamResponse): E.Either<string, Team> =>
  pipe(
    E.Do,
    E.bind('id', () => validateTeamId(raw.id)),
    E.map((data) => {
      return {
        id: data.id as TeamID,
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
