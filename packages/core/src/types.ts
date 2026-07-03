export type WorkflowRunId = string;

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "sleeping"
  | "completed"
  | "failed";

export interface WorkflowRun {
  id: WorkflowRunId;
  workflowName: string;
  status: WorkflowRunStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  wakeAt: Date | null;
  lockedBy: string | null;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
