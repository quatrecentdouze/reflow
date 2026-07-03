import type { StepOptions, WorkflowContext } from "../context.js";
import type { HistoryEvent, HistoryRecord } from "../events.js";
import { NondeterminismError, StepFailedError, errorMessage } from "../errors.js";
import type { WorkflowStore } from "../store.js";
import { computeRetryDelayMs } from "./backoff.js";
import { Suspension } from "./suspension.js";

interface StepFailure {
  attempt: number;
  error: string;
  retryAt?: string;
}

interface OpState {
  completion?:
    | { kind: "step"; stepId: string; result: unknown }
    | { kind: "timer" };
  timerStartedAt?: string;
  failures: StepFailure[];
}

export class ReplayContext implements WorkflowContext {
  readonly runId: string;

  private opCounter = 0;
  private readonly ops = new Map<number, OpState>();
  private readonly signalsByName = new Map<string, unknown[]>();
  private readonly signalCursor = new Map<string, number>();
  private readonly store: WorkflowStore;

  constructor(runId: string, history: HistoryRecord[], store: WorkflowStore) {
    this.runId = runId;
    this.store = store;
    for (const record of history) {
      this.index(record.event);
    }
  }

  private index(event: HistoryEvent): void {
    switch (event.type) {
      case "step_completed":
        this.op(event.opIndex).completion = {
          kind: "step",
          stepId: event.stepId,
          result: event.result,
        };
        break;
      case "step_failed": {
        const failure: StepFailure = { attempt: event.attempt, error: event.error };
        if (event.retryAt !== undefined) failure.retryAt = event.retryAt;
        this.op(event.opIndex).failures.push(failure);
        break;
      }
      case "timer_started":
        this.op(event.opIndex).timerStartedAt = event.wakeAt;
        break;
      case "timer_fired":
        this.op(event.opIndex).completion = { kind: "timer" };
        break;
      case "signal_received": {
        const list = this.signalsByName.get(event.name) ?? [];
        list.push(event.payload);
        this.signalsByName.set(event.name, list);
        break;
      }
      default:
        break;
    }
  }

  private op(opIndex: number): OpState {
    let state = this.ops.get(opIndex);
    if (!state) {
      state = { failures: [] };
      this.ops.set(opIndex, state);
    }
    return state;
  }

  private append(event: HistoryEvent): Promise<void> {
    return this.store.appendEvent(this.runId, event);
  }

  async step<T>(id: string, fn: () => Promise<T> | T, options?: StepOptions): Promise<T> {
    const opIndex = this.opCounter++;
    const op = this.ops.get(opIndex);

    if (op?.completion) {
      if (op.completion.kind !== "step" || op.completion.stepId !== id) {
        throw new NondeterminismError(
          `operation #${opIndex}: history records ${describeCompletion(op.completion)} but code executed step "${id}"`,
        );
      }
      return op.completion.result as T;
    }

    const failures = op?.failures ?? [];
    const maxAttempts = options?.retry?.maxAttempts ?? 1;

    if (failures.length >= maxAttempts) {
      const last = failures[failures.length - 1]!;
      throw new StepFailedError(id, last.error, failures.length);
    }

    const lastRetryAt = failures[failures.length - 1]?.retryAt;
    if (lastRetryAt !== undefined) {
      const retryAt = new Date(lastRetryAt);
      if (retryAt.getTime() > Date.now()) throw new Suspension(retryAt);
    }

    try {
      const result = await fn();
      await this.append({
        type: "step_completed",
        opIndex,
        stepId: id,
        result: result ?? null,
      });
      return result;
    } catch (err) {
      if (err instanceof Suspension) throw err;
      const attempt = failures.length + 1;
      const message = errorMessage(err);

      if (attempt < maxAttempts) {
        const delayMs = computeRetryDelayMs(options!.retry!, attempt);
        const retryAt = new Date(Date.now() + delayMs);
        await this.append({
          type: "step_failed",
          opIndex,
          stepId: id,
          attempt,
          error: message,
          retryAt: retryAt.toISOString(),
        });
        throw new Suspension(retryAt);
      }

      await this.append({ type: "step_failed", opIndex, stepId: id, attempt, error: message });
      throw new StepFailedError(id, message, attempt);
    }
  }

  async sleep(ms: number): Promise<void> {
    const opIndex = this.opCounter++;
    const op = this.ops.get(opIndex);

    if (op?.completion) {
      if (op.completion.kind !== "timer") {
        throw new NondeterminismError(
          `operation #${opIndex}: history records ${describeCompletion(op.completion)} but code executed sleep()`,
        );
      }
      return;
    }

    if (op?.timerStartedAt !== undefined) {
      const wakeAt = new Date(op.timerStartedAt);
      if (wakeAt.getTime() <= Date.now()) {
        await this.append({ type: "timer_fired", opIndex });
        return;
      }
      throw new Suspension(wakeAt);
    }

    const wakeAt = new Date(Date.now() + ms);
    await this.append({ type: "timer_started", opIndex, wakeAt: wakeAt.toISOString() });
    throw new Suspension(wakeAt);
  }

  async waitForSignal<T = unknown>(name: string): Promise<T> {
    this.opCounter++;
    const received = this.signalsByName.get(name) ?? [];
    const cursor = this.signalCursor.get(name) ?? 0;

    if (cursor < received.length) {
      this.signalCursor.set(name, cursor + 1);
      return received[cursor] as T;
    }

    throw new Suspension(null);
  }
}

function describeCompletion(completion: NonNullable<OpState["completion"]>): string {
  return completion.kind === "step" ? `step "${completion.stepId}"` : "a timer";
}
