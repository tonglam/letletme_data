import { redisSingleton } from './src/cache/singleton';
import { getDbClient } from './src/db/singleton';
import { getCurrentSeason } from './src/utils/conditions';

async function main() {
  try {
    console.log('\n===========================================');
    console.log('📊 FIXTURES DATA IN DATABASE (Supabase)');
    console.log('===========================================\n');

    const client = await getDbClient();

    // Count total fixtures
    const countResult = await client`SELECT COUNT(*) as count FROM fixtures`;
    console.log(`✅ Total fixtures in database: ${countResult[0].count}\n`);

    // Show sample fixtures for event 1
    const sampleFixtures = await client`
      SELECT id, code, event, finished, team_a, team_h, team_a_score, team_h_score, 
             kickoff_time, minutes
      FROM fixtures 
      WHERE event = 1
      ORDER BY id
      LIMIT 5
    `;

    console.log('Sample fixtures from Event 1:');
    sampleFixtures.forEach((fixture: any) => {
      console.log(`  Fixture ${fixture.id}: Team ${fixture.team_h} vs Team ${fixture.team_a}`);
      console.log(`    Score: ${fixture.team_h_score ?? '-'} - ${fixture.team_a_score ?? '-'}`);
      console.log(
        `    Status: ${fixture.finished ? 'Finished' : 'Upcoming'} (${fixture.minutes} minutes)`,
      );
      console.log(`    Kickoff: ${fixture.kickoff_time || 'TBD'}`);
      console.log('');
    });

    console.log('\n===========================================');
    console.log('💾 FIXTURES DATA IN REDIS CACHE');
    console.log('===========================================\n');

    const redis = await redisSingleton.getClient();
    const season = getCurrentSeason();
    const cacheKey = `fpl:Fixture:${season}`;

    // Check if cache exists
    const cacheExists = await redis.exists(cacheKey);
    console.log(`✅ Cache key exists: ${cacheKey} = ${cacheExists === 1 ? 'YES' : 'NO'}\n`);

    if (cacheExists) {
      // Get cache size
      const cacheSize = await redis.hlen(cacheKey);
      console.log(`✅ Cached fixtures count: ${cacheSize}\n`);

      // Get sample fixtures from cache
      const cachedFixtureIds = await redis.hkeys(cacheKey);
      console.log(`Sample cached fixture IDs: ${cachedFixtureIds.slice(0, 10).join(', ')}...\n`);

      // Get one fixture from cache
      const sampleFixture = await redis.hget(cacheKey, '1');
      if (sampleFixture) {
        const parsed = JSON.parse(sampleFixture);
        console.log('Sample fixture from Redis (ID 1):');
        console.log(`  Event: ${parsed.event}`);
        console.log(`  Teams: ${parsed.teamH} vs ${parsed.teamA}`);
        console.log(`  Score: ${parsed.teamHScore ?? '-'} - ${parsed.teamAScore ?? '-'}`);
        console.log(`  Finished: ${parsed.finished}`);
      }
    }

    console.log('\n===========================================');
    console.log('✅ DATA SUCCESSFULLY LOADED!');
    console.log('===========================================\n');

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
