# reflow

Durable workflow orchestration engine for TypeScript — a minimal Temporal-like runtime.

Define workflows as plain TypeScript code. reflow executes them **durably**: every step result is persisted, so if a worker crashes mid-workflow, execution resumes exactly where it left off through deterministic replay.

```ts
export const onboardUser = defineWorkflow({
  name: "onboard-user",
  async run(ctx, input: { userId: string }) {
    const account = await ctx.step("create-account", () => createAccount(input.userId));
    await ctx.step("send-welcome-email", () => sendEmail(account.email));
    return { accountId: account.id };
  },
});
```

## Architecture

```
packages/
  core    — engine primitives: run lifecycle, append-only event history
  sdk     — workflow authoring API: defineWorkflow, step context
apps/
  server  — REST API: start runs, query state
  worker  — executes workflows, replays history after crashes
```

## Status

Early development — PoC in progress.

## Development

```bash
pnpm install
pnpm build
```
