import type { WorkflowRegistry } from "../definition.js";
import { errorMessage } from "../errors.js";
import type { WorkflowStore } from "../store.js";
import type { WorkflowRun } from "../types.js";
import { ReplayContext } from "./replay-context.js";
import { Suspension } from "./suspension.js";

export type ExecutionOutcome = "completed" | "failed" | "suspended";

export interface ExecutorDeps {
  store: WorkflowStore;
  registry: WorkflowRegistry;
}

export async function executeClaimedRun(
  run: WorkflowRun,
  deps: ExecutorDeps,
): Promise<ExecutionOutcome> {
  const { store, registry } = deps;

  const definition = registry.get(run.workflowName);
  if (!definition) {
    const message = `no workflow registered under name "${run.workflowName}"`;
    await store.appendEvent(run.id, { type: "run_failed", error: message });
    await store.failRun(run.id, message);
    return "failed";
  }

  const history = await store.getHistory(run.id);
  const ctx = new ReplayContext(run.id, history, store);

  try {
    const output = (await definition.run(ctx, run.input)) ?? null;
    await store.appendEvent(run.id, { type: "run_completed", output });
    await store.completeRun(run.id, output);
    return "completed";
  } catch (err) {
    if (err instanceof Suspension) {
      await store.suspendRun(run.id, err.wakeAt);
      return "suspended";
    }
    const message = errorMessage(err);
    await store.appendEvent(run.id, { type: "run_failed", error: message });
    await store.failRun(run.id, message);
    return "failed";
  }
}
