/** Deadlines settle callers; onTimeout must stop the owned operation before reuse. */
export function withDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string, options: { signal?: AbortSignal; onTimeout?: () => void } = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); fn(); };
    const abort = () => finish(() => reject(options.signal?.reason ?? new Error('操作已取消')));
    const timer = setTimeout(() => { if (settled) return; options.onTimeout?.(); finish(() => reject(new Error(message))); }, timeoutMs);
    operation.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
