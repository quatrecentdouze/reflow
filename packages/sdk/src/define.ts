import type { WorkflowDefinition } from "@reflow/core";

export function defineWorkflow<TInput, TOutput>(
  definition: WorkflowDefinition<TInput, TOutput>,
): WorkflowDefinition<TInput, TOutput> {
  return definition;
}
