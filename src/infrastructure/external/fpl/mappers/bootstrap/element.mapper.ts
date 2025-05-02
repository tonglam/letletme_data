import { RawPlayerStat } from '@app/domain/models/player-stat.model';
import { PlayerValueTrack } from '@app/domain/models/player-value-track.model';
import { SourcePlayerValue } from '@app/domain/models/player-value.model';
import { RawPlayer } from '@app/domain/models/player.model';
import { EventID, PlayerID, TeamID, validatePlayerId } from '@app/domain/types/id.types';
import { PlayerTypeID } from '@app/domain/types/type.types';
import { ElementResponse } from '@app/infrastructure/external/fpl/schemas/bootstrap/element.schema';
import { safeStringToNumber } from '@app/shared/utils/common.util';
import { format } from 'date-fns';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';

export const mapElementResponseToPlayer = (raw: ElementResponse): E.Either<string, RawPlayer> =>
  pipe(
    E.Do,
    E.bind('id', () => validatePlayerId(raw.id)),
    E.map((data): RawPlayer => {
      return {
        id: data.id as PlayerID,
        code: raw.code,
        type: raw.element_type as PlayerTypeID,
        teamId: raw.team as TeamID,
        price: raw.now_cost,
        startPrice: raw.now_cost - raw.cost_change_start,
        firstName: raw.first_name,
        secondName: raw.second_name,
        webName: raw.web_name,
      };
    }),
  );

export const mapElementResponseToPlayerValue = (
  eventId: EventID,
  raw: ElementResponse,
): E.Either<string, SourcePlayerValue> => {
  const currentDateStr = format(new Date(), 'yyyyMMdd');

  return pipe(
    E.Do,
    E.bind('element', () => validatePlayerId(raw.id)),
    E.map(
      ({ element }): SourcePlayerValue => ({
        elementId: element as PlayerID,
        elementType: raw.element_type as PlayerTypeID,
        eventId: eventId as EventID,
        value: raw.now_cost,
        changeDate: currentDateStr,
      }),
    ),
  );
};

export const mapElementResponseToPlayerValueTrack = (
  eventId: EventID,
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
        eventId: eventId as EventID,
        elementId: element as PlayerID,
        elementType: raw.element_type as PlayerTypeID,
        teamId: raw.team as TeamID,
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
  eventId: EventID,
  raw: ElementResponse,
): E.Either<string, RawPlayerStat> =>
  pipe(
    E.Do,
    E.bind('element', () => validatePlayerId(raw.id)),
    E.map(
      ({ element }): RawPlayerStat => ({
        eventId: eventId as EventID,
        elementId: element as PlayerID,
        elementType: raw.element_type as PlayerTypeID,
        totalPoints: raw.total_points,
        form: raw.form ?? null,
        influence: raw.influence ?? null,
        creativity: raw.creativity ?? null,
        threat: raw.threat ?? null,
        ictIndex: raw.ict_index ?? null,
        expectedGoals: raw.expected_goals ?? null,
        expectedAssists: raw.expected_assists ?? null,
        expectedGoalInvolvements: raw.expected_goal_involvements ?? null,
        expectedGoalsConceded: raw.expected_goals_conceded ?? null,
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
