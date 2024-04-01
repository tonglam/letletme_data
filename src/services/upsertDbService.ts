import { Prisma } from '@prisma/client';
import { BootStrap } from '../constant/bootStrap.type';
import { Event, EventsSchema } from '../constant/events.type';
import { logger, prisma } from '../index';

const upsertEvent = async (bootStrapData: BootStrap) => {
  const eventsResult = EventsSchema.safeParse(bootStrapData.events);

  if (!eventsResult.success) {
    logger.error(`Error validating events data: ${eventsResult.error.message}`);
    return;
  }

  const eventData = eventsResult.data.map((data: Event) => {
    return {
      ...data,
      event_id: data.id,
      id: undefined,
    };
  });

  try {
    await prisma.event.deleteMany();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      logger.error(`Error deleting event: ${error.message}`);
    }
  }

  try {
    await prisma.event.createMany({
      data: eventData,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      logger.error(`Error upserting event: ${error.message}`);
    }
  }
};

export { upsertEvent };
