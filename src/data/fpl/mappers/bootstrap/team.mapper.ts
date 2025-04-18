import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Team, TeamId } from 'src/types/domain/team.type';
import { TeamResponse } from '../../schemas/bootstrap/team.schema';

export const mapTeamResponseToTeam = (raw: TeamResponse): E.Either<string, Team> =>
  pipe(
    E.Do,
    E.bind('id', () => E.right(raw.id as TeamId)),
    E.map((data) => {
      return {
        id: data.id,
        code: raw.code,
        name: raw.name,
        shortName: raw.short_name,
        strength: raw.strength,
        position: raw.position,
        points: raw.points,
        win: raw.win,
        draw: raw.draw,
        loss: raw.loss,
      } satisfies Team;
    }),
  );
