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

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
