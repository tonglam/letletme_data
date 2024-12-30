import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import pino from 'pino';
import { fetchBootstrapEvents } from '../domains/bootstrap/operations';
import { createFPLClient } from '../infrastructures/http/fpl';

dotenv.config();

const logger = pino({ level: 'info' });
const prisma = new PrismaClient();

async function main() {
  try {
    logger.info('Starting data comparison...');

    // Get original data from FPL API
    const fplClient = createFPLClient();
    const originalEvents = await pipe(
      fetchBootstrapEvents(fplClient),
      TE.getOrElse((error) => {
        logger.error({ error }, 'Failed to fetch events from FPL API');
        throw error;
      }),
    )();

    // Get saved data from database
    const savedEvents = await prisma.event.findMany({
      orderBy: { id: 'asc' },
    });

    logger.info(
      {
        originalCount: originalEvents.length,
        savedCount: savedEvents.length,
      },
      'Event counts',
    );

    // Compare first event in detail
    const originalFirst = originalEvents[0];
    const savedFirst = savedEvents[0];

    if (originalFirst && savedFirst) {
      const comparison = {
        id: {
          original: originalFirst.id,
          saved: savedFirst.id,
          matches: originalFirst.id === savedFirst.id,
        },
        name: {
          original: originalFirst.name,
          saved: savedFirst.name,
          matches: originalFirst.name === savedFirst.name,
        },
        deadlineTime: {
          original: originalFirst.deadlineTime.toISOString(),
          saved: savedFirst.deadlineTime.toISOString(),
          matches:
            originalFirst.deadlineTime.toISOString() === savedFirst.deadlineTime.toISOString(),
        },
        deadlineTimeEpoch: {
          original: originalFirst.deadlineTimeEpoch,
          saved: savedFirst.deadlineTimeEpoch,
          matches: originalFirst.deadlineTimeEpoch === savedFirst.deadlineTimeEpoch,
        },
        averageEntryScore: {
          original: originalFirst.averageEntryScore,
          saved: savedFirst.averageEntryScore,
          matches: originalFirst.averageEntryScore === savedFirst.averageEntryScore,
        },
        finished: {
          original: originalFirst.finished,
          saved: savedFirst.finished,
          matches: originalFirst.finished === savedFirst.finished,
        },
        highestScore: {
          original: originalFirst.highestScore,
          saved: savedFirst.highestScore,
          matches: originalFirst.highestScore === savedFirst.highestScore,
        },
        chipPlays: {
          original: JSON.stringify(originalFirst.chipPlays),
          saved: JSON.stringify(savedFirst.chipPlays),
          matches: JSON.stringify(originalFirst.chipPlays) === JSON.stringify(savedFirst.chipPlays),
        },
        mostSelected: {
          original: originalFirst.mostSelected,
          saved: savedFirst.mostSelected,
          matches: originalFirst.mostSelected === savedFirst.mostSelected,
        },
        topElementInfo: {
          original: JSON.stringify(originalFirst.topElementInfo),
          saved: JSON.stringify(savedFirst.topElementInfo),
          matches:
            JSON.stringify(originalFirst.topElementInfo) ===
            JSON.stringify(savedFirst.topElementInfo),
        },
      };

      logger.info({ comparison }, 'Detailed comparison of first event');

      // Check for any mismatches
      const mismatches = Object.entries(comparison)
        .filter(([, value]) => !value.matches)
        .map(([field, value]) => ({
          field,
          original: value.original,
          saved: value.saved,
        }));

      if (mismatches.length > 0) {
        logger.warn({ mismatches }, 'Found mismatches in data');
      } else {
        logger.info('All checked fields match exactly');
      }
    }
  } catch (error) {
    logger.error({ error }, 'Failed to compare data');
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
