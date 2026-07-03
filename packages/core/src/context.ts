export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  maxDelayMs?: number;
}

export interface StepOptions {
  retry?: RetryPolicy;
}

export interface WorkflowContext {
  readonly runId: string;

  step<T>(id: string, fn: () => Promise<T> | T, options?: StepOptions): Promise<T>;

  sleep(ms: number): Promise<void>;

  waitForSignal<T = unknown>(name: string): Promise<T>;

  now(): Promise<Date>;

  random(): Promise<number>;

  child<T = unknown>(workflowName: string, input?: unknown): Promise<T>;
}
