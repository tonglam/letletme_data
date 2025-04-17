import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Fetching players from the database...');
  try {
    // Query the 'player' table (model Player maps to 'players' table)
    const players = await prisma.player.findMany({
      take: 5, // Fetch only the first 5 players for brevity
      orderBy: {
        element: 'asc', // Order by the primary key 'element'
      },
    });

    if (players.length === 0) {
      console.log('No players found in the database.');
    } else {
      console.log(`Found ${players.length} players:`);
      console.dir(players, { depth: null }); // Print the full object structure
    }
  } catch (error) {
    console.error('Error fetching players:', error);
    process.exit(1); // Exit with error code
  } finally {
    await prisma.$disconnect();
    console.log('Disconnected from database.');
  }
}

main();
