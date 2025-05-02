import { RawEventLive } from '@app/domain/models/event-live.model';
import { EventId } from '@app/domain/models/event.type';
import { PlayerId, validatePlayerId } from '@app/domain/models/player.model';
import { LiveResponse } from '@app/infrastructure/external/fpl/schemas/live/live.schema';
import { safeStringToDecimal } from '@app/shared/utils/common.util';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';

export const mapEventLiveResponseToDomain = (
  event: number,
  elementIdInput: number | undefined | null,
  raw: LiveResponse,
): E.Either<string, RawEventLive> => {
  return pipe(
    validatePlayerId(elementIdInput),
    E.map((validElementId) => ({
      eventId: event as EventId,
      elementId: validElementId as PlayerId,
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
      inDreamTeam: raw.in_dreamteam,
      totalPoints: raw.total_points,
    })),
  );
};
