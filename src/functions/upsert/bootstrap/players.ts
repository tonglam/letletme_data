import { prisma } from '../../../lib/prisma';
import { BootStrap } from '../../../types/bootStrap.type';
import { Player, PlayerResponse, PlayerResponseSchema } from '../../../types/players.type';
import { truncate_insert } from '../../base/base';

const transformData = (data: PlayerResponse): Player => ({
  element: data.id,
  elementCode: data.code,
  price: data.now_cost,
  startPrice: data.now_cost + data.cost_change_start,
  elementType: data.element_type,
  firstName: data.first_name,
  secondName: data.second_name,
  webName: data.web_name,
  teamId: data.team,
});

const upsertPlayer = async (bootStrapData: BootStrap): Promise<void> => {
  await truncate_insert(
    bootStrapData.elements,
    PlayerResponseSchema,
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
