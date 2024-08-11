import { BootStrap } from '../../../constant/bootStrap.type';
import { Phase, PhaseSchema } from '../../../constant/phase.type';
import { prisma } from '../../../index';
import { safeDelete } from '../../base/mongoDB';
import { truncate_insert } from '../base';

const transformData = (data: Phase) => ({
  phase_id: data.id,
  name: data.name,
  start_event: data.start_event,
  stop_event: data.stop_event,
});

const upsertPhase = async (bootStrapData: BootStrap) => {
  await truncate_insert(
    bootStrapData.phases,
    PhaseSchema,
    transformData,
    async () => {
      await safeDelete('phase');
    },
    async (data) => {
      await prisma.phase.createMany({ data });
    },
  );
};

export { upsertPhase };
