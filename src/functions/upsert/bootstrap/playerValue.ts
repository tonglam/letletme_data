import { PlayerValueChangeType, Prisma } from '@prisma/client';
import { format } from 'date-fns';
import { BootStrap } from '../../../constant/bootStrap.type';
import { Element } from '../../../constant/element.type';
import { prisma } from '../../../index';
import { getCurrentEvent } from '../../../utils/fpl.utils';

async function getLatestPlayerValuesByElement(): Promise<Map<number, number>> {
  const result = await prisma.playerValue.groupBy({
    by: ['element_id'],
    _max: {
      updated_at: true,
    },
  });

  const latestValues = await prisma.playerValue.findMany({
    where: {
      OR: result.reduce<Prisma.PlayerValueWhereInput[]>((acc, group) => {
        if (group._max.updated_at !== null) {
          acc.push({
            element_id: group.element_id,
            updated_at: group._max.updated_at,
          });
        }
        return acc;
      }, []),
    },
    select: {
      element_id: true,
      value: true,
    },
  });

  return new Map(latestValues.map((value) => [value.element_id, value.value]));
}

const transformData = (
  data: Element,
  lastValuesMap: Map<number, number>,
): Prisma.PlayerValueCreateManyInput | null => {
  const currentEvent = getCurrentEvent();
  const lastValue = lastValuesMap.get(data.id) ?? 0;

  if (lastValue === data.now_cost) {
    return null;
  }

  const changeType: PlayerValueChangeType =
    lastValue === 0
      ? PlayerValueChangeType.Start
      : data.now_cost > lastValue
        ? PlayerValueChangeType.Rise
        : PlayerValueChangeType.Fall;

  return {
    element_id: data.id,
    element_type: data.element_type,
    event_id: currentEvent,
    value: data.now_cost,
    change_date: format(new Date(), 'yyyy-MM-dd'),
    change_type: changeType,
    last_value: lastValue,
  };
};

const upsertPlayerValue = async (bootStrapData: BootStrap): Promise<void> => {
  const lastValuesMap = await getLatestPlayerValuesByElement();

  const transformedData = bootStrapData.elements
    .map((element) => transformData(element, lastValuesMap))
    .filter((item): item is Prisma.PlayerValueCreateManyInput => item !== null);

  if (transformedData.length > 0) {
    await prisma.playerValue.createMany({
      data: transformedData,
    });
  }
};

export { upsertPlayerValue };
