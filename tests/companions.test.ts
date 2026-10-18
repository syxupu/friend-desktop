import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rmdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CompanionStore, companionPrompt, defaultPreferences, revisionOf, validateFields, fieldsFromData } from '../src/companions';
const fields = { name: 'Neutral', description: 'Base persona', personality: '', scenario: '', first_mes: '', mes_example: '' };
test('edit revisions track writable fields while unrelated Tavern metadata remains outside the patch', () => {
  assert.equal(revisionOf(fieldsFromData({ ...fields, extensions: { world: 'before' } })), revisionOf(fieldsFromData({ ...fields, extensions: { world: 'after' } })));
  assert.notEqual(revisionOf(fieldsFromData(fields)), revisionOf(fieldsFromData({ ...fields, description: 'changed in advanced editor' })));
});
test('preference disk failure preserves memory and serial writes reject stale revisions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'friend-companions-')), store = new CompanionStore(root); await store.load();
  const initial = revisionOf(store.get('a.png')), next = { ...defaultPreferences, length: 'brief' as const };
  await mkdir(path.join(root, 'companions.json.tmp'));
  await assert.rejects(store.save('a.png', initial, next)); assert.deepEqual(store.get('a.png'), defaultPreferences);
  await rmdir(path.join(root, 'companions.json.tmp'));
  const attempts = await Promise.allSettled([store.save('a.png', initial, next), store.save('a.png', initial, { ...next, actions: 'none' })]);
  assert.equal(attempts[0].status, 'fulfilled'); assert.equal(attempts[1].status, 'rejected');
  assert.equal(store.get('a.png').actions, 'original'); assert.deepEqual(store.get('b.png'), defaultPreferences);
  const loaded = new CompanionStore(root); await loaded.load(); assert.deepEqual(loaded.get('a.png'), next);
  assert.ok(!String(await readFile(path.join(root, 'companions.json'))).includes('Base persona'));
});
test('malformed saved preferences fail closed instead of silently replacing them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'friend-companions-'));
  await writeFile(path.join(root, 'companions.json'), '{"version":1,"characters":{"a.png":{"length":"bogus"}}}');
  await assert.rejects(new CompanionStore(root).load(), /无法读取/);
});
test('companion injection uses authoritative mode and omits unrelated state preferences', () => {
  const p = { ...defaultPreferences, length: 'brief' as const, actions: 'none' as const, noFollowUp: true, studyStyle: 'STUDY_ONLY', breakStyle: 'BREAK_ONLY' };
  assert.equal(companionPrompt(defaultPreferences, 'idle'), '');
  for (const mode of ['study', 'paused'] as const) { assert.ok(companionPrompt(p, mode).includes('STUDY_ONLY')); assert.ok(!companionPrompt(p, mode).includes('BREAK_ONLY')); }
  assert.ok(companionPrompt(p, 'break').includes('BREAK_ONLY')); assert.ok(!companionPrompt(p, 'idle').includes('STUDY_ONLY'));
  assert.ok(companionPrompt(p, 'idle').includes('不改变学习状态')); assert.ok(companionPrompt(p, 'idle').includes('不写动作'));
});
test('quick edit validates whitelisted fields and rejects deletion sentinels without accepting advanced replacements', () => {
  assert.deepEqual(validateFields({ ...fields, extensions: { unsafe: true }, character_book: {} }), fields);
  assert.throws(() => validateFields({ ...fields, name: '' }), /名称/);
  assert.throws(() => validateFields({ ...fields, first_mes: '__@@UNSET@@__' }), /格式/);
});
