import { writeFile, rename } from 'node:fs/promises';
export interface SaveStatus { status: 'saved' | 'saving' | 'error'; dirty: boolean; lastSavedAt?: number; error?: string }

/** One writer owns the temp file, even when an OS write outlives a caller deadline. */
export class SnapshotWriter {
  private version = 0;
  private savedVersion = 0;
  private pending?: { version: number; serialized: string };
  private running = false;
  private retry?: ReturnType<typeof setTimeout>;
  private closed = false;
  private listeners = new Set<() => void>();
  private value: SaveStatus = { status: 'saved', dirty: false };
  constructor(private file: string, private onChange: () => void,
    private options: { retryMs?: number; write?: (serialized: string) => Promise<void> } = {}) {}
  snapshot(): SaveStatus { return { ...this.value }; }
  private getPending() { return this.pending; }
  private publish(status: SaveStatus['status']) {
    this.value = { ...this.value, status, dirty: this.version > this.savedVersion,
      error: status === 'error' ? '本机保存未完成，正在保留内存中的进度并重试。' : undefined };
    this.onChange(); for (const listener of [...this.listeners]) listener();
  }
  save(serialized: string, timeoutMs = 5000): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const version = ++this.version;
    this.pending = { version, serialized };
    if (!this.running && !this.retry) void this.drain();
    return this.waitFor(version, timeoutMs);
  }
  private waitFor(version: number, timeoutMs: number): Promise<boolean> {
    if (this.savedVersion >= version) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = (result: boolean) => { clearTimeout(timer); this.listeners.delete(check); resolve(result); };
      const check = () => { if (this.savedVersion >= version) finish(true); else if (this.closed) finish(false); };
      const timer = setTimeout(() => { finish(false); this.publish('error'); }, timeoutMs);
      this.listeners.add(check); check();
    });
  }
  private async drain() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (this.pending && !this.closed) {
        const job = this.pending; this.pending = undefined; this.publish('saving');
        try {
          if (this.options.write) await this.options.write(job.serialized);
          else { await writeFile(`${this.file}.tmp`, job.serialized, 'utf8'); await rename(`${this.file}.tmp`, this.file); }
          this.savedVersion = job.version; this.value.lastSavedAt = Date.now();
          this.publish(this.pending ? 'saving' : 'saved');
        } catch {
          const newest = this.getPending();
          if (!newest || newest.version < job.version) this.pending = job;
          this.publish('error');
          if (!this.closed) this.retry = setTimeout(() => { this.retry = undefined; void this.drain(); }, this.options.retryMs ?? 3000);
          this.retry?.unref(); break;
        }
      }
    } finally { this.running = false; }
  }
  close() {
    this.closed = true; if (this.retry) clearTimeout(this.retry);
    for (const listener of [...this.listeners]) listener();
  }
}
