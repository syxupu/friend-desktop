import { existsSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
const run = (exe, args, cwd = process.cwd()) => {
  const result = spawnSync(exe, args, { cwd, stdio: 'inherit', shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (!existsSync('vendor/SillyTavern/server.js')) run('git', ['clone', '--depth', '1', '--branch', '1.19.0', 'https://github.com/SillyTavern/SillyTavern.git', 'vendor/SillyTavern']);
const revision = execFileSync('git', ['-C', 'vendor/SillyTavern', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (revision !== '7e8663cd9c184a550b37238218bdd32c6efc68e9') throw new Error('SillyTavern source does not match the pinned version');
// npm CLI is JavaScript, keeping paths and arguments separate on Windows.
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('请用 npm run setup 调用');
run(process.execPath, [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund'], `${process.cwd()}/vendor/SillyTavern`);
run(process.execPath, ['scripts/setup-node.mjs']);
