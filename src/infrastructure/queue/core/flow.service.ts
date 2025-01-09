import { FlowJob as BullMQFlowJob, FlowProducer, Queue, QueueEvents } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createQueueError, QueueError, QueueErrorCode } from '../../../types/error.type';
import { isJobName, JobName, MetaJobData } from '../../../types/job.type';
import { FlowJob, FlowJobWithParent, FlowOpts, FlowService, hasJobId } from '../types';

export const createFlowService = <T extends MetaJobData>(
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
          const job = await queue.getJob(jobId);
          if (!job) {
            return [];
          }

          const childJobs = await queue.getJobs(['active', 'completed', 'waiting', 'delayed']);
          const children = childJobs.filter((j): j is typeof j & { id: string } => {
            const parent = j.opts.parent;
            if (!parent) return false;
            const parentQueue = parent.queue.replace(/^bull:/, '');
            const currentQueue = queue.name.replace(/^bull:/, '');
            return parent.id === jobId && parentQueue === currentQueue && hasJobId(j);
          });

          const flowJobs: FlowJob<T>[] = [];

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
        (error) =>
          createQueueError(QueueErrorCode.GET_FLOW_DEPENDENCIES, defaultName, error as Error),
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

          const childJobs = await queue.getJobs(['completed', 'active', 'waiting', 'delayed']);
          const children = childJobs.filter((j) => {
            const parent = j.opts.parent;
            if (!parent) return false;
            const parentQueue = parent.queue.replace(/^bull:/, '');
            const currentQueue = queue.name.replace(/^bull:/, '');
            return parent.id === jobId && parentQueue === currentQueue;
          });

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

  const validateJobId = (opts: FlowOpts<T> | undefined): TE.TaskEither<QueueError, string> => {
    if (!opts?.jobId || typeof opts.jobId !== 'string' || opts.jobId.length === 0) {
      return TE.left(
        createQueueError(
          QueueErrorCode.ADD_JOB,
          defaultName,
          new Error('Parent job ID is required for flow jobs with children'),
        ),
      );
    }
    return TE.right(opts.jobId);
  };

  const addJob = (data: T, opts?: FlowOpts<T>): TE.TaskEither<QueueError, FlowJob<T>> =>
    pipe(
      TE.Do,
      TE.bind('jobData', () =>
        TE.right({
          ...data,
          name: isJobName(data.name) ? data.name : defaultName,
        }),
      ),
      TE.bind('jobId', () => validateJobId(opts)),
      TE.bind('flowJob', ({ jobData, jobId }) =>
        TE.right({
          name: jobData.name,
          queueName: queue.name,
          data: jobData,
          opts: {
            jobId,
            parent: opts?.parent,
          },
          children: opts?.children?.map((child) => ({
            name: child.name,
            queueName: queue.name,
            data: {
              ...child.data,
              name: child.name,
            },
            opts: {
              jobId: child.opts?.jobId || `child-${Date.now()}`,
              parent: {
                id: jobId,
                queue: queue.name,
              },
            },
          })),
        } as FlowJobWithParent),
      ),
      TE.chain(({ flowJob }) =>
        TE.tryCatch(
          async () => {
            const result = await flowProducer.add(flowJob as BullMQFlowJob);
            if (!hasJobId(result.job)) {
              throw new Error('Job ID is undefined');
            }
            return result;
          },
          (error) => createQueueError(QueueErrorCode.ADD_JOB, defaultName, error as Error),
        ),
      ),
      TE.chain((result) =>
        TE.tryCatch(
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 3000));

            let job = null;
            if (!hasJobId(result.job)) {
              throw new Error('Job ID is undefined');
            }

            for (let i = 0; i < 5; i++) {
              job = await queue.getJob(result.job.id);
              if (job) break;
              await new Promise((resolve) => setTimeout(resolve, 500));
            }

            if (!job) {
              throw new Error('Job was not added successfully');
            }

            if (opts?.children?.length) {
              await new Promise((resolve) => setTimeout(resolve, 2000));
              const childJobs = await queue.getJobs(['active', 'completed', 'waiting', 'delayed']);
              const children = childJobs.filter((j) => {
                const parent = j.opts.parent;
                if (!parent) return false;
                const parentQueue = parent.queue.replace(/^bull:/, '');
                const currentQueue = queue.name.replace(/^bull:/, '');
                return parent.id === result.job.id && parentQueue === currentQueue;
              });

              if (children.length === 0) {
                throw new Error('Child jobs were not created successfully');
              }
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
          },
          (error) => createQueueError(QueueErrorCode.ADD_JOB, defaultName, error as Error),
        ),
      ),
    );

  const close = async (): Promise<void> => {
    const result = await pipe(
      TE.tryCatch(
        async () => {
          await queueEvents.close();
          await flowProducer.disconnect();
          await queue.disconnect();
        },
        (error) => createQueueError(QueueErrorCode.STOP_WORKER, defaultName, error as Error),
      ),
    )();
    if (result._tag === 'Left') {
      throw result.left;
    }
  };

  const init = async (): Promise<void> => {
    const result = await pipe(
      TE.tryCatch(
        async () => {
          await queue.waitUntilReady();
          await queueEvents.waitUntilReady();
          // Flow producer is ready when created
        },
        (error) => createQueueError(QueueErrorCode.START_WORKER, defaultName, error as Error),
      ),
    )();
    if (result._tag === 'Left') {
      throw result.left;
    }
  };

  return {
    getFlowDependencies,
    getChildrenValues,
    addJob,
    close,
    init,
  };
};
