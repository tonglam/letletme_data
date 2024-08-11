import { Prisma } from '@prisma/client';
import { BootStrap } from '../../../constant/bootStrap.type';
import { Element, ElementSchema } from '../../../constant/element.type';
import { prisma } from '../../../index';
import { getCurrentEvent } from '../../../utils/fpl.utils';
import { getChangedFields } from '../../base/mongoDB';
import { upsert } from '../base';

const eventId = getCurrentEvent();

async function mapEventPlayerStats(): Promise<Prisma.JsonObject> {
  try {
    const playerStats = await prisma.playerStat.findMany({
      where: {
        event_id: eventId,
      },
    });

    const playerStatMap: Prisma.JsonObject = {};

    for (const stat of playerStats) {
      const transformedStat = transformData(stat as unknown as Element);
      transformedStat.element_id = stat.element_id;
      playerStatMap[stat.element_id.toString()] = transformedStat;
    }

    return playerStatMap;
  } catch (error) {
    console.error('Error fetching player stats:', error);
    throw error;
  }
}

const transformData = (data: Element) => ({
  event_id: eventId,
  element_id: data.id,
  element_code: data.code,
  chance_of_playing_next_round: data.chance_of_playing_next_round,
  chance_of_playing_this_round: data.chance_of_playing_this_round,
  cost_change_event: data.cost_change_event,
  cost_change_event_fall: data.cost_change_event_fall,
  cost_change_start: data.cost_change_start,
  cost_change_start_fall: data.cost_change_start_fall,
  dreamteam_count: data.dreamteam_count,
  element_type: data.element_type,
  ep_next: data.ep_next,
  ep_this: data.ep_this,
  event_points: data.event_points,
  form: data.form,
  in_dreamteam: data.in_dreamteam,
  news: data.news,
  news_added: data.news_added || null,
  now_cost: data.now_cost,
  photo: data.photo,
  points_per_game: data.points_per_game,
  selected_by_percent: parseFloat(data.selected_by_percent),
  special: data.special,
  squad_number: data.squad_number,
  status: data.status,
  team_id: data.team,
  total_points: data.total_points,
  transfers_in: data.transfers_in,
  transfers_in_event: data.transfers_in_event,
  transfers_out: data.transfers_out,
  transfers_out_event: data.transfers_out_event,
  value_form: data.value_form,
  value_season: data.value_season,
  minutes: data.minutes,
  goals_scored: data.goals_scored,
  assists: data.assists,
  clean_sheets: data.clean_sheets,
  goals_conceded: data.goals_conceded,
  own_goals: data.own_goals,
  penalties_saved: data.penalties_saved,
  penalties_missed: data.penalties_missed,
  yellow_cards: data.yellow_cards,
  red_cards: data.red_cards,
  saves: data.saves,
  bonus: data.bonus,
  bps: data.bps,
  influence: data.influence,
  creativity: data.creativity,
  threat: data.threat,
  ict_index: data.ict_index,
  starts: data.starts,
  expected_goals: data.expected_goals,
  expected_assists: data.expected_assists,
  expected_goal_involvements: data.expected_goal_involvements,
  expected_goals_conceded: data.expected_goals_conceded,
  influence_rank: data.influence_rank,
  influence_rank_type: data.influence_rank_type,
  creativity_rank: data.creativity_rank,
  creativity_rank_type: data.creativity_rank_type,
  threat_rank: data.threat_rank,
  threat_rank_type: data.threat_rank_type,
  ict_index_rank: data.ict_index_rank,
  ict_index_rank_type: data.ict_index_rank_type,
  corners_and_indirect_freekicks_order: data.corners_and_indirect_freekicks_order,
  corners_and_indirect_freekicks_text: data.corners_and_indirect_freekicks_text,
  direct_freekicks_order: data.direct_freekicks_order,
  direct_freekicks_text: data.direct_freekicks_text,
  penalties_order: data.penalties_order,
  penalties_text: data.penalties_text,
  expected_goals_per_90: data.expected_goals_per_90,
  saves_per_90: data.saves_per_90,
  expected_assists_per_90: data.expected_assists_per_90,
  expected_goal_involvements_per_90: data.expected_goal_involvements_per_90,
  expected_goals_conceded_per_90: data.expected_goals_conceded_per_90,
  goals_conceded_per_90: data.goals_conceded_per_90,
  now_cost_rank: data.now_cost_rank,
  now_cost_rank_type: data.now_cost_rank_type,
  form_rank: data.form_rank,
  form_rank_type: data.form_rank_type,
  points_per_game_rank: data.points_per_game_rank,
  points_per_game_rank_type: data.points_per_game_rank_type,
  selected_rank: data.selected_rank,
  selected_rank_type: data.selected_rank_type,
  starts_per_90: data.starts_per_90,
  clean_sheets_per_90: data.clean_sheets_per_90,
});

const upsertPlayerStat = async (bootStrapData: BootStrap) => {
  const existingPlayerStats = await mapEventPlayerStats();

  await upsert(
    bootStrapData.elements,
    ElementSchema,
    transformData,
    () => Promise.resolve(existingPlayerStats),
    'element_id',
    async (insertData) => {
      await prisma.playerStat.createMany({
        data: insertData,
      });
    },
    async (updateData) => {
      const updatePromises = updateData.map((newData) => {
        const existingData = existingPlayerStats[
          newData.element_id.toString()
        ] as Prisma.JsonObject;

        if (existingData) {
          const changedFields = getChangedFields(existingData, newData, ['element_id', 'event_id']);

          if (Object.keys(changedFields).length > 0) {
            return prisma.playerStat.update({
              where: { event_id_element_id: { event_id: eventId, element_id: newData.element_id } },
              data: changedFields,
            });
          }
        }

        return Promise.resolve();
      });

      await Promise.all(updatePromises);
    },
  );
};

export { upsertPlayerStat };
