import { BrowserWindow, app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { withDeadline } from './deadline';

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
export class TavernRuntime {
  window!: BrowserWindow;
  child?: ChildProcess;
  url = '';
  avatar = '';
  private stopped = false;
  private lifetime = new AbortController();
  private generation?: Promise<any>;
  constructor(private root: string, private directory: string, private onExit: () => void,
    private timeouts = { startup: 90_000, probe: 2000, bridge: 30_000, generate: 150_000, cancel: 3000 }) {}
  private fail(message: string) {
    if (this.stopped) return;
    this.close(new Error(message)); this.onExit();
  }
  private bounded<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
    return withDeadline(operation, ms, message, { signal: this.lifetime.signal, onTimeout: () => this.fail(message) });
  }
  async start() {
    return this.bounded(this.startInternal(), this.timeouts.startup, '酒馆启动超时');
  }
  private async startInternal() {
    const runtime = app.isPackaged ? path.join(process.resourcesPath, 'SillyTavern') : path.join(this.root, 'vendor', 'SillyTavern');
    await access(path.join(runtime, 'server.js'));
    const dataRoot = path.join(this.directory, 'tavern-data');
    const configPath = path.join(this.directory, 'tavern-config.yaml');
    await mkdir(path.join(dataRoot, 'default-user'), { recursive: true });
    // Prevent ST's first-run naming popup from blocking its hidden frontend.
    const settingsPath = path.join(dataRoot, 'default-user', 'settings.json');
    try { await access(settingsPath); } catch {
      const initial = JSON.parse(await readFile(path.join(runtime, 'default/content/settings.json'), 'utf8'));
      initial.firstRun = false;
      await writeFile(settingsPath, JSON.stringify(initial), 'utf8');
    }
    const config = `dataRoot: ${JSON.stringify(dataRoot)}\nlisten: false\nport: 8000\nbrowserLaunch:\n  enabled: false\nextensions:\n  enabled: false\n  autoUpdate: false\n  models:\n    autoDownload: false\nenableDownloadableTokenizers: false\nenableServerPlugins: false\nenableServerPluginsAutoUpdate: false\nallowKeysExposure: false\n`;
    await writeFile(configPath, config, 'utf8');
    const port = await freePort(); this.url = `http://127.0.0.1:${port}`;
    const node = app.isPackaged ? path.join(process.resourcesPath, 'node/node.exe') : path.join(this.root, 'vendor/node/node.exe');
    await access(node);
    this.lifetime.signal.throwIfAborted();
    this.child = spawn(node, [path.join(runtime, 'server.js'), '--configPath', configPath, '--dataRoot', dataRoot, '--port', String(port), '--browserLaunchEnabled', 'false'], {
      cwd: runtime, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child.on('error', () => this.fail('内置酒馆服务启动失败'));
    this.child.stderr?.resume();
    this.child.on('exit', () => this.fail('内置酒馆服务已退出'));
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      this.lifetime.signal.throwIfAborted();
      try {
        const response = await fetch(`${this.url}/csrf-token`, { signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeouts.probe)]) });
        await response.body?.cancel(); if (response.ok) break;
      } catch { this.lifetime.signal.throwIfAborted(); }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (Date.now() >= deadline) throw new Error('酒馆启动超时');
    this.lifetime.signal.throwIfAborted();
    this.window = new BrowserWindow({ show: false, width: 1100, height: 820, title: 'Friend · 角色与世界书',
      webPreferences: { preload: path.join(this.root, 'dist/tavern-preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, partition: 'persist:friend-tavern' },
    });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== this.url) event.preventDefault(); });
    this.window.on('close', event => { if (!this.stopped) { event.preventDefault(); this.window.hide(); } });
    this.window.on('closed', () => this.fail('酒馆窗口已关闭'));
    this.window.webContents.on('render-process-gone', () => this.fail('酒馆窗口进程已退出'));
    await this.window.loadURL(this.url);
    await this.window.webContents.executeJavaScript(await readFile(path.join(this.root, 'dist/tavern-bridge.js'), 'utf8'));
  }
  async importCharacter(card: string) {
    // Use the reviewed V3 JSON, never the PNG's conflicting older metadata.
    const code = `(async()=>{ const ctx=SillyTavern.getContext(); const all=await fetch('/api/characters/all',{method:'POST',headers:ctx.getRequestHeaders(),body:'{}'}).then(r=>r.json());
      const existing=all.find(c=>c.name===${JSON.stringify(JSON.parse(card).data.name)}); if(existing)return existing.avatar;
      const body=new FormData();body.append('avatar',new Blob([${JSON.stringify(card)}],{type:'application/json'}),'card.json');body.append('file_type','json');
      const response=await fetch('/api/characters/import',{method:'POST',headers:ctx.getRequestHeaders({omitContentType:true}),body});const result=await response.json();if(!response.ok||!result.file_name)throw new Error('角色卡导入失败');return result.file_name+'.png';})()`;
    this.avatar = await this.bounded(this.window.webContents.executeJavaScript(code), this.timeouts.bridge, '角色导入超时'); return this.avatar;
  }
  async call(method: string, data?: unknown): Promise<any> {
    this.lifetime.signal.throwIfAborted();
    if (!this.window || this.window.isDestroyed()) throw new Error('酒馆窗口不可用');
    if (method === 'generate' && this.generation) throw new Error('对话正在生成');
    const pending = this.bounded(this.window.webContents.executeJavaScript(`window.friendBridge[${JSON.stringify(method)}](${data === undefined ? '' : JSON.stringify(data)})`),
      method === 'generate' ? this.timeouts.generate : this.timeouts.bridge, method === 'generate' ? '对话生成超时' : '酒馆操作超时');
    if (method === 'generate') {
      this.generation = pending;
      const clear = () => { if (this.generation === pending) this.generation = undefined; };
      void pending.then(clear, clear);
    }
    return pending;
  }
  async stopGeneration() {
    const pending = this.generation;
    if (!pending || this.stopped) return;
    try {
      // Do not admit another generation until this one settles, or its runtime
      // is destroyed. A timed-out Promise alone would leave a hidden producer.
      await this.bounded(Promise.all([
        this.window.webContents.executeJavaScript('window.friendBridge.stop()'),
        pending.catch(() => {}),
      ]), this.timeouts.cancel, '取消生成超时，已停止对话服务');
    } catch { this.fail('无法停止生成，已停止对话服务'); }
  }
  show() { this.window.show(); this.window.focus(); }
  async closeAndWait() {
    this.close();
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    let exited!: () => void;
    const exit = new Promise<void>(resolve => { exited = resolve; child.once('exit', exited); });
    try { await withDeadline(exit, 3000, '旧酒馆进程尚未退出，请稍后重试'); }
    finally { child.removeListener('exit', exited); }
  }
  close(reason = new Error('酒馆服务已停止')) {
    if (this.stopped) return;
    this.stopped = true; this.lifetime.abort(reason);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.child?.kill();
  }
}
