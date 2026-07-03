import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Worker, WorkflowRegistry } from "@reflow/core";
import { defineWorkflow } from "@reflow/sdk";
import { createTestStore, startRun, waitFor, type TestStore } from "./helpers.js";

let ts: TestStore;

beforeEach(async () => {
  ts = await createTestStore();
});

afterEach(async () => {
  await ts.close();
});

describe("child workflows", () => {
  it("runs children and returns their outputs to the parent", async () => {
    const childExecutions: string[] = [];
    const registry = new WorkflowRegistry()
      .register(
        defineWorkflow<{ name: string }, string>({
          name: "greet-child",
          async run(ctx, input) {
            return await ctx.step("greet", () => {
              childExecutions.push(input.name);
              return `hello ${input.name}`;
            });
          },
        }),
      )
      .register(
        defineWorkflow<{ names: string[] }, string[]>({
          name: "greet-all",
          async run(ctx, input) {
            const greetings: string[] = [];
            for (const name of input.names) {
              greetings.push(await ctx.child<string>("greet-child", { name }));
            }
            return greetings;
          },
        }),
      );

    const parent = await startRun(ts.store, "greet-all", { names: ["ada", "grace"] });
    const worker = new Worker({ store: ts.store, registry }, { workerId: "family" });

    worker.start();
    try {
      await waitFor(async () => {
        const run = await ts.store.getRun(parent.id);
        return run?.status === "completed";
      });
    } finally {
      await worker.stop();
    }

    const final = await ts.store.getRun(parent.id);
    expect(final?.output).toEqual(["hello ada", "hello grace"]);
    expect(childExecutions).toEqual(["ada", "grace"]);

    const children = await ts.store.listRuns({});
    const childRuns = children.filter((r) => r.parentRunId === parent.id);
    expect(childRuns).toHaveLength(2);
    expect(childRuns.every((r) => r.status === "completed")).toBe(true);
  });

  it("fails the parent when a child fails", async () => {
    const registry = new WorkflowRegistry()
      .register(
        defineWorkflow<null, never>({
          name: "doomed-child",
          async run(ctx) {
            return await ctx.step("explode", () => {
              throw new Error("child boom");
            });
          },
        }),
      )
      .register(
        defineWorkflow<null, unknown>({
          name: "trusting-parent",
          async run(ctx) {
            return await ctx.child("doomed-child");
          },
        }),
      );

    const parent = await startRun(ts.store, "trusting-parent");
    const worker = new Worker({ store: ts.store, registry }, { workerId: "family" });

    worker.start();
    try {
      await waitFor(async () => {
        const run = await ts.store.getRun(parent.id);
        return run?.status === "failed";
      });
    } finally {
      await worker.stop();
    }

    const final = await ts.store.getRun(parent.id);
    expect(final?.error).toContain("doomed-child");
    expect(final?.error).toContain("child boom");
  });

  it("lets the parent catch a child failure and recover", async () => {
    const registry = new WorkflowRegistry()
      .register(
        defineWorkflow<null, never>({
          name: "doomed-child",
          async run(ctx) {
            return await ctx.step("explode", () => {
              throw new Error("child boom");
            });
          },
        }),
      )
      .register(
        defineWorkflow<null, string>({
          name: "careful-parent",
          async run(ctx) {
            try {
              await ctx.child("doomed-child");
              return "child succeeded";
            } catch {
              return await ctx.step("fallback", () => "recovered from child failure");
            }
          },
        }),
      );

    const parent = await startRun(ts.store, "careful-parent");
    const worker = new Worker({ store: ts.store, registry }, { workerId: "family" });

    worker.start();
    try {
      await waitFor(async () => {
        const run = await ts.store.getRun(parent.id);
        return run?.status === "completed";
      });
    } finally {
      await worker.stop();
    }

    expect((await ts.store.getRun(parent.id))?.output).toBe("recovered from child failure");
  });
});
