import { ASSISTANT_INTERACTION_EXECUTION_LIMIT_MS } from './assistant-interaction-state.js';

/** Enforce the same accepted-flow bound used by durable unknown-outcome cleanup. */
export async function boundedAssistantExecution<T>(
  work: (signal: AbortSignal) => Promise<T>,
  unknown: () => T,
  timeoutMs = ASSISTANT_INTERACTION_EXECUTION_LIMIT_MS,
): Promise<T> {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > ASSISTANT_INTERACTION_EXECUTION_LIMIT_MS
  )
    throw new Error('Invalid assistant execution bound');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          controller.abort(
            new DOMException('Assistant execution deadline elapsed', 'TimeoutError'),
          );
          resolve(unknown());
        }, timeoutMs);
      }),
    ]);
  } catch {
    return unknown();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
