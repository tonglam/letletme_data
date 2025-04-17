import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Fetching player stats from the database...');
  try {
    // Query the 'player_stats' table
    const playerStats = await prisma.playerStat.findMany({
      take: 5, // Fetch ANY 5 records
      orderBy: {
        // Order to get consistent sample if data exists
        id: 'asc',
      },
    });

    if (playerStats.length === 0) {
      console.log('No stats found in the player_stats table.');
    } else {
      console.log(`Found ${playerStats.length} stat records in the table:`);
      console.dir(playerStats, { depth: null }); // Print the full object structure
    }
  } catch (error) {
    console.error('Error fetching player stats:', error);
    process.exit(1); // Exit with error code
  } finally {
    await prisma.$disconnect();
    console.log('Disconnected from database.');
  }
}

main();
