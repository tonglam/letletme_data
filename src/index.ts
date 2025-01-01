import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { initializeApp } from './app/initializer';
import { logger } from './configs/app/app.config';

const main = async () => {
  try {
    await pipe(
      initializeApp(),
      TE.mapLeft((error) => {
        logger.error({ error }, 'Application failed to start');
        process.exit(1);
      }),
    )();
    logger.info('Application started successfully');
  } catch (error) {
    logger.error({ error }, 'Unhandled error occurred');
    process.exit(1);
  }
};

main();
