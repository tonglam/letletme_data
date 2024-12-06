import { BootStrap } from '../../../constant/bootStrap.type';
import { Team, TeamSchema } from '../../../constant/teams.type';
import { prisma } from '../../../lib/prisma';
import { truncate_insert } from '../base';

const transformData = (data: Team) => ({
  id: data.id,
  teamId: data.teamId,
  name: data.name,
  shortName: data.shortName,
  strength: data.strength,
});

const upsertTeam = async (bootStrapData: BootStrap): Promise<void> => {
  await truncate_insert(
    bootStrapData.teams,
    TeamSchema,
    transformData,
    async () => {
      await prisma.team.deleteMany();
    },
    async (data) => {
      await prisma.team.createMany({ data });
    },
  );
};

export { upsertTeam };
