# reflow

[![CI](https://github.com/quatrecentdouze/reflow/actions/workflows/ci.yml/badge.svg)](https://github.com/quatrecentdouze/reflow/actions/workflows/ci.yml)

durable workflow engine for typescript, built on postgres. write multi step processes as plain async code, reflow persists every step so it survives crashes, retries failures, sleeps for days and waits for human input. a mini temporal

```ts
export const orderProcessing = defineWorkflow({
  name: "order-processing",
  async run(ctx, input: { orderId: string; amount: number }) {
    await ctx.step("reserve-inventory", () => inventory.reserve(input.orderId));

    const charge = await ctx.step(
      "charge-payment",
      () => payments.charge(input.orderId, input.amount),
      { retry: { maxAttempts: 5, initialDelayMs: 3_000, backoffFactor: 2 } },
    );

    await ctx.sleep(7 * 24 * 3_600_000);

    await ctx.step("send-follow-up-email", () => emails.followUp(input.orderId));

    return { status: "fulfilled", chargeId: charge.id };
  },
});
```

kill the worker mid run then restart it, execution resumes exactly where it stopped. every durable operation is recorded in an append only event history, and a worker resuming a run re-executes the function against that history: recorded steps return their stored result instantly, execution continues live from the first unrecorded one. deterministic replay, thats the whole trick

![reflow web ui](docs/ui.png)

## features

- durable steps with retries and exponential backoff
- durable timers, sleep for a week across restarts and deploys
- signals for human in the loop, with optional timeouts
- child workflows
- workflow versioning, ship new code while old runs are in flight
- scheduled and recurring runs, fixed interval or cron
- cancellation, and retry of runs that exhausted their retries
- deterministic `ctx.now()` / `ctx.random()`
- scale by starting more workers, coordination via `FOR UPDATE SKIP LOCKED`, dead workers detected by lock heartbeats and their runs taken over
- web ui with live statuses and event histories

## quick start

needs node 22+ and pnpm, no docker, the demo embeds postgres (pglite) in process

```bash
pnpm install
pnpm demo
```

open http://localhost:3000 for the ui, then

```bash
curl -X POST http://localhost:3000/api/workflows/order-processing/runs \
     -H "content-type: application/json" \
     -d '{"input": {"orderId": "order-1", "amount": 99}}'
```

for the real thing, postgres + separate server and worker processes

```bash
docker compose up -d
pnpm build
pnpm --filter @reflow/server start   # terminal 1
pnpm --filter @reflow/worker start   # terminal 2
```

## api

| Method | Path                              | Description                              |
|--------|-----------------------------------|------------------------------------------|
| GET    | `/`                               | web ui                                   |
| POST   | `/api/workflows/:name/runs`       | start a run (`{ input, startAt? }`)      |
| GET    | `/api/runs`                       | list runs (`?status=`, `?limit=`)        |
| GET    | `/api/runs/:id`                   | run state (`?include=history`)           |
| GET    | `/api/runs/:id/history`           | paged events (`?offset=`, `?limit=`)     |
| POST   | `/api/runs/:id/signals/:name`     | deliver a signal (`{ payload }`)         |
| POST   | `/api/runs/:id/retry`             | retry a failed run                       |
| POST   | `/api/runs/:id/cancel`            | cancel a run                             |
| POST   | `/api/workflows/:name/schedules`  | create a schedule (`{ input, intervalMs \| cron }`) |
| GET    | `/api/schedules`                  | list schedules                           |
| DELETE | `/api/schedules/:id`              | delete a schedule                        |
| POST   | `/api/maintenance/purge`          | delete finished runs (`{ olderThanMs }`) |

## architecture

```
packages/core            engine: replay executor, worker runtime (zero deps)
packages/sdk             workflow authoring api
packages/store-postgres  storage, works on pg and pglite
apps/server              rest api + web ui (fastify)
apps/worker              worker process
apps/demo                single process demo
```

two rules to know. workflow code must be deterministic outside of steps, put side effects, `Date.now()` and `Math.random()` inside `ctx.step()` or use the ctx helpers. and steps are at least once, a crash between a side effect and its recording means the step runs again on resume, so make them idempotent

## dev

```bash
pnpm test    # 50+ tests against an embedded postgres, no infra needed
```

[MIT](./LICENSE)
