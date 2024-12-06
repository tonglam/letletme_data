import { BootStrap } from '../../../constant/bootStrap.type';
import { Element, ElementSchema } from '../../../constant/elements.type';
import { prisma } from '../../../lib/prisma';
import { truncate_insert } from '../base';

const transformData = (data: Element) => ({
  id: data.id,
  elementId: data.elementId,
  elementCode: data.elementCode,
  price: data.price,
  startPrice: data.startPrice,
  elementType: data.elementType,
  firstName: data.firstName,
  secondName: data.secondName,
  webName: data.webName,
  teamId: data.teamId,
  status: data.status,
  chanceOfPlayingNextRound: data.chanceOfPlayingNextRound,
  chanceOfPlayingThisRound: data.chanceOfPlayingThisRound,
  inDreamteam: data.inDreamteam,
  dreamteamCount: data.dreamteamCount,
});

const upsertPlayer = async (bootStrapData: BootStrap): Promise<void> => {
  await truncate_insert(
    bootStrapData.elements,
    ElementSchema,
    transformData,
    async () => {
      await prisma.player.deleteMany();
    },
    async (data) => {
      await prisma.player.createMany({ data });
    },
  );
};

export { upsertPlayer };
