// import { logger } from '@bogeychan/elysia-logger'; // Example logger, configure as needed
import { Elysia } from 'elysia';
// import { addJob } from 'infrastructures/queue/jobManager'; // Assuming this path is correct/will be fixed
// import { initializeManagedQueues, ManagedQueueConfig } from 'infrastructures/queue/queueManager'; // Assuming this path is correct/will be fixed
// import { createRedisConnection, disconnectRedis } from 'infrastructures/redis/connection'; // Assuming this path is correct/will be fixed
// import { EmailJobPayload } from 'types/jobs.type';
// import { QueueName } from 'types/queues.type'; // Commented out - unused

const PORT = process.env.PORT || 3000;

// const queueConfigs: ManagedQueueConfig[] = [{ name: QueueName.EMAIL }, { name: QueueName.META }]; // Commented out - unused

async function startServer() {
  console.log('Application starting...'); // Use console for initial logs before logger is ready

  try {
    // 1. Connect to Redis (Commented out until infrastructure is ready)
    // const redisConnection = await createRedisConnection();
    // console.log('Redis connection established.');
    // const redisConnection = null; // Placeholder - unused

    // 2. Initialize BullMQ Queues (Requires Redis connection)
    // const queues = initializeManagedQueues(redisConnection, queueConfigs);
    // console.log('Managed queues initialized.');
    // const queues = new Map(); // Placeholder - unused

    // 3. Create Elysia App
    const app = new Elysia()
      // --- Logger Setup (Commented out until logger is installed/configured) ---
      /*
      .use(
        logger({
          level: 'info',
        }),
      )
      */
      // --- Graceful Shutdown Logic ---
      .onStop(async () => {
        console.info('Initiating graceful shutdown...'); // Use console for now
        // await disconnectRedis(); // Commented out until infrastructure is ready
        console.info('Redis connection closed.'); // Use console for now
        console.info('Graceful shutdown completed.'); // Use console for now
      })
      // --- Health Check Route (Example) ---
      .get('/', () => ({ status: 'ok', timestamp: Date.now() }))
      // --- Add other routes/plugins here ---
      // .use(userRoutes)
      // .use(productRoutes)
      .onError(({ code, error, set }) => {
        // Check if error is an instance of Error before accessing message
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Error [${code}]: ${errorMessage}`, error); // Log the full error object too
        // Add specific error handling based on code or error type
        set.status = 500; // Default to internal server error
        return { error: 'An unexpected error occurred.' };
      });

    // --- Example: Add a test email job after app setup (Requires Queues) ---
    /*
    try {
      const emailQueue = queues.get(QueueName.EMAIL);
      if (emailQueue) {
        const jobData: EmailJobPayload = {
          to: 'test@example.com',
          subject: 'Test Email from BullMQ',
          body: '<h1>Hello!</h1><p>This is a test job.</p>',
          source: 'application-startup',
        };
        await addJob<EmailJobPayload>(emailQueue, 'send-test-email', jobData);
        // app.log.info('Test email job added.'); // Use console for now
        console.info('Test email job added.');
      }
    } catch (jobError) {
      if (jobError instanceof Error) {
        // app.log.error('Failed to add test job:', { error: jobError.message }); // Use console for now
        console.error('Failed to add test job:', { error: jobError.message });
      } else {
        // app.log.error('Failed to add test job with unknown error type'); // Use console for now
        console.error('Failed to add test job with unknown error type');
      }
    }
    */
    // --- End Example ---

    // 4. Start Listening
    app.listen(PORT);

    // app.log.info(`🦊 Elysia is running at http://${app.server?.hostname}:${app.server?.port}`); // Use console for now
    console.info(`🦊 Elysia is running at http://localhost:${PORT}`); // Simplified log
    // app.log.info('Application running. (Background jobs and HTTP server active)'); // Use console for now
    console.info('Application running. (HTTP server active, jobs commented out)');
  } catch (error) {
    console.error('Application failed to start:', error);
    // Ensure Redis disconnects even if startup fails before Elysia's onStop is registered
    // await disconnectRedis().catch((err) => // Commented out until infrastructure is ready
    //   console.error('Failed to disconnect Redis during failed startup:', err),
    // );
    // Explicitly type the error parameter
    await Promise.resolve().catch((err: unknown) =>
      console.error('Error during post-failure cleanup (placeholder):', err),
    );
    process.exit(1);
  }
}

// Handle OS signals for graceful shutdown if needed (Elysia's onStop usually covers this)
// Bun might handle SIGTERM/SIGINT differently, rely on onStop first.
// process.on('SIGTERM', async () => { /* app.stop() might be needed if onStop doesn't cover all cases */ });
// process.on('SIGINT', async () => { /* app.stop() might be needed */ });

startServer();
