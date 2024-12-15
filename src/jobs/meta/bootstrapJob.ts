import { Job } from 'bullmq';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { z } from 'zod';
import { QUEUE_NAMES, QUEUE_PRIORITIES } from '../../infrastructure/queue/config';
import { JobDefinition } from '../types';

// Input validation schema
const BootstrapDataSchema = z.object({
  validateMeta: z.boolean().default(true),
  updateTypes: z.array(z.enum(['teams', 'phases', 'events'])),
  force: z.boolean().default(false),
});

type BootstrapData = z.infer<typeof BootstrapDataSchema>;

// Result type
interface BootstrapResult {
  updatedTypes: string[];
  changes: {
    type: string;
    added: number;
    updated: number;
    removed: number;
  }[];
  timestamp: number;
}

// Job implementation
export const BootstrapJob: JobDefinition<BootstrapData, BootstrapResult> = {
  metadata: {
    queue: QUEUE_NAMES.META,
    priority: QUEUE_PRIORITIES.HIGH,
    schedule: '0 0 * * *', // Daily at midnight
    timeout: 300000, // 5 minutes
  },

  validate: (data: unknown) =>
    pipe(
      E.tryCatch(
        () => BootstrapDataSchema.parse(data),
        (error) => new Error(`Invalid bootstrap data: ${error}`),
      ),
    ),

  handler: async (data: BootstrapData, job?: Job): Promise<E.Either<Error, BootstrapResult>> => {
    const startTime = Date.now();

    return pipe(
      TE.right(data),
      TE.chain((data) =>
        TE.tryCatch(
          async () => {
            const results = [];
            let progress = 0;

            // Process each update type
            for (const type of data.updateTypes) {
              const result = await processUpdateType(type, data.force);
              results.push(result);
              progress += 100 / data.updateTypes.length;
              job?.updateProgress(progress);
            }

            return {
              updatedTypes: data.updateTypes,
              changes: results,
              timestamp: startTime,
            };
          },
          (error) => error as Error,
        ),
      ),
    )();
  },

  onComplete: async (result: BootstrapResult): Promise<void> => {
    console.log('Bootstrap completed:', {
      types: result.updatedTypes,
      changes: result.changes,
      duration: Date.now() - result.timestamp,
    });
  },

  onFailed: async (error: Error): Promise<void> => {
    console.error('Bootstrap failed:', error);
  },
};

// Helper function to process each update type
async function processUpdateType(
  type: string,
  force: boolean,
): Promise<{ type: string; added: number; updated: number; removed: number }> {
  // Placeholder implementation that uses the force parameter
  return {
    type,
    added: force ? 1 : 0, // Example usage of force parameter
    updated: 0,
    removed: 0,
  };
}
