import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Worker, WorkflowRegistry } from "@reflow/core";
import { defineWorkflow } from "@reflow/sdk";
import { buildServer } from "@reflow/server";
import { createTestStore, startRun, type TestStore } from "./helpers.js";

let ts: TestStore;

beforeEach(async () => {
  ts = await createTestStore();
});

afterEach(async () => {
  await ts.close();
});

function makeRegistry(executions: string[], failuresBeforeSuccess: number) {
  let attempts = 0;
  return new WorkflowRegistry().register(
    defineWorkflow<null, string>({
      name: "unstable",
      async run(ctx) {
        await ctx.step("stable-step", () => {
          executions.push("stable");
          return null;
        });
        return await ctx.step("unstable-step", () => {
          attempts += 1;
          if (attempts <= failuresBeforeSuccess) {
            throw new Error(`outage ${attempts}`);
          }
          executions.push("unstable");
          return "finally worked";
        });
      },
    }),
  );
}

describe("retrying failed runs", () => {
  it("re-executes only the failed step and keeps completed steps replayed", async () => {
    const executions: string[] = [];
    const registry = makeRegistry(executions, 1);
    const worker = new Worker({ store: ts.store, registry }, { workerId: "retrier" });

    const run = await startRun(ts.store, "unstable");
    expect(await worker.tick()).toBe("failed");
    expect((await ts.store.getRun(run.id))?.error).toContain("outage 1");

    expect(await ts.store.retryRun(run.id)).toBe(true);
    expect((await ts.store.getRun(run.id))?.status).toBe("pending");

    expect(await worker.tick()).toBe("completed");
    const final = await ts.store.getRun(run.id);
    expect(final?.output).toBe("finally worked");
    expect(final?.error).toBeNull();

    expect(executions).toEqual(["stable", "unstable"]);

    const history = await ts.store.getHistory(run.id);
    expect(history.some((h) => h.event.type === "run_retried")).toBe(true);
  });

  it("refuses to retry runs that are not failed", async () => {
    const registry = makeRegistry([], 0);
    const worker = new Worker({ store: ts.store, registry }, { workerId: "retrier" });

    const run = await startRun(ts.store, "unstable");
    expect(await ts.store.retryRun(run.id)).toBe(false);

    expect(await worker.tick()).toBe("completed");
    expect(await ts.store.retryRun(run.id)).toBe(false);
  });

  it("exposes retry through the API", async () => {
    const executions: string[] = [];
    const registry = makeRegistry(executions, 1);
    const worker = new Worker({ store: ts.store, registry }, { workerId: "retrier" });
    const app = buildServer({ store: ts.store });

    const run = await startRun(ts.store, "unstable");

    const tooEarly = await app.inject({ method: "POST", url: `/api/runs/${run.id}/retry` });
    expect(tooEarly.statusCode).toBe(409);

    await worker.tick();

    const retried = await app.inject({ method: "POST", url: `/api/runs/${run.id}/retry` });
    expect(retried.statusCode).toBe(202);

    expect(await worker.tick()).toBe("completed");

    const missing = await app.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000000/retry",
    });
    expect(missing.statusCode).toBe(404);

    await app.close();
  });
});
