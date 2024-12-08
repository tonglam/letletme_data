import { format } from 'date-fns';
import { player_value_change_type_enum } from '../../../constants/enum';
import { prisma } from '../../../lib/prisma';
import { BootStrap } from '../../../types/bootstrap.type';
import {
  PlayerValue,
  PlayerValueResponse,
  PlayerValueResponseSchema,
} from '../../../types/playerValues.type';
import { getCurrentEvent } from '../../../utils/common';
import { truncate_insert } from '../../base/base';

const getLatestPlayerValuesByElement = async (): Promise<Map<number, number>> => {
  const latestValues = await prisma.playerValue.findMany({
    orderBy: { createdAt: 'desc' },
    distinct: ['elementId'],
    select: { elementId: true, value: true },
  });

  return new Map(latestValues.map(({ elementId, value }) => [elementId, value]));
};

const transformData = (
  data: PlayerValueResponse,
  lastValuesMap: Map<number, number>,
): PlayerValue | null => {
  const currentEvent = getCurrentEvent();
  const lastValue = lastValuesMap.get(data.id) ?? 0;

  if (lastValue === data.now_cost) {
    return null;
  }

  const changeType =
    lastValue === 0
      ? player_value_change_type_enum.Start
      : data.now_cost > lastValue
        ? player_value_change_type_enum.Rise
        : player_value_change_type_enum.Fall;

  return {
    elementId: data.id,
    elementType: data.element_type,
    eventId: currentEvent,
    value: data.now_cost,
    changeDate: format(new Date(), 'yyyy-MM-dd'),
    changeType,
    lastValue,
  };
};

const upsertPlayerValue = async (bootStrapData: BootStrap): Promise<void> => {
  const lastValuesMap = await getLatestPlayerValuesByElement();

  await truncate_insert(
    bootStrapData.elements,
    PlayerValueResponseSchema,
    (data) => transformData(data, lastValuesMap),
    async () => {
      await prisma.playerValue.deleteMany();
    },
    async (data) => {
      await prisma.playerValue.createMany({
        data: data.filter((item): item is PlayerValue => item !== null),
      });
    },
  );
};

export { upsertPlayerValue };
