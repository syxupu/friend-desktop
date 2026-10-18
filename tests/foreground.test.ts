import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWindowSample } from '../src/foreground';
const sample = { status: 'ok', observedAt: 10_000, processId: 1234, windowHandle: '925826', appName: 'Microsoft Edge', processName: 'msedge.exe', executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', title: '高数 “导数”\n第二节 📚 — Microsoft Edge' };
test('window titles preserve Unicode, quotes and line breaks with process identity', () => {
  const result = parseWindowSample(JSON.parse(JSON.stringify(sample)), 555, 10_050)!;
  assert.equal(result.title, sample.title); assert.equal(result.processName, 'msedge.exe');
  assert.equal(result.isOwnApp, false);
  assert.equal(parseWindowSample(sample, 1234, 10_050)!.isOwnApp, true);
});
test('missing executable permissions still permit a valid title observation', () => {
  const result = parseWindowSample({ ...sample, executablePath: null, processName: null, appName: null }, 1, 10_050)!;
  assert.equal(result.title, sample.title); assert.equal(result.executablePath, null);
});
test('unavailable, stale, future, malformed and oversized observations are rejected', () => {
  for (const input of [null, { status: 'unavailable' }, { ...sample, observedAt: 100 }, { ...sample, observedAt: 20_000 }, { ...sample, observedAt: NaN }, { ...sample, processId: 0 }, { ...sample, title: 'x'.repeat(32768) }, { ...sample, windowHandle: 'bad' }]) assert.equal(parseWindowSample(input, 1, 10_050), null);
});
