import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ForegroundObservation, WindowInfo } from './types';

export const emptyForeground = (status: ForegroundObservation['status'] = 'inactive'): ForegroundObservation => ({ status, current: null, lastExternal: null });

/** Validate the helper protocol; never keep a previous window as the current observation. */
export function parseWindowSample(input: unknown, ownProcessId: number, now = Date.now()): WindowInfo | null {
  if (!input || typeof input !== 'object') return null;
  const data = input as Record<string, unknown>;
  if (data.status !== 'ok' || !Number.isInteger(data.processId) || Number(data.processId) <= 0 || Number(data.processId) > 0xffffffff ||
    typeof data.title !== 'string' || data.title.length > 32767 || typeof data.windowHandle !== 'string' || !/^[0-9]+$/.test(data.windowHandle) ||
    typeof data.observedAt !== 'number' || !Number.isFinite(data.observedAt) || data.observedAt > now + 2000 || now - data.observedAt > 5000) return null;
  const optionalString = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit ? value : null;
  return { processId: Number(data.processId), windowHandle: data.windowHandle, title: data.title, observedAt: data.observedAt,
    processName: optionalString(data.processName, 1024), executablePath: optionalString(data.executablePath, 32768),
    appName: optionalString(data.appName, 1024), isOwnApp: data.processId === ownProcessId };
}

export class ForegroundMonitor {
  private child: ChildProcess | null = null;
  private value = emptyForeground();
  private lastMessageAt = 0;
  constructor(private executable: string, private onChange: () => void, private ownProcessId = process.pid) {}
  snapshot(): ForegroundObservation {
    if (this.child && Date.now() - this.lastMessageAt > 5000) return { ...this.value, status: 'unavailable', current: null };
    return this.value;
  }
  setActive(enabled: boolean, inactiveStatus: 'inactive' | 'disabled' | 'locked' = 'inactive') {
    if (!enabled) { this.stop(inactiveStatus); return; }
    if (this.child) return;
    if (process.platform !== 'win32') { this.value = emptyForeground('unsupported'); this.onChange(); return; }
    this.value = emptyForeground('starting'); this.lastMessageAt = Date.now();
    const child = spawn(this.executable, ['--watch', '--parent-pid', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on('line', line => {
      if (this.child !== child) return;
      this.lastMessageAt = Date.now();
      let current: WindowInfo | null = null;
      if (line.length <= 500_000) { try { current = parseWindowSample(JSON.parse(line), this.ownProcessId); } catch {} }
      this.value = { status: current ? 'active' : 'unavailable', current,
        lastExternal: current && !current.isOwnApp ? current : this.value.lastExternal };
      this.onChange();
    });
    const failed = () => {
      lines.close();
      if (this.child !== child) return;
      this.child = null; this.value = emptyForeground('error'); this.onChange();
    };
    child.once('error', failed); child.once('exit', failed);
    this.onChange();
  }
  stop(status: 'inactive' | 'disabled' | 'locked' = 'inactive') {
    const child = this.child; this.child = null;
    child?.kill();
    this.value = emptyForeground(status); this.onChange();
  }
}
