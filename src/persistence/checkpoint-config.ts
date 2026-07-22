import type { RunnableConfig } from "@langchain/core/runnables";
import { validateThreadId } from "./file-checkpoint-format.ts";

export function requiredThreadId(config: RunnableConfig): string {
  const value = config.configurable?.thread_id;
  if (typeof value !== "string") throw new Error("checkpoint config requires a string thread_id");
  validateThreadId(value);
  return value;
}
