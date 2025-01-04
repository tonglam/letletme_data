import { Job, Queue } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createQueueError, QueueError, QueueErrorCode } from '../../../types/errors.type';
import { FlowJob, FlowOpts, FlowService } from '../types';

interface BullMQFlowDependency {
  name: string;
  queueName: string;
  data: unknown;
  opts?: {
    jobId?: string;
  };
}

export const createFlowService = <T>(queue: Queue, name: string): FlowService<T> => {
  const getFlowDependencies = (jobId: string): TE.TaskEither<QueueError, FlowJob<T>[]> =>
    pipe(
      TE.tryCatch(
        async () => {
          const job = await queue.getJob(jobId);
          if (!job) {
            return [];
          }

          const dependencies = (await job.getDependencies()) as BullMQFlowDependency[];
          const childJobs = await Promise.all(
            dependencies.map(async (dep) => {
              const childJob = await queue.getJob(dep.opts?.jobId || dep.name);
              if (!childJob) return null;
              return {
                name: dep.name,
                queueName: dep.queueName,
                data: dep.data as T,
                opts: dep.opts as FlowJob<T>['opts'],
                children: [] as FlowJob<T>[],
              } as FlowJob<T>;
            }),
          );

          return childJobs.filter((job: FlowJob<T> | null): job is FlowJob<T> => job !== null);
        },
        (error) => createQueueError(QueueErrorCode.GET_FLOW_DEPENDENCIES, name, error as Error),
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

          const values = await (job as Job).getChildrenValues();
          return (values || {}) as Record<string, unknown>;
        },
        (error) => createQueueError(QueueErrorCode.GET_CHILDREN_VALUES, name, error as Error),
      ),
    );

  const addJob = (data: T, opts?: FlowOpts): TE.TaskEither<QueueError, FlowJob<T>> =>
    pipe(
      TE.tryCatch(
        async () => {
          const job = await queue.add(name, data, {
            ...opts,
            parent: opts?.parent ? { id: opts.parent.id, queue: opts.parent.queue } : undefined,
          });

          return {
            name: job.name,
            queueName: job.queueName,
            data: job.data as T,
            opts: job.opts as FlowJob<T>['opts'],
            children: [] as FlowJob<T>[],
          } as FlowJob<T>;
        },
        (error) => createQueueError(QueueErrorCode.ADD_JOB, name, error as Error),
      ),
    );

  return {
    getFlowDependencies,
    getChildrenValues,
    addJob,
  };
};
