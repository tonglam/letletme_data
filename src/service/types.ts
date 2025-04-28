export interface WorkflowContext {
  readonly workflowId: string;
  readonly startTime: Date;
}

export interface WorkflowResult {
  readonly context: WorkflowContext;
  readonly duration: number;
}

export const createWorkflowContext = (workflowId: string): WorkflowContext => ({
  workflowId,
  startTime: new Date(),
});
