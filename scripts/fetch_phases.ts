import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Fetching phases from the database...');
  try {
    // Query the 'phase' table (model Phase maps to 'phases' table)
    const phases = await prisma.phase.findMany({
      take: 10, // Fetch only the first 10 phases for brevity
      orderBy: {
        id: 'asc', // Order by ID
      },
    });

    if (phases.length === 0) {
      console.log('No phases found in the database.');
    } else {
      console.log(`Found ${phases.length} phases:`);
      console.dir(phases, { depth: null }); // Print the full object structure
    }
  } catch (error) {
    console.error('Error fetching phases:', error);
    process.exit(1); // Exit with error code
  } finally {
    await prisma.$disconnect();
    console.log('Disconnected from database.');
  }
}

main();
