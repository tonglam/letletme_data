import { JobName, MetaJobData, MetaOperation, MetaType } from '../../src/types/job.type';
import { QueueConfig, QueueConnection } from '../../src/types/queue.type';

export const createTestQueueConfig = (params?: {
  host?: string;
  port?: number;
  password?: string;
}): QueueConfig => {
  const connection: QueueConnection = {
    host: params?.host ?? 'localhost',
    port: params?.port ?? 6379,
    password: params?.password ?? undefined,
  };

  return {
    connection,
  };
};

export const createTestMetaJobData = (params?: {
  operation?: MetaOperation;
  metaType?: MetaType;
  name?: JobName;
}): MetaJobData => ({
  type: 'META',
  name: params?.name ?? 'meta',
  data: {
    operation: params?.operation ?? 'SYNC',
    metaType: params?.metaType ?? 'EVENTS',
  },
  timestamp: new Date(),
});
