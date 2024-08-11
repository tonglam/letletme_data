import { BootStrap } from '../../../constant/bootStrap.type';
import { Event, EventSchema } from '../../../constant/events.type';
import { prisma } from '../../../index';
import { safeDelete } from '../../base/mongoDB';
import { truncate_insert } from '../base';

const transformData = (data: Event) => ({
  ...data,
  event_id: data.id,
  id: undefined,
});

const upsertEvent = async (bootStrapData: BootStrap) => {
  await truncate_insert(
    bootStrapData.events,
    EventSchema,
    transformData,
    async () => {
      await safeDelete('event');
    },
    async (data) => {
      await prisma.event.createMany({ data });
    },
  );
};

export { upsertEvent };
