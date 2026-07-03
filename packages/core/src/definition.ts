import type { WorkflowContext } from "./context.js";

export interface WorkflowDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  run: (ctx: WorkflowContext, input: TInput) => Promise<TOutput>;
}

export class WorkflowRegistry {
  private readonly definitions = new Map<string, WorkflowDefinition>();

  register(definition: WorkflowDefinition<never, unknown>): this {
    if (this.definitions.has(definition.name)) {
      throw new Error(`workflow "${definition.name}" is already registered`);
    }
    this.definitions.set(definition.name, definition as WorkflowDefinition);
    return this;
  }

  get(name: string): WorkflowDefinition | undefined {
    return this.definitions.get(name);
  }

  names(): string[] {
    return [...this.definitions.keys()];
  }
}
