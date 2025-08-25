import { redisSingleton } from '../cache/singleton';
import { databaseSingleton } from '../db/singleton';
import { logError, logInfo } from './logger';

/**
 * Cleanup utility to properly close connections and allow process to exit
 */
export async function cleanup(): Promise<void> {
  try {
    logInfo('Starting cleanup process...');

    // Close Redis connection
    if (redisSingleton.isHealthy()) {
      logInfo('Closing Redis connection...');
      await redisSingleton.disconnect();
    }

    // Close database connection
    if (databaseSingleton.isHealthy()) {
      logInfo('Closing database connection...');
      await databaseSingleton.disconnect();
    }

    logInfo('✅ Cleanup completed successfully');
  } catch (error) {
    logError('Error during cleanup:', error);
  }
}

/**
 * Register cleanup handlers for process exit
 */
export function registerCleanupHandlers(): void {
  // Handle normal process termination
  process.on('beforeExit', async () => {
    await cleanup();
  });

  // Handle Ctrl+C
  process.on('SIGINT', async () => {
    logInfo('🛑 Received SIGINT, cleaning up...');
    await cleanup();
    process.exit(0);
  });

  // Handle kill signal
  process.on('SIGTERM', async () => {
    logInfo('🛑 Received SIGTERM, cleaning up...');
    await cleanup();
    process.exit(0);
  });
}
