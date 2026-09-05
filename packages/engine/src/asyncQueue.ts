/**
 * A one-producer/one-consumer queue that is also an async iterable.
 *
 * The Claude harness needs this twice: once for the messages it pushes *into*
 * the SDK (streaming input keeps a single process — and therefore a single warm
 * prompt cache — alive across turns, SPEC R24), and once for the events it hands
 * *out* to the session runner while the SDK's own message loop, the `canUseTool`
 * callback and the `PreToolUse` hook all produce events from different stacks.
 *
 * `push` never blocks; `close` ends the iteration after everything already
 * queued has been read; `fail` ends it by throwing.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((r: IteratorResult<T>) => void)[] = [];
  private rejecters: ((e: unknown) => void)[] = [];
  private closed = false;
  private error: unknown = null;

  get size(): number {
    return this.items.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    this.rejecters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  /** End the stream once the buffered items have been consumed. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flushWaiters();
  }

  /** End the stream by throwing `err` at the consumer. */
  fail(err: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.error = err;
    this.flushWaiters();
  }

  private flushWaiters(): void {
    const waiters = this.waiters.splice(0);
    const rejecters = this.rejecters.splice(0);
    for (let i = 0; i < waiters.length; i += 1) {
      if (this.error !== null) rejecters[i]?.(this.error);
      else waiters[i]?.({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift() as T;
        continue;
      }
      if (this.closed) {
        if (this.error !== null) throw this.error;
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve, reject) => {
        this.waiters.push(resolve);
        this.rejecters.push(reject);
      });
      if (next.done) {
        if (this.error !== null) throw this.error;
        return;
      }
      yield next.value;
    }
  }
}
