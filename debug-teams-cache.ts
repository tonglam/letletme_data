#!/usr/bin/env bun

import { teamsCache } from './src/cache/operations';
import { fplClient } from './src/clients/fpl';
import { transformTeams } from './src/transformers/teams';
import { logInfo } from './src/utils/logger';

async function debugTeamsCache() {
  try {
    console.log('🔧 DEBUG: Testing teams cache directly...');
    
    // 1. Fetch and transform teams
    console.log('Step 1: Fetching FPL data...');
    const bootstrapData = await fplClient.getBootstrap();
    console.log(`✅ Fetched ${bootstrapData.teams.length} teams from FPL API`);
    
    // 2. Transform teams
    console.log('Step 2: Transforming teams...');
    const teams = transformTeams(bootstrapData.teams);
    console.log(`✅ Transformed ${teams.length} teams`);
    console.log('First 3 teams:', teams.slice(0, 3).map(t => ({ id: t.id, name: t.name, shortName: t.shortName })));
    
    // 3. Set cache
    console.log('Step 3: Setting teams cache...');
    await teamsCache.set(teams);
    console.log('✅ Teams cache set completed');
    
    // 4. Verify cache
    console.log('Step 4: Verifying cache...');
    const cachedTeams = await teamsCache.get();
    console.log(`✅ Retrieved ${cachedTeams?.length || 0} teams from cache`);
    
    if (cachedTeams && cachedTeams.length > 0) {
      console.log('First 3 cached teams:', cachedTeams.slice(0, 3).map(t => ({ id: t.id, name: t.name, shortName: t.shortName })));
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

debugTeamsCache();
