import { format } from 'date-fns';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import { ElementType } from 'src/types/base.type';
import { PlayerStat } from 'src/types/domain/player-stat.type';
import { MappedPlayerValue } from 'src/types/domain/player-value.type';
import { Player, PlayerId } from 'src/types/domain/player.type';
import { safeStringToDecimal, safeStringToNumber } from 'src/utils/common.util';

import { ElementResponse } from '../../schemas/bootstrap/element.schema';

export const mapElementResponseToPlayer = (raw: ElementResponse): E.Either<string, Player> =>
  pipe(
    E.Do,
    E.bind('id', () => E.right(raw.id as PlayerId)),
    E.bind('elementType', () => E.right(raw.element_type as ElementType)),
    E.map((data): Player => {
      return {
        id: data.id,
        elementCode: raw.code,
        price: raw.now_cost / 10,
        startPrice: (raw.now_cost - raw.cost_change_start) / 10,
        elementType: data.elementType,
        firstName: raw.first_name,
        secondName: raw.second_name,
        webName: raw.web_name,
        teamId: raw.team,
        mngWin: raw.mng_win,
        mngDraw: raw.mng_draw,
        mngLoss: raw.mng_loss,
        mngUnderdogWin: raw.mng_underdog_win,
        mngUnderdogDraw: raw.mng_underdog_draw,
        mngCleanSheets: raw.mng_clean_sheets,
        mngGoalsScored: raw.mng_goals_scored,
      };
    }),
  );

export const mapElementResponseToPlayerStat = (
  raw: ElementResponse,
  eventId: number,
): E.Either<string, Omit<PlayerStat, 'id'>> =>
  pipe(
    E.Do,
    E.bind('elementId', () => E.right(raw.id as PlayerId)),
    E.map(
      ({ elementId }): Omit<PlayerStat, 'id'> => ({
        eventId: eventId,
        elementId: elementId as number,
        teamId: raw.team,
        form: pipe(
          safeStringToNumber(raw.form),
          O.getOrElseW(() => null),
        ),
        influence: pipe(
          safeStringToNumber(raw.influence),
          O.getOrElseW(() => null),
        ),
        creativity: pipe(
          safeStringToNumber(raw.creativity),
          O.getOrElseW(() => null),
        ),
        threat: pipe(
          safeStringToNumber(raw.threat),
          O.getOrElseW(() => null),
        ),
        ictIndex: pipe(
          safeStringToNumber(raw.ict_index),
          O.getOrElseW(() => null),
        ),
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
        minutes: raw.minutes,
        goalsScored: raw.goals_scored,
        assists: raw.assists,
        cleanSheets: raw.clean_sheets,
        goalsConceded: raw.goals_conceded,
        ownGoals: raw.own_goals,
        penaltiesSaved: raw.penalties_saved,
        yellowCards: raw.yellow_cards,
        redCards: raw.red_cards,
        saves: raw.saves,
        bonus: raw.bonus,
        bps: raw.bps,
        starts: raw.starts,
        influenceRank: raw.influence_rank,
        influenceRankType: raw.influence_rank_type,
        creativityRank: raw.creativity_rank,
        creativityRankType: raw.creativity_rank_type,
        threatRank: raw.threat_rank,
        threatRankType: raw.threat_rank_type,
        ictIndexRank: raw.ict_index_rank,
        ictIndexRankType: raw.ict_index_rank_type,
        expectedGoalsPer90: null,
        savesPer90: null,
        expectedAssistsPer90: null,
        expectedGoalInvolvementsPer90: null,
        totalPoints: raw.total_points,
      }),
    ),
  );

export const mapElementResponseToPlayerValue = (
  raw: ElementResponse,
  eventId: number,
): E.Either<string, MappedPlayerValue> => {
  const currentDateStr = format(new Date(), 'yyyyMMdd');
  const value = raw.now_cost / 10;

  return pipe(
    E.Do,
    E.bind('elementId', () => E.right(raw.id)),
    E.bind('elementType', () => E.right(raw.element_type as ElementType)),
    E.map(
      ({ elementId, elementType }): MappedPlayerValue => ({
        elementId: elementId,
        elementType: elementType,
        eventId: eventId,
        value: value,
        changeDate: currentDateStr,
      }),
    ),
  );
};
