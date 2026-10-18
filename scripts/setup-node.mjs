import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, cp, access } from 'node:fs/promises';
import extract from 'extract-zip';
import path from 'node:path';
const version = 'v24.14.0';
const archive = `node-${version}-win-x64.zip`;
const destination = path.resolve('vendor/node');
await mkdir(destination, { recursive: true });
try { await access(path.join(destination, 'node.exe')); console.log('Bundled Node is present'); }
catch {
  const base = `https://nodejs.org/dist/${version}`;
  const response = await fetch(`${base}/SHASUMS256.txt`);
  if (!response.ok) throw new Error('Node checksum download failed');
  const checksums = await response.text();
  const expected = checksums.split('\n').find(line => line.endsWith(`  ${archive}`))?.split(' ')[0];
  if (!expected) throw new Error('Official Node archive checksum missing');
  const download = await fetch(`${base}/${archive}`);
  if (!download.ok) throw new Error('Node runtime download failed');
  const buffer = Buffer.from(await download.arrayBuffer());
  if (createHash('sha256').update(buffer).digest('hex') !== expected) throw new Error('Node runtime checksum mismatch');
  const zip = path.join(destination, archive); await writeFile(zip, buffer);
  await extract(zip, { dir: destination });
  await cp(path.join(destination, `node-${version}-win-x64/node.exe`), path.join(destination, 'node.exe'));
  await cp(path.join(destination, `node-${version}-win-x64/LICENSE`), path.join(destination, 'LICENSE'));
  await writeFile(path.join(destination, 'runtime.json'), JSON.stringify({ version, archive, sha256: expected, source: `${base}/${archive}` }, null, 2));
  console.log(`Verified bundled Node ${version}`);
}
