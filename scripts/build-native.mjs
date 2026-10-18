import { spawnSync } from 'node:child_process';
import { mkdir, access, stat } from 'node:fs/promises';
import path from 'node:path';
if (process.platform !== 'win32') throw new Error('Windows is required to build the window reader');
const framework = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319');
const compiler = path.join(framework, 'csc.exe');
await access(compiler);
await mkdir('dist/native', { recursive: true });
const output = path.resolve('dist/native/foreground-reader.exe'), source = path.resolve('native/ForegroundReader.cs'), reference = path.join(framework, 'System.Web.Extensions.dll');
// Avoid rewriting an unchanged executable that Windows may still have mapped
// after an integration run. Rebuild when any compilation input is newer.
const inputs = await Promise.all([source, compiler, reference].map(file => stat(file)));
const built = await stat(output).catch(() => null);
if (!built || !built.size || inputs.some(input => input.mtimeMs > built.mtimeMs)) {
  const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', `/out:${output}`, `/reference:${reference}`, source], { stdio: 'inherit', shell: false, windowsHide: true });
  if (result.status !== 0) throw new Error('Window reader compilation failed');
}
