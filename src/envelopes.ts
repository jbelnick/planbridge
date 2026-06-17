import type { ToolError } from "./errors.js";
import { PlanbridgeError } from "./errors.js";

export type Bounded<TKey extends string, TItem> = {
  [K in TKey]: TItem[];
} & { truncated: boolean; next_cursor?: string; total_estimate?: number };

export function toToolError(error: unknown): ToolError {
  if (error instanceof PlanbridgeError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.path ? { path: error.path } : {})
      }
    };
  }
  throw error;
}

export function sizeExceeded(message: string): ToolError {
  return { error: { code: "E_SIZE_EXCEEDED", message } };
}
