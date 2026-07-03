import type { HistoryEvent, HistoryRecord } from "./events.js";
import type {
  WorkflowRun,
  WorkflowRunId,
  WorkflowRunStatus,
  WorkflowSchedule,
} from "./types.js";

export interface CreateRunInput {
  id: WorkflowRunId;
  workflowName: string;
  input: unknown;
  startAt?: Date | undefined;
  parentRunId?: WorkflowRunId | undefined;
}

export interface ListRunsOptions {
  status?: WorkflowRunStatus | undefined;
  limit?: number | undefined;
}

export interface CreateScheduleInput {
  id: string;
  workflowName: string;
  input: unknown;
  intervalMs?: number | undefined;
  cron?: string | undefined;
  firstRunAt?: Date | undefined;
}

export interface WorkflowStore {
  createRun(input: CreateRunInput): Promise<WorkflowRun>;
  getRun(id: WorkflowRunId): Promise<WorkflowRun | null>;
  listRuns(options?: ListRunsOptions): Promise<WorkflowRun[]>;

  getHistory(
    runId: WorkflowRunId,
    options?: { offset?: number | undefined; limit?: number | undefined },
  ): Promise<HistoryRecord[]>;
  appendEvent(runId: WorkflowRunId, event: HistoryEvent): Promise<void>;

  claimRun(workerId: string, lockTtlMs: number): Promise<WorkflowRun | null>;

  extendLock(runId: WorkflowRunId, workerId: string, lockTtlMs: number): Promise<boolean>;

  suspendRun(runId: WorkflowRunId, wakeAt: Date | null): Promise<void>;

  completeRun(runId: WorkflowRunId, output: unknown): Promise<void>;
  failRun(runId: WorkflowRunId, error: string): Promise<void>;

  signalRun(runId: WorkflowRunId, name: string, payload: unknown): Promise<boolean>;

  retryRun(runId: WorkflowRunId): Promise<boolean>;

  cancelRun(runId: WorkflowRunId): Promise<boolean>;

  markRunCancelled(runId: WorkflowRunId): Promise<void>;

  createSchedule(input: CreateScheduleInput): Promise<WorkflowSchedule>;

  listSchedules(): Promise<WorkflowSchedule[]>;

  deleteSchedule(id: string): Promise<boolean>;

  claimDueSchedule(): Promise<WorkflowSchedule | null>;

  purgeFinishedRuns(olderThan: Date): Promise<number>;
}
