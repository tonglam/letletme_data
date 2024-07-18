import { BootStrap } from '../../constant/bootStrap.type';
import { Event, EventSchema } from '../../constant/events.type';
import { prisma } from '../../index';
import { truncate_insert } from './baseUpsertFunction';

const transformEventData = (data: Event) => ({
  ...data,
  event_id: data.id,
  id: undefined,
});

const upsertEvent = async (bootStrapData: BootStrap) => {
  await truncate_insert(
    bootStrapData.events,
    EventSchema,
    transformEventData,
    async () => {
      await prisma.event.deleteMany();
    },
    async (data) => {
      await prisma.event.createMany({
        data,
      });
    },
  );
};

export { upsertEvent };
