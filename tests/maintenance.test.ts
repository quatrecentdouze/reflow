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

const registry = new WorkflowRegistry().register(
  defineWorkflow<{ n: number }, number>({
    name: "counter",
    async run(ctx, input) {
      await ctx.step("one", () => 1);
      await ctx.step("two", () => 2);
      return await ctx.step("total", () => input.n);
    },
  }),
);

describe("history pagination", () => {
  it("pages through events with offset and limit", async () => {
    const run = await startRun(ts.store, "counter", { n: 42 });
    await new Worker({ store: ts.store, registry }, { workerId: "m" }).tick();

    const full = await ts.store.getHistory(run.id);
    expect(full).toHaveLength(5);

    const firstPage = await ts.store.getHistory(run.id, { limit: 2 });
    expect(firstPage.map((h) => h.seq)).toEqual([0, 1]);

    const secondPage = await ts.store.getHistory(run.id, { offset: 2, limit: 2 });
    expect(secondPage.map((h) => h.seq)).toEqual([2, 3]);

    const app = buildServer({ store: ts.store });
    const paged = await app.inject({
      method: "GET",
      url: `/api/runs/${run.id}/history?offset=3&limit=2`,
    });
    expect(paged.statusCode).toBe(200);
    const body = paged.json();
    expect(body.offset).toBe(3);
    expect(body.count).toBe(2);
    expect(body.events.map((e: { seq: number }) => e.seq)).toEqual([3, 4]);

    const missing = await app.inject({
      method: "GET",
      url: "/api/runs/00000000-0000-0000-0000-000000000000/history",
    });
    expect(missing.statusCode).toBe(404);

    await app.close();
  });
});

describe("run retention purge", () => {
  it("deletes finished runs and their events but keeps active ones", async () => {
    const worker = new Worker({ store: ts.store, registry }, { workerId: "m" });

    const finished = await startRun(ts.store, "counter", { n: 1 });
    await worker.tick();
    const active = await startRun(ts.store, "counter", { n: 2 });

    const purged = await ts.store.purgeFinishedRuns(new Date(Date.now() + 1_000));
    expect(purged).toBe(1);

    expect(await ts.store.getRun(finished.id)).toBeNull();
    expect(await ts.store.getHistory(finished.id)).toHaveLength(0);
    expect((await ts.store.getRun(active.id))?.status).toBe("pending");
  });

  it("respects the age threshold and works through the API", async () => {
    const worker = new Worker({ store: ts.store, registry }, { workerId: "m" });
    await startRun(ts.store, "counter", { n: 1 });
    await worker.tick();

    const app = buildServer({ store: ts.store });

    const tooRecent = await app.inject({
      method: "POST",
      url: "/api/maintenance/purge",
      payload: { olderThanMs: 3_600_000 },
    });
    expect(tooRecent.json().purged).toBe(0);

    const purgeNow = await app.inject({
      method: "POST",
      url: "/api/maintenance/purge",
      payload: { olderThanMs: 0 },
    });
    expect(purgeNow.json().purged).toBe(1);

    expect(await ts.store.listRuns({})).toHaveLength(0);

    await app.close();
  });
});
