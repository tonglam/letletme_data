import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Fetching teams from the database...');
  try {
    // Query the 'team' table (model Team maps to 'teams' table)
    const teams = await prisma.team.findMany({
      take: 5, // Fetch only the first 5 teams for brevity
      orderBy: {
        id: 'asc', // Order by ID
      },
    });

    if (teams.length === 0) {
      console.log('No teams found in the database.');
    } else {
      console.log(`Found ${teams.length} teams:`);
      console.dir(teams, { depth: null }); // Print the full object structure
    }
  } catch (error) {
    console.error('Error fetching teams:', error);
    process.exit(1); // Exit with error code
  } finally {
    await prisma.$disconnect();
    console.log('Disconnected from database.');
  }
}

main();
