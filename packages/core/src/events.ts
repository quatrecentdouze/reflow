import type { WorkflowRunId } from "./types.js";

export type HistoryEvent =
  | { type: "run_started"; input: unknown }
  | { type: "step_completed"; opIndex: number; stepId: string; result: unknown }
  | {
      type: "step_failed";
      opIndex: number;
      stepId: string;
      attempt: number;
      error: string;
      retryAt?: string;
    }
  | { type: "timer_started"; opIndex: number; wakeAt: string }
  | { type: "timer_fired"; opIndex: number }
  | { type: "value_recorded"; opIndex: number; kind: "now" | "random"; value: unknown }
  | { type: "child_started"; opIndex: number; childRunId: string; workflowName: string }
  | { type: "signal_received"; name: string; payload: unknown }
  | { type: "run_completed"; output: unknown }
  | { type: "run_failed"; error: string };

export type HistoryEventType = HistoryEvent["type"];

export interface HistoryRecord {
  runId: WorkflowRunId;
  seq: number;
  event: HistoryEvent;
  recordedAt: Date;
}
