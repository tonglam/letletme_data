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
        strengthOverallHome: raw.strength_overall_home,
        strengthOverallAway: raw.strength_overall_away,
        strengthAttackHome: raw.strength_attack_home,
        strengthAttackAway: raw.strength_attack_away,
        strengthDefenceHome: raw.strength_defence_home,
        strengthDefenceAway: raw.strength_defence_away,
        pulseId: raw.pulse_id,
        played: raw.played,
        position: raw.position,
        points: raw.points,
        form: raw.form,
        win: raw.win,
        draw: raw.draw,
        loss: raw.loss,
        teamDivision: raw.team_division,
        unavailable: raw.unavailable,
      } satisfies Team;
    }),
  );
