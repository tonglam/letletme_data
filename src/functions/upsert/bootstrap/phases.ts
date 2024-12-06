import { BootStrap } from '../../../constant/bootStrap.type';
import { Phase, PhaseSchema } from '../../../constant/phase.type';
import { prisma } from '../../../lib/prisma';
import { truncate_insert } from '../base';

const transformData = (data: Phase) => ({
  id: data.id,
  phaseId: data.phaseId,
  name: data.name,
  startEvent: data.startEvent,
  stopEvent: data.stopEvent,
});

const upsertPhase = async (bootStrapData: BootStrap): Promise<void> => {
  await truncate_insert(
    bootStrapData.phases,
    PhaseSchema,
    transformData,
    async () => {
      await prisma.phases.deleteMany();
    },
    async (data) => {
      await prisma.phases.createMany({ data });
    },
  );
};

export { upsertPhase };
