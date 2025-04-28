import { LiveResponse } from 'data/fpl/schemas/live/live.schema';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import { RawEventLive } from 'types/domain/event-live.type';
import { EventId } from 'types/domain/event.type';
import { PlayerId, validatePlayerId } from 'types/domain/player.type';
import { safeStringToDecimal } from 'utils/common.util';

export const mapEventLiveResponseToDomain = (
  event: number,
  raw: LiveResponse,
): E.Either<string, RawEventLive> => {
  return pipe(
    E.Do,
    E.bind('elementId', () => validatePlayerId(raw.element)),
    E.map(({ elementId }) => ({
      eventId: event as EventId,
      elementId: elementId as PlayerId,
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
