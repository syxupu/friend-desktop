import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
export function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const tick = () => new Promise<void>(resolve => setImmediate(resolve));
export async function until(predicate: () => boolean, timeout = 1000) {
  const start = Date.now(); while (!predicate()) { if (Date.now() - start > timeout) throw new Error('Test condition timed out'); await new Promise(r => setTimeout(r, 2)); }
}
export function vmLoader(overrides: Record<string, any>, globals: Record<string, any> = {}) {
  const cache = new Map<string, any>();
  return function load(file: string, extra = ''): any {
    if (cache.has(file)) return cache.get(file);
    const mod = { exports: {} }; cache.set(file, mod.exports);
    const code = transformSync(fs.readFileSync(path.resolve(file), 'utf8') + extra, { loader: 'ts', format: 'cjs', target: 'node22' }).code;
    const requireMock = (name: string) => {
      if (name in overrides) return overrides[name];
      if (name.startsWith('.')) return load(path.join(path.dirname(file), name + '.ts'));
      // Only built-in modules pass through; Electron is always explicitly mocked.
      if (name === 'node:path') return path;
      if (name === 'node:crypto') return { randomUUID };
      throw new Error(`Missing test mock: ${name}`);
    };
    vm.runInNewContext(code, { module: mod, exports: mod.exports, require: requireMock, performance, process: { argv: [], env: {}, pid: 1 },
      AbortController, AbortSignal, Buffer, console, URL, setTimeout, clearTimeout, setInterval, clearInterval, ...globals }, { filename: file });
    cache.set(file, mod.exports); return mod.exports;
  };
}
export function mainFixture() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const events = new Map<string, (...args: any[]) => any>();
  const ipcEvents = new Map<string, (...args: any[]) => any>();
  const calls: any[] = [], audio: any[] = []; let syntheses = 0;
  let active: ReturnType<typeof deferred> | undefined;
  const bridge = {
    window: { webContents: {} },
    avatar: 'test.png', close() { active?.reject(new Error('runtime closed')); active = undefined; },
    async stopGeneration() { const old = active; active = undefined; old?.reject(new Error('cancelled')); await tick(); },
    async call(method: string, data: any) {
      calls.push({ method, data });
      if (method === 'configure') return { character: '测试角色', entries: 8, messages: [] };
      const reply = deferred(); active = reply; return reply.promise;
    },
  };
  const window = { pinned: false, setAlwaysOnTop(value: boolean) { this.pinned = value; }, webContents: { send: (channel: string, data: any) => { if (channel === 'friend:audio') audio.push(data); } }, isDestroyed: () => false, show() {}, focus() {}, hide() {} };
  const app = { requestSingleInstanceLock: () => true, getAppPath: () => process.cwd(), getPath: () => 'unused-test-data', on: (name: string, fn: any) => events.set(name, fn), whenReady: () => new Promise(() => {}), quitCalls: 0, quit() { this.quitCalls++; } };
  const load = vmLoader({
    electron: { app, ipcMain: { handle: (key: string, value: any) => handlers.set(key, value), on: (key: string, value: any) => ipcEvents.set(key, value) }, powerSaveBlocker: { start: () => 1, stop() {} } },
    './tavern': { TavernRuntime: class {} }, './foreground': { emptyForeground: () => ({ status: 'inactive', current: null, lastExternal: null }) },
    './speech': { extractSpeech: (text: string) => text, synthesize: async () => { syntheses++; return 'mock-wav'; } },
    './model-proxy': {}, 'node:fs/promises': { writeFile: async () => {}, rename: async () => {} },
    './settings': { publicSettings: (settings: any) => ({ ...settings, deepseekKey: '', mimoKey: '' }) },
  });
  const mod = load('src/main.ts', `
module.exports.testAPI = { study, control, generate, changeMessage, stopAudio, cancelGeneration, saveSettings, shutdown,
  prepare() {
    store = { value: { ttsEnabled: true, mimoKey: 'mock', deepseekKey: 'mock', keepAwake: false }, save: async () => {} } as any;
    proxy = { url: 'mock', token: 'mock', abortAll() {}, close() {} } as any;
    ready = true; snapshotWriter = { snapshot: () => ({ status:'saved', dirty:false }), close() {} } as any;
    persist = async () => true;
  }, inject(runtime, window) { tavern = runtime; chatWindow = window; setupIPC(); },
  setPersist(fn) { persist = fn; }, setStore(value) { store = value; }, setDirty() { snapshotWriter = { snapshot: () => ({ status:'error',dirty:true }), close() {} } as any; },
  setArchive(value) { archive = value; },
  inspect: () => state() };
`);
  const api = mod.testAPI; api.prepare(); api.inject(bridge, window);
  return { api, bridge, handlers, events, app, calls, audio, window, sender: { sender: window.webContents }, syntheses: () => syntheses,
    stream(id: string, text: string) { ipcEvents.get('tavern:event')!({sender:bridge.window.webContents},{type:'stream',id,text}); },
    reply(text = '“测试回复。”') { const old = active; active = undefined; if (!old) throw new Error('No pending generation'); old.resolve({ text }); },
    async cleanup() { await api.cancelGeneration(); api.stopAudio(); } };
}
