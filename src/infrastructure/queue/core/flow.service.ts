import { FlowJob as BullMQFlowJob, FlowProducer, Queue, QueueEvents } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createQueueError, QueueError, QueueErrorCode } from '../../../types/errors.type';
import { BaseJobData, isJobName, JobName } from '../../../types/job.type';
import { FlowJob, FlowJobWithParent, FlowOpts, FlowService, hasJobId } from '../types';

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

          // Try to get child jobs directly from the queue
          const childJobs = await queue.getJobs(['active', 'completed', 'waiting', 'delayed']);
          console.log(
            'Found jobs in queue:',
            childJobs.map((j) => ({
              id: j.id,
              data: j.data,
              parent: j.opts.parent,
            })),
          );

          // Filter child jobs by parent ID and ensure they have IDs
          const children = childJobs.filter((j): j is typeof j & { id: string } => {
            const parent = j.opts.parent;
            if (!parent) return false;
            // Handle both prefixed and unprefixed queue names
            const parentQueue = parent.queue.replace(/^bull:/, '');
            const currentQueue = queue.name.replace(/^bull:/, '');
            return parent.id === jobId && parentQueue === currentQueue && hasJobId(j);
          });
          console.log(
            'Found child jobs:',
            children.map((j) => ({
              id: j.id,
              data: j.data,
              parent: j.opts.parent,
            })),
          );

          // Convert to FlowJob array with explicit typing
          const flowJobs: FlowJob<T>[] = [];

          // Add parent job if it exists
          if (job && job.id) {
            const jobData = job.data as T;
            flowJobs.push({
              name: jobData.name as JobName,
              queueName: queue.name,
              data: {
                ...jobData,
                timestamp: new Date(jobData.timestamp),
              } as T,
              opts: {
                jobId: job.id,
              },
            });
          }

          // Add child jobs
          flowJobs.push(
            ...children.map((child) => {
              const childData = child.data as T;
              return {
                name: childData.name as JobName,
                queueName: queue.name,
                data: {
                  ...childData,
                  timestamp: new Date(childData.timestamp),
                } as T,
                opts: {
                  jobId: child.id,
                  parent: {
                    id: jobId,
                    queue: queue.name,
                  },
                },
              };
            }),
          );

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

          // Get child jobs directly
          const childJobs = await queue.getJobs(['completed', 'active', 'waiting', 'delayed']);
          console.log(
            'Found jobs for children values:',
            childJobs.map((j) => ({
              id: j.id,
              data: j.data,
              parent: j.opts.parent,
            })),
          );

          const children = childJobs.filter((j) => {
            const parent = j.opts.parent;
            if (!parent) return false;
            // Handle both prefixed and unprefixed queue names
            const parentQueue = parent.queue.replace(/^bull:/, '');
            const currentQueue = queue.name.replace(/^bull:/, '');
            return parent.id === jobId && parentQueue === currentQueue;
          });
          console.log(
            'Found child jobs for values:',
            children.map((j) => ({
              id: j.id,
              data: j.data,
              parent: j.opts.parent,
            })),
          );

          // Create a record of child values
          const values: Record<string, unknown> = {};
          for (const child of children) {
            if (child.id) {
              values[child.id] = {
                ...child.data,
                timestamp: new Date((child.data as T).timestamp),
              };
            }
          }

          return values;
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
                jobId: opts.jobId,
                parent: opts?.parent,
              },
              children: opts?.children?.map((child) => {
                console.log('Processing child job:', child);
                const childJobId = child.opts?.jobId || `child-${Date.now()}`;
                return {
                  name: child.name,
                  queueName: queue.name, // Use the same queue name as parent
                  data: {
                    ...child.data,
                    name: child.name, // Ensure name is set in data
                  },
                  opts: {
                    jobId: childJobId,
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
            if (!hasJobId(result.job)) {
              throw new Error('Job ID is undefined');
            }

            console.log('Job added successfully:', result.job.id);

            // Wait for the flow to be established and jobs to be processed
            await new Promise((resolve) => setTimeout(resolve, 3000));

            // Try multiple times to get the job
            let job = null;
            for (let i = 0; i < 5; i++) {
              job = await queue.getJob(result.job.id);
              if (job) {
                console.log('Job found in queue:', job.id);
                break;
              }
              console.log('Job not found, retrying...');
              await new Promise((resolve) => setTimeout(resolve, 500));
            }

            if (!job) {
              throw new Error('Job was not added successfully');
            }

            // Wait for child jobs to be processed and verify they exist
            await new Promise((resolve) => setTimeout(resolve, 2000));
            const childJobs = await queue.getJobs(['active', 'completed', 'waiting', 'delayed']);
            console.log(
              'All jobs in queue:',
              childJobs.map((j) => ({
                id: j.id,
                data: j.data,
                parent: j.opts.parent,
              })),
            );

            const children = childJobs.filter((j) => {
              const parent = j.opts.parent;
              if (!parent) return false;
              // Handle both prefixed and unprefixed queue names
              const parentQueue = parent.queue.replace(/^bull:/, '');
              const currentQueue = queue.name.replace(/^bull:/, '');
              return parent.id === result.job.id && parentQueue === currentQueue;
            });
            console.log(
              'Found child jobs after processing:',
              children.map((j) => ({
                id: j.id,
                data: j.data,
                parent: j.opts.parent,
              })),
            );

            if (children.length === 0 && opts?.children && opts.children.length > 0) {
              console.error('Child jobs were not created. Expected children:', opts.children);
              throw new Error('Child jobs were not created successfully');
            }

            return {
              name: result.job.name as JobName,
              queueName: result.job.queueName,
              data: result.job.data as T,
              opts: {
                jobId: result.job.id,
                parent: result.job.opts.parent,
              },
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
    try {
      // Close all connections in sequence
      await queueEvents.close();
      await flowProducer.disconnect();
      await queue.disconnect();
    } catch (error) {
      console.error('Error closing flow service:', error);
    }
  };

  // Ensure connections are established
  const init = async (): Promise<void> => {
    try {
      await queue.waitUntilReady();
      await queueEvents.waitUntilReady();
    } catch (error) {
      console.error('Error initializing flow service:', error);
      throw error;
    }
  };

  // Initialize connections
  void init();

  return {
    getFlowDependencies,
    getChildrenValues,
    addJob,
    close,
  };
};
