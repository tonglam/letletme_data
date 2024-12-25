import { Queue, QueueEvents } from 'bullmq';
import { Router } from 'express';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { logger } from '../../index';
import { trackMemoryUsage } from '../../infrastructure/api/common/monitor';
import { createMonitorService } from '../../infrastructure/queue/core/monitor.service';

export const monitorRouter = Router();

// Create monitor service with default queue
const queue = new Queue('default', {
  connection: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
});

const events = new QueueEvents('default', {
  connection: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
});

const monitorService = createMonitorService({
  queue,
  events,
  logger,
  config: {
    metricsInterval: 60000, // 1 minute
    historySize: 1440, // 24 hours
  },
});

// Get metrics
monitorRouter.get('/metrics', async (req, res) => {
  // Track memory usage
  trackMemoryUsage(logger);

  const result = await pipe(
    monitorService.getMetrics(),
    TE.map((metrics) => ({
      status: 'success',
      data: {
        queue: metrics,
        memory: process.memoryUsage(),
      },
    })),
    TE.mapLeft((error) => ({
      status: 'error',
      error: error.message,
    })),
  )();

  if (result._tag === 'Left') {
    res.status(400).json(result.left);
  } else {
    res.json(result.right);
  }
});
