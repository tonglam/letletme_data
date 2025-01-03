import { FlowJob as BullMQFlowJob, FlowProducer, Job, Queue } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueError, QueueErrorCode, createQueueError } from '../../../types/errors.type';
import { JobData } from '../../../types/job.type';
import { getQueueLogger } from '../../logger';
import { BullMQFlowDependency, FlowJob, FlowProducerOptions, FlowService } from '../types';

const logger = getQueueLogger();

const convertToBullMQFlow = <T extends JobData>(flow: FlowJob<T>): BullMQFlowJob => ({
  ...flow,
  children: flow.children?.map(convertToBullMQFlow),
});

export const createFlowService = <T extends JobData>(
  name: string,
  queue: Queue<T>,
  connection: { host: string; port: number },
): FlowService<T> => {
  const flowProducer = new FlowProducer({ connection });

  const addFlow = (
    flow: FlowJob<T>,
    options?: FlowProducerOptions,
  ): TE.TaskEither<QueueError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          await flowProducer.add(convertToBullMQFlow(flow), options);
          logger.info(
            { name, flowName: flow.name, queueName: flow.queueName },
            'Flow added successfully',
          );
        },
        (error) => createQueueError(QueueErrorCode.ADD_FLOW, name, error as Error),
      ),
    );

  const addBulkFlows = (flows: FlowJob<T>[]): TE.TaskEither<QueueError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          if (flows.length === 0) return;

          await flowProducer.addBulk(flows.map(convertToBullMQFlow));
          logger.info({ name, count: flows.length }, 'Bulk flows added successfully');
        },
        (error) => createQueueError(QueueErrorCode.ADD_BULK_FLOWS, name, error as Error),
      ),
    );

  const removeFlow = (jobId: string): TE.TaskEither<QueueError, boolean> =>
    pipe(
      TE.tryCatch(
        async () => {
          const job = await queue.getJob(jobId);
          if (!job) {
            return false;
          }

          await job.remove();
          logger.info({ name, jobId }, 'Flow removed successfully');
          return true;
        },
        (error) => createQueueError(QueueErrorCode.REMOVE_FLOW, name, error as Error),
      ),
    );

  const removeBulkFlows = (jobIds: string[]): TE.TaskEither<QueueError, boolean> =>
    pipe(
      TE.tryCatch(
        async () => {
          if (jobIds.length === 0) return true;

          const jobs = await Promise.all(jobIds.map((id) => queue.getJob(id)));
          const validJobs = jobs.filter((job): job is NonNullable<typeof job> => job !== null);

          if (validJobs.length === 0) return false;

          await Promise.all(validJobs.map((job) => job.remove()));
          logger.info({ name, count: validJobs.length, jobIds }, 'Bulk flows removed successfully');
          return true;
        },
        (error) => createQueueError(QueueErrorCode.REMOVE_BULK_FLOWS, name, error as Error),
      ),
    );

  const getFlowDependencies = (jobId: string): TE.TaskEither<QueueError, FlowJob<T>[]> =>
    pipe(
      TE.tryCatch(
        async () => {
          const job = await queue.getJob(jobId);
          if (!job) {
            return [];
          }

          const dependencies = (await job.getDependencies()) as BullMQFlowDependency[];
          return dependencies.map((dep) => ({
            name: dep.name,
            queueName: dep.queueName,
            data: dep.data as T,
            opts: dep.opts as FlowJob<T>['opts'],
          }));
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
            return {};
          }

          return (await (job as Job).getChildrenValues()) || {};
        },
        (error) => createQueueError(QueueErrorCode.GET_CHILDREN_VALUES, name, error as Error),
      ),
    );

  return {
    addFlow,
    addBulkFlows,
    removeFlow,
    removeBulkFlows,
    getFlowDependencies,
    getChildrenValues,
  };
};
