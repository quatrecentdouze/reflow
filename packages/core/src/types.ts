export type WorkflowRunId = string;

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "sleeping"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowSchedule {
  id: string;
  workflowName: string;
  input: unknown;
  intervalMs: number;
  nextRunAt: Date;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowRun {
  id: WorkflowRunId;
  workflowName: string;
  status: WorkflowRunStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  wakeAt: Date | null;
  parentRunId: WorkflowRunId | null;
  lockedBy: string | null;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
