import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";

/**
 * Runs `operation`; on failure, emits `appError` (for a UI toast) and
 * returns `fallback` instead of throwing. The seam that keeps a failed
 * explorer/document/workspace operation (e.g. a file deleted outside the
 * app) from crashing the caller or failing silently.
 */
export async function safely<T>(
  events: EventBus<AppEvents>,
  operation: () => Promise<T>,
  action: string,
  fallback: T,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    events.emit("appError", { message: `Failed to ${action}: ${errorMessage(error)}` });
    return fallback;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
