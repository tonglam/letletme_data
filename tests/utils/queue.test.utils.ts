import { JobName, MetaJobData, MetaOperation, MetaType } from '../../src/types/job.type';

// Test-specific operation type that extends the production MetaOperation
export type TestMetaOperation =
  | MetaOperation
  | 'JOB_1'
  | 'JOB_2'
  | 'JOB_3'
  | 'JOB_4'
  | 'JOB_5'
  | 'SCHEDULED_1'
  | 'SCHEDULED_2'
  | 'parent-1'
  | 'child-1'
  | 'child-2'
  | 'child-3';

export const createTestMetaJobData = (params?: {
  operation?: TestMetaOperation;
  metaType?: MetaType;
  name?: JobName;
}): MetaJobData => ({
  type: 'META',
  name: params?.name ?? 'meta',
  data: {
    operation: (params?.operation ?? 'SYNC') as unknown as MetaOperation,
    metaType: params?.metaType ?? 'EVENTS',
  },
  timestamp: new Date(),
});

// Helper function to validate if a string is a test operation
export const isTestOperation = (operation: string): operation is TestMetaOperation => {
  const validTestOperations = [
    'SYNC',
    'JOB_1',
    'JOB_2',
    'JOB_3',
    'JOB_4',
    'JOB_5',
    'SCHEDULED_1',
    'SCHEDULED_2',
    'parent-1',
    'child-1',
    'child-2',
    'child-3',
  ];
  return validTestOperations.includes(operation);
};

// Helper function to validate if a string is a valid operation
export const isValidOperation = (operation: string): boolean => operation === 'SYNC';
