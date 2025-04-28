import { ElementResponse } from 'data/fpl/schemas/bootstrap/element.schema';
import { format } from 'date-fns';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import { EventId } from 'types/domain/event.type';
import { RawPlayerStat } from 'types/domain/player-stat.type';
import { PlayerValueTrack } from 'types/domain/player-value-track.type';
import { SourcePlayerValue } from 'types/domain/player-value.type';
import { PlayerId, PlayerType, RawPlayer, validatePlayerId } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';
import { safeStringToDecimal, safeStringToNumber } from 'utils/common.util';

export const mapElementResponseToPlayer = (raw: ElementResponse): E.Either<string, RawPlayer> =>
  pipe(
    E.Do,
    E.bind('id', () => validatePlayerId(raw.id)),
    E.map((data): RawPlayer => {
      return {
        id: data.id as PlayerId,
        code: raw.code,
        type: raw.element_type as PlayerType,
        teamId: raw.team as TeamId,
        price: raw.now_cost,
        startPrice: raw.now_cost - raw.cost_change_start,
        firstName: raw.first_name,
        secondName: raw.second_name,
        webName: raw.web_name,
      };
    }),
  );

export const mapElementResponseToPlayerValue = (
  eventId: EventId,
  raw: ElementResponse,
): E.Either<string, SourcePlayerValue> => {
  const currentDateStr = format(new Date(), 'yyyyMMdd');

  return pipe(
    E.Do,
    E.bind('element', () => validatePlayerId(raw.id)),
    E.map(
      ({ element }): SourcePlayerValue => ({
        elementId: element as PlayerId,
        elementType: raw.element_type as PlayerType,
        eventId: eventId as EventId,
        value: raw.now_cost,
        changeDate: currentDateStr,
      }),
    ),
  );
};

export const mapElementResponseToPlayerValueTrack = (
  eventId: EventId,
  raw: ElementResponse,
): E.Either<string, PlayerValueTrack> => {
  const currentDate = new Date();
  const currentDateStr = format(currentDate, 'yyyyMMdd');
  const currentHour = currentDate.getHours();

  return pipe(
    E.Do,
    E.bind('element', () => validatePlayerId(raw.id)),
    E.map(
      ({ element }): PlayerValueTrack => ({
        hourIndex: currentHour,
        date: currentDateStr,
        eventId: eventId as EventId,
        elementId: element as PlayerId,
        elementType: raw.element_type as PlayerType,
        teamId: raw.team as TeamId,
        chanceOfPlayingThisRound: raw.chance_of_playing_this_round ?? null,
        chanceOfPlayingNextRound: raw.chance_of_playing_next_round ?? null,
        transfersIn: raw.transfers_in,
        transfersOut: raw.transfers_out,
        transfersInEvent: raw.transfers_in_event,
        transfersOutEvent: raw.transfers_out_event,
        selectedBy: pipe(
          safeStringToNumber(raw.selected_by_percent),
          O.getOrElseW(() => null),
        ),
        value: raw.now_cost,
      }),
    ),
  );
};

export const mapElementResponseToPlayerStat = (
  eventId: EventId,
  raw: ElementResponse,
): E.Either<string, RawPlayerStat> =>
  pipe(
    E.Do,
    E.bind('element', () => validatePlayerId(raw.id)),
    E.map(
      ({ element }): RawPlayerStat => ({
        eventId: eventId as EventId,
        elementId: element as PlayerId,
        elementType: raw.element_type as PlayerType,
        totalPoints: raw.total_points,
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
        mngWin: raw.mng_win,
        mngDraw: raw.mng_draw,
        mngLoss: raw.mng_loss,
        mngUnderdogWin: raw.mng_underdog_win,
        mngUnderdogDraw: raw.mng_underdog_draw,
        mngCleanSheets: raw.mng_clean_sheets,
        mngGoalsScored: raw.mng_goals_scored,
      }),
    ),
  );
