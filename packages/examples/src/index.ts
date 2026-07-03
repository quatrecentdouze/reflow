import { WorkflowRegistry } from "@reflow/core";
import { expenseApproval } from "./expense-approval.js";
import { orderProcessing } from "./order-processing.js";

export { orderProcessing, expenseApproval };

export function createExampleRegistry(): WorkflowRegistry {
  return new WorkflowRegistry().register(orderProcessing).register(expenseApproval);
}
