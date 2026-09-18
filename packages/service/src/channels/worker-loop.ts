/** A process scheduler, never the owner of acknowledged work. PostgreSQL leases own recovery. */
export class ChannelWorkerLoop {
  private run: (() => Promise<void>) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private tickAt = 0;
  private abort = new AbortController();
  get signal(): AbortSignal {
    return this.abort.signal;
  }
  constructor(private readonly onError: (code: string) => void = () => undefined) {}
  attach(run: () => Promise<void>): void {
    this.run = run;
  }
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.abort = new AbortController();
    this.timer = setInterval(() => this.wake(), 1000);
    this.timer.unref?.();
    this.wake();
  }
  ready(): boolean {
    return !this.stopped && !!this.run && Date.now() - this.tickAt < 90_000;
  }
  wake(): void {
    if (this.stopped || this.running || !this.run) return;
    this.tickAt = Date.now();
    this.running = this.run()
      .catch(() => this.onError('channel_worker_failed'))
      .finally(() => {
        this.running = undefined;
      });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
