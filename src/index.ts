import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import type { Server } from 'http';
import { initializeApplication, shutdownApplication } from './app/initializer';
import { AppConfig, logger } from './configs/app/app.config';

// Server start function
const startServer = async (customPort?: number): Promise<Server> => {
  const serverPort = customPort || parseInt(AppConfig.port, 10);
  const result = await pipe(
    initializeApplication(serverPort),
    TE.fold(
      (error) => {
        logger.error({ error }, 'Application startup failed');
        return T.of(Promise.reject(error));
      },
      (server) => T.of(Promise.resolve(server)),
    ),
  )();
  return result as Server;
};

// Server stop function
const stopServer = async (server?: Server): Promise<void> => {
  return pipe(
    shutdownApplication(server),
    TE.fold(
      (error) => {
        logger.error({ error }, 'Application shutdown failed');
        return T.of(Promise.reject(error));
      },
      () => T.of(undefined),
    ),
  )();
};

// Start application
if (require.main === module) {
  startServer()
    .then(() => {
      logger.info('Application started successfully');
    })
    .catch((error) => {
      logger.error({ error }, 'Application failed to start');
      process.exit(1);
    });
}

export { startServer, stopServer };
