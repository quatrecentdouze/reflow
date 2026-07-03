import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Worker,
  WorkflowRegistry,
  type WorkflowContext,
  type WorkflowDefinition,
} from "@reflow/core";
import { defineWorkflow } from "@reflow/sdk";
import { createTestStore, delay, startRun, type TestStore } from "./helpers.js";

let ts: TestStore;

beforeEach(async () => {
  ts = await createTestStore();
});

afterEach(async () => {
  await ts.close();
});

function makeWorker(registry: WorkflowRegistry, lockTtlMs = 5_000): Worker {
  return new Worker({ store: ts.store, registry }, { workerId: "test-worker", lockTtlMs });
}

describe("happy path", () => {
  it("executes steps in order and completes the run", async () => {
    const executed: string[] = [];
    const registry = new WorkflowRegistry().register(
      defineWorkflow<{ name: string }, { greeting: string }>({
        name: "greet",
        async run(ctx, input) {
          const upper = await ctx.step("uppercase", () => {
            executed.push("uppercase");
            return input.name.toUpperCase();
          });
          const greeting = await ctx.step("format", () => {
            executed.push("format");
            return `Hello, ${upper}!`;
          });
          return { greeting };
        },
      }),
    );

    const run = await startRun(ts.store, "greet", { name: "ada" });
    const outcome = await makeWorker(registry).tick();

    expect(outcome).toBe("completed");
    expect(executed).toEqual(["uppercase", "format"]);

    const final = await ts.store.getRun(run.id);
    expect(final?.status).toBe("completed");
    expect(final?.output).toEqual({ greeting: "Hello, ADA!" });

    const history = await ts.store.getHistory(run.id);
    expect(history.map((h) => h.event.type)).toEqual([
      "run_started",
      "step_completed",
      "step_completed",
      "run_completed",
    ]);
  });

  it("returns null when nothing is due", async () => {
    const outcome = await makeWorker(new WorkflowRegistry()).tick();
    expect(outcome).toBeNull();
  });
});

describe("retries and replay", () => {
  it("retries a transient failure without re-executing previous steps", async () => {
    const executions = { first: 0, flaky: 0 };
    const registry = new WorkflowRegistry().register(
      defineWorkflow<null, string>({
        name: "flaky",
        async run(ctx) {
          await ctx.step("first", () => {
            executions.first += 1;
            return "ok";
          });
          return await ctx.step(
            "flaky",
            () => {
              executions.flaky += 1;
              if (executions.flaky < 2) throw new Error("transient boom");
              return "recovered";
            },
            { retry: { maxAttempts: 3, initialDelayMs: 30 } },
          );
        },
      }),
    );

    const run = await startRun(ts.store, "flaky");
    const worker = makeWorker(registry);

    expect(await worker.tick()).toBe("suspended");
    expect(await worker.tick()).toBeNull();

    await delay(60);
    expect(await worker.tick()).toBe("completed");

    expect(executions.first).toBe(1);
    expect(executions.flaky).toBe(2);

    const final = await ts.store.getRun(run.id);
    expect(final?.output).toBe("recovered");
  });

  it("fails the run once retries are exhausted", async () => {
    const registry = new WorkflowRegistry().register(
      defineWorkflow<null, void>({
        name: "doomed",
        async run(ctx) {
          await ctx.step(
            "always-fails",
            () => {
              throw new Error("permanent boom");
            },
            { retry: { maxAttempts: 2, initialDelayMs: 10 } },
          );
        },
      }),
    );

    const run = await startRun(ts.store, "doomed");
    const worker = makeWorker(registry);

    expect(await worker.tick()).toBe("suspended");
    await delay(30);
    expect(await worker.tick()).toBe("failed");

    const final = await ts.store.getRun(run.id);
    expect(final?.status).toBe("failed");
    expect(final?.error).toContain("permanent boom");

    const history = await ts.store.getHistory(run.id);
    const failures = history.filter((h) => h.event.type === "step_failed");
    expect(failures).toHaveLength(2);
  });

  it("lets workflow code catch a StepFailedError and continue", async () => {
    const registry = new WorkflowRegistry().register(
      defineWorkflow<null, string>({
        name: "recovering",
        async run(ctx) {
          try {
            await ctx.step("bad", () => {
              throw new Error("nope");
            });
          } catch {
            return await ctx.step("fallback", () => "plan B");
          }
          return "unreachable";
        },
      }),
    );

    const run = await startRun(ts.store, "recovering");
    expect(await makeWorker(registry).tick()).toBe("completed");
    expect((await ts.store.getRun(run.id))?.output).toBe("plan B");
  });
});

describe("durable timers", () => {
  it("suspends on sleep and resumes once due, without re-executing steps", async () => {
    const executions = { before: 0, after: 0 };
    const registry = new WorkflowRegistry().register(
      defineWorkflow<null, string>({
        name: "sleeper",
        async run(ctx) {
          await ctx.step("before", () => {
            executions.before += 1;
            return null;
          });
          await ctx.sleep(50);
          await ctx.step("after", () => {
            executions.after += 1;
            return null;
          });
          return "woke up";
        },
      }),
    );

    const run = await startRun(ts.store, "sleeper");
    const worker = makeWorker(registry);

    expect(await worker.tick()).toBe("suspended");
    const sleeping = await ts.store.getRun(run.id);
    expect(sleeping?.status).toBe("sleeping");
    expect(sleeping?.wakeAt).not.toBeNull();

    expect(await worker.tick()).toBeNull();

    await delay(70);
    expect(await worker.tick()).toBe("completed");
    expect(executions).toEqual({ before: 1, after: 1 });
  });
});

describe("signals", () => {
  const approval = defineWorkflow<{ item: string }, string>({
    name: "approval",
    async run(ctx, input) {
      await ctx.step("request-approval", () => `asking for ${input.item}`);
      const decision = await ctx.waitForSignal<{ approved: boolean }>("decision");
      return decision.approved ? "approved" : "rejected";
    },
  });

  it("suspends until the signal arrives and receives its payload", async () => {
    const registry = new WorkflowRegistry().register(approval);
    const run = await startRun(ts.store, "approval", { item: "laptop" });
    const worker = makeWorker(registry);

    expect(await worker.tick()).toBe("suspended");
    const waiting = await ts.store.getRun(run.id);
    expect(waiting?.status).toBe("sleeping");
    expect(waiting?.wakeAt).toBeNull();

    expect(await worker.tick()).toBeNull();

    expect(await ts.store.signalRun(run.id, "decision", { approved: true })).toBe(true);
    expect(await worker.tick()).toBe("completed");
    expect((await ts.store.getRun(run.id))?.output).toBe("approved");
  });

  it("rejects signals to unknown or finished runs", async () => {
    expect(
      await ts.store.signalRun("00000000-0000-0000-0000-000000000000", "x", null),
    ).toBe(false);

    const registry = new WorkflowRegistry().register(
      defineWorkflow<null, string>({
        name: "instant",
        async run() {
          return "done";
        },
      }),
    );
    const run = await startRun(ts.store, "instant");
    await makeWorker(registry).tick();
    expect(await ts.store.signalRun(run.id, "x", null)).toBe(false);
  });
});

describe("failure modes", () => {
  it("fails a run whose workflow is not registered", async () => {
    const run = await startRun(ts.store, "ghost");
    expect(await makeWorker(new WorkflowRegistry()).tick()).toBe("failed");
    expect((await ts.store.getRun(run.id))?.error).toContain("ghost");
  });

  it("detects nondeterministic code changes between executions", async () => {
    const v1 = defineWorkflow<null, string>({
      name: "evolving",
      async run(ctx) {
        await ctx.step("step-a", () => "a");
        await ctx.sleep(10);
        return "v1";
      },
    });
    const v2: WorkflowDefinition = {
      name: "evolving",
      async run(ctx: WorkflowContext) {
        await ctx.step("step-RENAMED", () => "a");
        await ctx.sleep(10);
        return "v2";
      },
    };

    const run = await startRun(ts.store, "evolving");
    expect(await makeWorker(new WorkflowRegistry().register(v1)).tick()).toBe("suspended");

    await delay(20);
    expect(await makeWorker(new WorkflowRegistry().register(v2)).tick()).toBe("failed");
    expect((await ts.store.getRun(run.id))?.error).toContain("step-RENAMED");
  });
});
