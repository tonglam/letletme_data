// import { format } from 'date-fns';
// import { BootStrap } from '../../../constant/bootStrap.type';
// import { Element, ElementValue, PlayerValueChangeType } from '../../../constant/elements.type';
// import { prisma } from '../../../lib/prisma';
// import { getCurrentEvent } from '../../../utils/fpl.utils';

// async function getLatestPlayerValuesByElement(): Promise<Map<number, number>> {
//   const result = await prisma.playerValue.groupBy({
//     by: ['elementId'],
//     _max: {
//       updatedAt: true,
//     },
//   });

//   const latestValues = await prisma.playerValue.findMany({
//     where: {
//       OR: result.reduce<{ elementId: number; updatedAt: Date }[]>((acc, group) => {
//         if (group._max.updatedAt !== null) {
//           acc.push({
//             elementId: group.elementId,
//             updatedAt: group._max.updatedAt,
//           });
//         }
//         return acc;
//       }, []),
//     },
//     select: {
//       elementId: true,
//       value: true,
//     },
//   });

//   return new Map(latestValues.map((value) => [value.elementId, value.value]));
// }

// const transformData = (
//   data: Element,
//   lastValuesMap: Map<number, number>,
// ): Partial<ElementValue> | null => {
//   const currentEvent = getCurrentEvent();
//   const lastValue = lastValuesMap.get(data.elementId) ?? 0;

//   if (lastValue === data.price) {
//     return null;
//   }

//   const changeType: PlayerValueChangeType =
//     lastValue === 0 ? 'Start' : data.price > lastValue ? 'Rise' : 'Fall';

//   return {
//     id: data.id,
//     elementId: data.elementId,
//     elementType: data.elementType,
//     eventId: currentEvent,
//     value: data.price,
//     changeDate: format(new Date(), 'yyyy-MM-dd'),
//     changeType: changeType,
//     lastValue: lastValue,
//   };
// };

// const upsertPlayerValue = async (bootStrapData: BootStrap): Promise<void> => {
//   const lastValuesMap = await getLatestPlayerValuesByElement();

//   const transformedData = bootStrapData.elements
//     .map((element) => transformData(element, lastValuesMap))
//     .filter((item): item is ElementValue => item !== null);

//   if (transformedData.length > 0) {
//     await prisma.playerValue.createMany({
//       data: transformedData,
//     });
//   }
// };

// export { upsertPlayerValue };
