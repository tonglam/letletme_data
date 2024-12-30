import dotenv from 'dotenv';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import pino from 'pino';
import { teamRepository } from '../domains/teams/repository';
import { connectDB, disconnectDB } from '../infrastructures/db/prisma';
import { createFPLClient } from '../infrastructures/http/fpl';
import { createTeamServiceImpl } from '../services/teams/service';

dotenv.config();

const logger = pino({ level: 'debug' });

async function main() {
  logger.info('Starting team sync test...');

  // Step 1: Test database connection
  try {
    const dbResult = await connectDB();
    if (dbResult._tag === 'Left') {
      throw dbResult.left;
    }
    logger.info('Database connection successful');

    const count = await teamRepository.prisma.team.count();
    logger.info({ count }, 'Current teams in database');
  } catch (error) {
    logger.error({ error }, 'Failed to connect to database');
    throw error;
  }

  // Step 2: Test FPL API connection
  const bootstrapApi = createFPLClient();
  try {
    const bootstrapData = await bootstrapApi.getBootstrapData();
    if (!bootstrapData) {
      throw new Error('Failed to fetch bootstrap data');
    }
    if (!bootstrapData.teams || bootstrapData.teams.length === 0) {
      throw new Error('No teams data available in bootstrap response');
    }
    logger.info(
      { teamsCount: bootstrapData.teams.length },
      'Successfully fetched teams from FPL API',
    );
  } catch (error) {
    logger.error({ error }, 'Failed to fetch bootstrap data');
    throw error;
  }

  // Step 3: Test team sync process
  try {
    const teamService = createTeamServiceImpl({
      bootstrapApi,
      teamRepository,
    });

    await pipe(
      teamService.syncTeams(),
      TE.map((teams) => {
        logger.info({ count: teams.length }, 'Successfully synced teams');
        return teams;
      }),
      TE.mapLeft((error) => {
        logger.error({ error }, 'Failed to sync teams');
        throw error;
      }),
    )();
  } catch (error) {
    logger.error({ error }, 'Team sync process failed');
    throw error;
  }

  // Step 4: Verify saved teams
  try {
    const savedTeams = await teamRepository.prisma.team.findMany();
    logger.info({ count: savedTeams.length }, 'Teams in database after sync');
    if (savedTeams.length === 0) {
      throw new Error('No teams found in database after sync');
    }
  } catch (error) {
    logger.error({ error }, 'Failed to verify saved teams');
    throw error;
  }

  // Clean up
  await disconnectDB();
  logger.info('Team sync test completed successfully');
}

main().catch((error) => {
  logger.error({ error }, 'Team sync test failed');
  process.exit(1);
});
