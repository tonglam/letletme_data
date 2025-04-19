import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import { pipe } from 'fp-ts/function';
import { MappedEventLive, validateEventLiveId } from 'src/types/domain/event-live.type';
import { safeStringToDecimal } from 'src/utils/common.util';
import { EventLiveResponse } from '../../schemas/event/live.schema';

export const mapEventLiveResponseToDomain = (
  event: number,
  raw: EventLiveResponse,
): E.Either<string, MappedEventLive> => {
  return pipe(
    E.Do,
    E.bind('element', () => validateEventLiveId(raw.element)),
    E.map(({ element }) => ({
      event: event,
      element,
      minutes: raw.minutes,
      goalsScored: raw.goals_scored,
      assists: raw.assists,
      cleanSheets: raw.clean_sheets,
      goalsConceded: raw.goals_conceded,
      ownGoals: raw.own_goals,
      penaltiesSaved: raw.penalties_saved,
      penaltiesMissed: raw.penalties_missed,
      yellowCards: raw.yellow_cards,
      redCards: raw.red_cards,
      saves: raw.saves,
      bonus: raw.bonus,
      bps: raw.bps,
      starts: raw.starts === 1,
      expectedGoals: pipe(
        safeStringToDecimal(raw.expected_goals),
        O.getOrElseW(() => null),
      ),
      expectedAssists: pipe(
        safeStringToDecimal(raw.expected_assists),
        O.getOrElseW(() => null),
      ),
      expectedGoalInvolvements: pipe(
        safeStringToDecimal(raw.expected_goal_involvements),
        O.getOrElseW(() => null),
      ),
      expectedGoalsConceded: pipe(
        safeStringToDecimal(raw.expected_goals_conceded),
        O.getOrElseW(() => null),
      ),
      mngWin: raw.mng_win,
      mngDraw: raw.mng_draw,
      mngLoss: raw.mng_loss,
      mngUnderdogWin: raw.mng_underdog_win,
      mngUnderdogDraw: raw.mng_underdog_draw,
      mngCleanSheets: raw.mng_clean_sheets,
      mngGoalsScored: raw.mng_goals_scored,
      inDreamTeam: raw.in_dream_team,
      totalPoints: raw.total_points,
    })),
  );
};
