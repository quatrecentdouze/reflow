export class NondeterminismError extends Error {
  override readonly name = "NondeterminismError";

  constructor(message: string) {
    super(message);
  }
}

export class StepFailedError extends Error {
  override readonly name = "StepFailedError";

  constructor(
    readonly stepId: string,
    readonly lastError: string,
    readonly attempts: number,
  ) {
    super(`step "${stepId}" failed after ${attempts} attempt(s): ${lastError}`);
  }
}

export class WorkflowCancelledError extends Error {
  override readonly name = "WorkflowCancelledError";

  constructor(readonly runId: string) {
    super(`run ${runId} was cancelled`);
  }
}

export class ChildWorkflowFailedError extends Error {
  override readonly name = "ChildWorkflowFailedError";

  constructor(
    readonly workflowName: string,
    readonly childRunId: string,
    readonly childError: string,
  ) {
    super(`child workflow "${workflowName}" (run ${childRunId}) failed: ${childError}`);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
