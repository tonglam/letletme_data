import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import pino from 'pino';

dotenv.config();

const logger = pino({ level: 'info' });
const prisma = new PrismaClient();

async function main() {
  try {
    logger.info('Checking events in database...');

    const eventsCount = await prisma.event.count();
    logger.info({ count: eventsCount }, 'Total events in database');

    if (eventsCount > 0) {
      const events = await prisma.event.findMany({
        select: {
          id: true,
          name: true,
          deadlineTime: true,
          isCurrent: true,
          isNext: true,
          isPrevious: true,
        },
        orderBy: {
          id: 'asc',
        },
      });

      logger.info({ events }, 'Events details');
    }
  } catch (error) {
    logger.error({ error }, 'Failed to check events');
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
