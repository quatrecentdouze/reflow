import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Worker, WorkflowRegistry } from "@reflow/core";
import { defineWorkflow } from "@reflow/sdk";
import { buildServer } from "@reflow/server";
import { createTestStore, delay, startRun, type TestStore } from "./helpers.js";

let ts: TestStore;

beforeEach(async () => {
  ts = await createTestStore();
});

afterEach(async () => {
  await ts.close();
});

describe("cancellation", () => {
  it("cancels a pending run before it ever executes", async () => {
    const executed: string[] = [];
    const registry = new WorkflowRegistry().register(
      defineWorkflow<null, void>({
        name: "never-runs",
        async run(ctx) {
          await ctx.step("work", () => {
            executed.push("work");
            return null;
          });
        },
      }),
    );

    const run = await startRun(ts.store, "never-runs");
    expect(await ts.store.cancelRun(run.id)).toBe(true);
    expect((await ts.store.getRun(run.id))?.status).toBe("cancelled");

    const worker = new Worker({ store: ts.store, registry }, { workerId: "c" });
    expect(await worker.tick()).toBeNull();
    expect(executed).toEqual([]);
  });

  it("cancels a sleeping run so its timer never fires", async () => {
    const executed: string[] = [];
    const registry = new WorkflowRegistry().register(
      defineWorkflow<null, void>({
        name: "long-sleeper",
        async run(ctx) {
          await ctx.step("before", () => {
            executed.push("before");
            return null;
          });
          await ctx.sleep(30);
          await ctx.step("after", () => {
            executed.push("after");
            return null;
          });
        },
      }),
    );

    const run = await startRun(ts.store, "long-sleeper");
    const worker = new Worker({ store: ts.store, registry }, { workerId: "c" });

    expect(await worker.tick()).toBe("suspended");
    expect(await ts.store.cancelRun(run.id)).toBe(true);
    expect((await ts.store.getRun(run.id))?.status).toBe("cancelled");

    await delay(50);
    expect(await worker.tick()).toBeNull();
    expect(executed).toEqual(["before"]);
  });

  it("cancels a running run cooperatively at the next durable operation", async () => {
    const executed: string[] = [];
    const registry = new WorkflowRegistry().register(
      defineWorkflow<null, void>({
        name: "self-cancelling",
        async run(ctx) {
          await ctx.step("cancel-arrives-mid-run", async () => {
            executed.push("first");
            await ts.store.cancelRun(ctx.runId);
            return null;
          });
          await ctx.sleep(5);
          await ctx.step("after", () => {
            executed.push("after");
            return null;
          });
        },
      }),
    );

    const run = await startRun(ts.store, "self-cancelling");
    const worker = new Worker({ store: ts.store, registry }, { workerId: "c" });

    expect(await worker.tick()).toBe("suspended");
    await delay(10);
    expect(await worker.tick()).toBe("cancelled");

    expect((await ts.store.getRun(run.id))?.status).toBe("cancelled");
    expect(executed).toEqual(["first"]);
  });

  it("refuses to cancel finished runs and exposes cancel through the API", async () => {
    const registry = new WorkflowRegistry().register(
      defineWorkflow<null, string>({
        name: "instant",
        async run() {
          return "done";
        },
      }),
    );
    const worker = new Worker({ store: ts.store, registry }, { workerId: "c" });
    const app = buildServer({ store: ts.store });

    const finished = await startRun(ts.store, "instant");
    await worker.tick();

    const conflict = await app.inject({
      method: "POST",
      url: `/api/runs/${finished.id}/cancel`,
    });
    expect(conflict.statusCode).toBe(409);

    const missing = await app.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000000/cancel",
    });
    expect(missing.statusCode).toBe(404);

    const pending = await startRun(ts.store, "instant");
    const accepted = await app.inject({
      method: "POST",
      url: `/api/runs/${pending.id}/cancel`,
    });
    expect(accepted.statusCode).toBe(202);
    expect((await ts.store.getRun(pending.id))?.status).toBe("cancelled");

    await app.close();
  });
});
