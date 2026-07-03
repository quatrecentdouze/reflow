import { defineWorkflow } from "@reflow/sdk";
import { log, simulateWork } from "./support.js";

export interface NotifyUserInput {
  userId: string;
  message: string;
}

export const notifyUser = defineWorkflow<NotifyUserInput, { delivered: boolean }>({
  name: "notify-user",
  async run(ctx, input) {
    await ctx.step("send-push", async () => {
      log(`push to ${input.userId}: ${input.message}`);
      await simulateWork(500);
      return { pushed: true };
    });
    return { delivered: true };
  },
});

export interface BatchNotifyInput {
  userIds: string[];
  message: string;
}

export const batchNotify = defineWorkflow<BatchNotifyInput, { notified: number }>({
  name: "batch-notify",
  async run(ctx, input) {
    let notified = 0;
    for (const userId of input.userIds) {
      const result = await ctx.child<{ delivered: boolean }>("notify-user", {
        userId,
        message: input.message,
      });
      if (result.delivered) notified += 1;
    }
    return { notified };
  },
});
