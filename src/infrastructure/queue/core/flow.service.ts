import { FlowJob as BullMQFlowJob, FlowProducer, Queue, QueueEvents } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createQueueError, QueueError, QueueErrorCode } from '../../../types/errors.type';
import { BaseJobData, isJobName, JobName } from '../../../types/job.type';
import { FlowJob, FlowOpts, FlowService } from '../types';

// Custom type for flow job with required parent ID
type FlowJobWithParent = Omit<BullMQFlowJob, 'opts'> & {
  opts?: {
    parent?: {
      id: string;
      queue: string;
    };
    [key: string]: unknown;
  };
};

export const createFlowService = <T extends BaseJobData>(
  queue: Queue<T>,
  defaultName: JobName,
): FlowService<T> => {
  // Create a flow producer with the same connection as the queue
  const flowProducer = new FlowProducer({ connection: queue.opts.connection });

  // Create queue events listener
  const queueEvents = new QueueEvents(queue.name, { connection: queue.opts.connection });

  const getFlowDependencies = (jobId: string): TE.TaskEither<QueueError, FlowJob<T>[]> =>
    pipe(
      TE.tryCatch(
        async () => {
          console.log('Getting flow dependencies for job:', jobId);
          const job = await queue.getJob(jobId);
          if (!job) {
            console.log('Job not found:', jobId);
            return [];
          }
          console.log('Found job:', job.id, 'with data:', job.data);

          // Get child jobs using BullMQ's getChildrenValues method
          const childrenValues = await job.getChildrenValues();
          console.log('Children values:', childrenValues);
          if (!childrenValues) {
            console.log('No children values found');
            return [];
          }

          // Convert child jobs to FlowJob array
          const flowJobs = Object.entries(childrenValues).map(([childId, childData]) => ({
            name: (childData as T).name as JobName,
            queueName: queue.name,
            data: childData as T,
            opts: {
              jobId: childId,
            },
          }));
          console.log('Converted flow jobs:', flowJobs);
          return flowJobs;
        },
        (error) => {
          console.error('Error getting flow dependencies:', error);
          return createQueueError(
            QueueErrorCode.GET_FLOW_DEPENDENCIES,
            defaultName,
            error as Error,
          );
        },
      ),
    );

  const getChildrenValues = (jobId: string): TE.TaskEither<QueueError, Record<string, unknown>> =>
    pipe(
      TE.tryCatch(
        async () => {
          const job = await queue.getJob(jobId);
          if (!job) {
            return {} as Record<string, unknown>;
          }

          const values = await job.getChildrenValues();
          return (values || {}) as Record<string, unknown>;
        },
        (error) =>
          createQueueError(QueueErrorCode.GET_CHILDREN_VALUES, defaultName, error as Error),
      ),
    );

  const addJob = (data: T, opts?: FlowOpts<T>): TE.TaskEither<QueueError, FlowJob<T>> =>
    pipe(
      TE.tryCatch(
        async () => {
          try {
            // Ensure the job has a valid name
            const jobData = {
              ...data,
              name: isJobName(data.name) ? data.name : defaultName,
            };

            console.log('Adding job with data:', JSON.stringify(jobData, null, 2));
            console.log('Options:', JSON.stringify(opts, null, 2));

            // Create the flow job
            if (!opts?.jobId || typeof opts.jobId !== 'string') {
              throw new Error('Parent job ID is required for flow jobs with children');
            }

            console.log('Creating flow job with children:', opts?.children);
            const flowJob: FlowJobWithParent = {
              name: jobData.name,
              queueName: queue.name,
              data: jobData,
              opts: {
                ...opts,
                parent: opts?.parent,
              },
              children: opts?.children?.map((child) => {
                console.log('Processing child job:', child);
                return {
                  name: child.name,
                  queueName: queue.name, // Use the same queue name as parent
                  data: child.data,
                  opts: {
                    ...child.opts,
                    parent: {
                      id: opts.jobId,
                      queue: queue.name,
                    },
                  },
                };
              }),
            };
            console.log('Created flow job:', JSON.stringify(flowJob, null, 2));

            // Add the job using FlowProducer
            const result = await flowProducer.add(flowJob as BullMQFlowJob);
            console.log('Job added successfully:', result.job.id);

            // Wait for the flow to be established and jobs to be processed
            await new Promise((resolve) => setTimeout(resolve, 2000));

            // Verify the job was added
            if (!result.job.id) {
              throw new Error('Job ID is undefined');
            }

            // Try multiple times to get the job
            let job = null;
            for (let i = 0; i < 3; i++) {
              job = await queue.getJob(result.job.id);
              if (job) break;
              await new Promise((resolve) => setTimeout(resolve, 500));
            }

            if (!job) {
              throw new Error('Job was not added successfully');
            }
            console.log('Job verified in queue:', job.id);

            return {
              name: result.job.name as JobName,
              queueName: result.job.queueName,
              data: result.job.data as T,
              opts: result.job.opts as FlowOpts<T>,
            } as FlowJob<T>;
          } catch (error) {
            console.error('Error adding job:', error);
            throw error;
          }
        },
        (error) => {
          console.error('Flow service error:', error);
          return createQueueError(QueueErrorCode.ADD_JOB, defaultName, error as Error);
        },
      ),
    );

  const close = async (): Promise<void> => {
    await queueEvents.close();
    await flowProducer.disconnect();
  };

  return {
    getFlowDependencies,
    getChildrenValues,
    addJob,
    close,
  };
};
