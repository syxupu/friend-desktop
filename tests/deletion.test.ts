import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationArchive, chatFilePath } from '../src/archive';
import { ChatDeletion } from '../src/chat-deletion';
import { loreDocument, removeLore } from '../src/lore';
import type { StudySnapshot } from '../src/types';
import { mainFixture } from './main-fixture';
const snapshot = (mode: StudySnapshot['mode'], segment = 1): StudySnapshot => ({ mode, segment, topic: '测试', elapsedMs: 100, taskElapsedMs: 100, rounds: 0, chatReminderSent: false });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'friend-delete-')), archive = new ConversationArchive(directory);
  await archive.load(); const initial = archive.newChat('test.png');
  await mkdir(path.dirname(chatFilePath(directory, initial)), { recursive: true });
  await archive.initialize(initial, [], snapshot('idle'));
  const first = await archive.startSegment('first', snapshot('study'), initial, false);
  await writeFile(chatFilePath(directory, first), '{"chat_metadata":{}}\n{"mes":"original","is_user":true}');
  await archive.endSegment(snapshot('break'), []);
  const second = await archive.startSegment('second', snapshot('study', 2), first, true);
  await writeFile(chatFilePath(directory, second), '{"chat_metadata":{}}\n{"mes":"second","is_user":true}');
  const task = archive.getTask(archive.summary().activeTaskId!);
  return { directory, archive, first, second, task };
}
test('deletion protects current task/chat, removes only one old segment, and removes an empty task', async () => {
  const f = await fixture(); assert.throws(() => f.archive.deletionPlan(f.task.id), /结束当前/);
  assert.throws(() => f.archive.deletionPlan(f.task.id, f.task.segments[1].id), /正在使用/);
  const plan = f.archive.deletionPlan(f.task.id, f.task.segments[0].id); assert.deepEqual(plan.chats, [f.first]);
  await f.archive.deleteRecord(f.task.id, f.task.segments[0].id); assert.equal(f.archive.getTask(f.task.id).segments[0].number, 2);
  await f.archive.finishTask(snapshot('idle', 0), 100, f.second);
  await f.archive.deleteRecord(f.task.id, f.task.segments[1].id); assert.equal(f.archive.list().length, 0);
  const restored = new ConversationArchive(f.directory); await restored.load(); assert.equal(restored.list().length, 0);
});
test('failed index deletion restores missing chats from durable backups; successful deletion stays gone after recovery', async () => {
  const f = await fixture(); await f.archive.finishTask(snapshot('idle'), 100, f.second);
  const bytes = await readFile(chatFilePath(f.directory, f.first)), transaction = new ChatDeletion(f.directory);
  await transaction.prepare(f.archive.deletionPlan(f.task.id).chats);
  await transaction.remove(async chat => { await unlink(chatFilePath(f.directory, chat)); });
  const blocker = path.join(f.directory, 'chat-library.json.tmp'); await mkdir(blocker);
  await assert.rejects(f.archive.deleteRecord(f.task.id)); assert.equal(f.archive.list().length, 1);
  await ChatDeletion.recover(f.directory, f.archive.references()); assert.ok((await readFile(chatFilePath(f.directory, f.first))).equals(bytes));
  await rmdir(blocker);
  const next = new ChatDeletion(f.directory); await next.prepare(f.archive.deletionPlan(f.task.id).chats);
  await next.remove(async chat => { await unlink(chatFilePath(f.directory, chat)); }); await f.archive.deleteRecord(f.task.id);
  await ChatDeletion.recover(f.directory, f.archive.references());
  await assert.rejects(readFile(chatFilePath(f.directory, f.first)), { code: 'ENOENT' }); assert.equal(f.archive.list().length, 0);
});
test('partial Tavern deletion failure restores removed files without overwriting surviving changes', async () => {
  const f = await fixture(); await f.archive.finishTask(snapshot('idle'), 100, f.second);
  const transaction = new ChatDeletion(f.directory); await transaction.prepare(f.archive.deletionPlan(f.task.id).chats);
  await assert.rejects(transaction.remove(async chat => { if (chat.fileName === f.second.fileName) throw new Error('native failure'); await unlink(chatFilePath(f.directory, chat)); }));
  await writeFile(chatFilePath(f.directory, f.second), 'surviving new data');
  await transaction.settle(f.archive.references());
  assert.ok((await readFile(chatFilePath(f.directory, f.first), 'utf8')).includes('original'));
  assert.equal(await readFile(chatFilePath(f.directory, f.second), 'utf8'), 'surviving new data');
  assert.throws(() => chatFilePath(f.directory, { avatar: '../bad.png', fileName: 'x' }));
});
test('lore deletion deduplicates matching embedded/world entries and preserves other entries and unknown extensions', () => {
  const data = { character_book: { name: 'Shared', extensions: { keep: true }, entries: [{ id: 3, keys: ['key'], content: 'REMOVE', extensions: { keep: 1 } }, { id: 9, keys: [], content: 'KEEP' }] } };
  const world = { name: 'Shared', data: { unknown: { keep: true }, originalData: structuredClone(data.character_book), entries: { '3': { uid: 3, key: ['key'], content: 'REMOVE' }, '20': { uid: 20, key: [], content: 'EXTERNAL_KEEP' } } } };
  const original = JSON.stringify({ data, world }); const doc = loreDocument(data, world); assert.equal(doc.lore.length, 3); assert.equal(doc.lore[0].source, 'both');
  const change = removeLore(data, world, 'e:0'); assert.equal(change.book.entries[0].id, 9); assert.equal(change.book.extensions.keep, true);
  assert.deepEqual(Object.keys(change.worldCopy.entries), ['20']); assert.equal(change.worldCopy.unknown.keep, true); assert.equal(JSON.stringify({ data, world }), original);
  assert.equal(removeLore(data, world, 'w:20').book.entries.length, 2);
  assert.notEqual(loreDocument({ ...data, character_book: change.book }, world).loreRevision, doc.loreRevision);
  assert.throws(() => removeLore(data, world, 'e:99'), /不存在/);
});
test('main lore deletion rejects stale revisions and backup failures before a Tavern write', async () => {
  const f = mainFixture({ backup: async () => { throw new Error('backup refused'); } }); let writes = 0;
  const data = { name: 'Neutral', character_book: { entries: [{ id: 1, keys: [], content: 'fixture' }] } };
  f.bridge.call = async method => { if (method === 'editLore') writes++; return { data }; };
  const invoke = f.handlers.get('friend:lore-delete')!;
  await assert.rejects(invoke({ sender: {} }, 'test.png', 'stale', 'e:0'), /无效窗口/);
  await assert.rejects(invoke(f.sender, 'test.png', 'stale', 'e:0'), /已变化/);
  await assert.rejects(invoke(f.sender, 'test.png', loreDocument(data).loreRevision, 'e:0'), /backup refused/);
  assert.equal(writes, 0); assert.equal(f.api.inspect().configuring, false); await f.cleanup();
});
