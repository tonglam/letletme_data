import { prisma } from '../../../lib/prisma';
import { BootStrap } from '../../../types/bootStrap.type';
import { ElementStat, ElementStatSchema } from '../../../types/players.type';
import { truncate_insert } from '../../base/base';

const transformData = (data: ElementStat) => ({
  id: data.id,
  eventId: data.eventId,
  elementId: data.elementId,
  teamId: data.teamId,
  form: data.form,
  influence: data.influence,
  creativity: data.creativity,
  threat: data.threat,
  ictIndex: data.ictIndex,
  expectedGoals: data.expectedGoals,
  expectedAssists: data.expectedAssists,
  expectedGoalInvolvements: data.expectedGoalInvolvements,
  expectedGoalsConceded: data.expectedGoalsConceded,
  minutes: data.minutes,
  goalsScored: data.goalsScored,
  assists: data.assists,
  cleanSheets: data.cleanSheets,
  goalsConceded: data.goalsConceded,
  ownGoals: data.ownGoals,
  penaltiesSaved: data.penaltiesSaved,
});

const upsertPlayerStat = async (bootStrapData: BootStrap): Promise<void> => {
  await truncate_insert(
    bootStrapData.elements,
    ElementStatSchema,
    transformData,
    async () => {
      await prisma.playerStat.deleteMany();
    },
    async (data) => {
      await prisma.playerStat.createMany({ data });
    },
  );
};

export { upsertPlayerStat };
