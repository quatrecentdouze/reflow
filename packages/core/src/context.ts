export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  maxDelayMs?: number;
}

export interface StepOptions {
  retry?: RetryPolicy;
}

export type SignalWaitResult<T> =
  | { received: true; payload: T }
  | { received: false };

export interface WorkflowContext {
  readonly runId: string;

  step<T>(id: string, fn: () => Promise<T> | T, options?: StepOptions): Promise<T>;

  sleep(ms: number): Promise<void>;

  waitForSignal<T = unknown>(name: string): Promise<T>;

  waitForSignal<T = unknown>(
    name: string,
    options: { timeoutMs: number },
  ): Promise<SignalWaitResult<T>>;

  now(): Promise<Date>;

  random(): Promise<number>;

  child<T = unknown>(workflowName: string, input?: unknown): Promise<T>;

  version(changeId: string, maxVersion: number): Promise<number>;
}
