import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const executable = path.resolve('.test-data/tools/focus-test-window.exe');
await mkdir(path.dirname(executable), { recursive: true });
const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const build = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${executable}`, path.resolve('tests/FocusTestWindow.cs')], { stdio: 'inherit', windowsHide: true, shell: false });
if (build.status !== 0) throw new Error('Test focus helper build failed');
export function focusTestProcess(processId) {
  if (!Number.isInteger(processId) || processId <= 0) throw new Error('Invalid test PID');
  const result = spawnSync(executable, [String(processId)], { windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`Unable to focus the test-owned window (${result.status})`);
}
