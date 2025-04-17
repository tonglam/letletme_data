import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Fetching events from the database...');
  try {
    const events = await prisma.event.findMany({
      take: 10, // Fetch only the first 10 events for brevity
      orderBy: {
        id: 'asc', // Order by ID
      },
    });

    if (events.length === 0) {
      console.log('No events found in the database.');
    } else {
      console.log(`Found ${events.length} events:`);
      console.dir(events, { depth: null }); // Print the full object structure
    }
  } catch (error) {
    console.error('Error fetching events:', error);
    process.exit(1); // Exit with error code
  } finally {
    await prisma.$disconnect();
    console.log('Disconnected from database.');
  }
}

main();
