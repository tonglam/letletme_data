export interface WorkflowContext {
  readonly workflowId: string;
  readonly startTime: Date;
}

export interface WorkflowResult<T> {
  readonly context: WorkflowContext;
  readonly result: T;
  readonly duration: number;
}

export const createWorkflowContext = (workflowId: string): WorkflowContext => ({
  workflowId,
  startTime: new Date(),
});
