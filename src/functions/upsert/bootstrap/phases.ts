import { prisma } from '../../../lib/prisma';
import { BootStrap } from '../../../types/bootStrap.type';
import { Phase, PhaseResponse, PhaseResponseSchema } from '../../../types/phase.type';
import { truncate_insert } from '../../base/base';

const transformData = (data: PhaseResponse): Phase => ({
  id: data.id,
  name: data.name,
  startEvent: data.start_event,
  stopEvent: data.stop_event,
  highestScore: data.highest_score,
});

const upsertPhases = async (bootStrapData: BootStrap): Promise<void> => {
  await truncate_insert(
    bootStrapData.phases,
    PhaseResponseSchema,
    transformData,
    async () => {
      await prisma.phase.deleteMany();
    },
    async (data) => {
      await prisma.phase.createMany({ data });
    },
  );
};
export { upsertPhases };
