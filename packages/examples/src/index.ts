import { WorkflowRegistry } from "@reflow/core";
import { batchNotify, notifyUser } from "./batch-notify.js";
import { expenseApproval } from "./expense-approval.js";
import { orderProcessing } from "./order-processing.js";

export { orderProcessing, expenseApproval, batchNotify, notifyUser };

export function createExampleRegistry(): WorkflowRegistry {
  return new WorkflowRegistry()
    .register(orderProcessing)
    .register(expenseApproval)
    .register(batchNotify)
    .register(notifyUser);
}
