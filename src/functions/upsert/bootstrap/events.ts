import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { BootStrap } from '../../../types/bootStrap.type';
import { EventResponse, EventResponseSchema } from '../../../types/events.type';
import { truncate_insert } from '../../base/base';

const transformData = (data: EventResponse): Prisma.EventCreateInput => {
  return {
    id: data.id,
    name: data.name,
    deadlineTime: new Date(data.deadline_time_epoch * 1000),
    deadlineTimeEpoch: data.deadline_time_epoch,
    deadlineTimeGameOffset: data.deadline_time_game_offset,
    releaseTime: data.release_time ? new Date(data.release_time) : null,
    averageEntryScore: data.average_entry_score,
    finished: data.finished,
    dataChecked: data.data_checked,
    highestScore: data.highest_score ?? 0,
    highestScoringEntry: data.highest_scoring_entry ?? 0,
    isPrevious: data.is_previous,
    isCurrent: data.is_current,
    isNext: data.is_next,
    cupLeaguesCreated: data.cup_leagues_created,
    h2hKoMatchesCreated: data.h2h_ko_matches_created,
    rankedCount: data.ranked_count,
    chipPlays:
      Array.isArray(data.chip_plays) && data.chip_plays.length > 0
        ? (data.chip_plays as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    mostSelected: data.most_selected,
    mostTransferredIn: data.most_transferred_in,
    mostCaptained: data.most_captained,
    mostViceCaptained: data.most_vice_captained,
    topElement: data.top_element,
    topElementInfo: data.top_element_info,
    transfersMade: data.transfers_made,
    createdAt: new Date(),
  };
};

const upsertEvents = async (bootStrapData: BootStrap): Promise<void> => {
  await truncate_insert(
    bootStrapData.events,
    EventResponseSchema,
    transformData,
    async () => {
      await prisma.event.deleteMany();
    },
    async (data) => {
      await prisma.event.createMany({ data });
    },
  );
};

export { upsertEvents };
