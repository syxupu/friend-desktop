import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationArchive } from '../src/archive';
import { StudySession } from '../src/study';
import { mainFixture } from './main-fixture';
import type { ChatReference, StudySnapshot } from '../src/types';

const reference = { avatar: 'test.png', fileName: 'old-chat' };
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'friend-archive-'));
  const archive = new ConversationArchive(directory); await archive.load();
  return { directory, archive, async chat(ref: ChatReference, text: string[]) {
    const file = path.join(directory, 'tavern-data/default-user/chats', ref.avatar.slice(0, -4), `${ref.fileName}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, [{ chat_metadata: { integrity: 'fixture' } }, ...text.map((mes, index) => ({ mes, is_user: index % 2 === 0,
      send_date: new Date().toISOString(), extra: { friend_message_id: `msg-${index}` } }))].map(value => JSON.stringify(value)).join('\n'));
    return file;
  } };
}
const snapshot = (mode: StudySnapshot['mode'] = 'study', segment = 1): StudySnapshot => ({ mode, segment, elapsedMs: 0, taskElapsedMs: 0, topic: '数学', rounds: 0, chatReminderSent: false });

test('character switch saves the old free chat and commits the target atomically; disk failure leaves identity intact', async () => {
  const f = await fixture(); await f.chat(reference, []); await f.archive.initialize(reference, [], snapshot('idle', 0));
  await f.chat(reference, ['old role chat']);
  const target = { avatar: 'other.png', fileName: 'other-chat', characterName: 'Other' };
  await f.chat(target, []);
  const blocker = path.join(f.directory, 'chat-library.json.tmp'); await mkdir(blocker);
  await assert.rejects(f.archive.switchCharacter(target, true, snapshot('idle', 0)));
  assert.deepEqual(f.archive.snapshot().currentChat, reference); assert.equal(f.archive.list().length, 0);
  await rmdir(blocker); await f.archive.switchCharacter(target, true, snapshot('idle', 0));
  assert.deepEqual(f.archive.snapshot().currentChat, target);
  const oldTask = f.archive.list()[0]; assert.equal(oldTask.kind, 'free');
  const detail = f.archive.getTask(oldTask.id); assert.equal((await f.archive.getSegment(oldTask.id, detail.segments[0].id)).messages[0].text, 'old role chat');
  const loaded = new ConversationArchive(f.directory); await loaded.load(); assert.deepEqual(loaded.snapshot().currentChat, target);
});

test('archive groups two segments under one task, hides only ended learning messages, and preserves rest in that segment', async () => {
  const f = await fixture(); await f.chat(reference, []); await f.archive.initialize(reference, [], snapshot('idle', 0));
  const first = await f.archive.startSegment('数学', snapshot(), reference, false); await f.chat(first, ['学习问题', '学习回复']);
  await f.archive.endSegment({ ...snapshot('break'), elapsedMs: 25000, taskElapsedMs: 25000 }, ['st-msg-0', 'st-msg-1']);
  assert.deepEqual(f.archive.visible([{ id: 'st-msg-0', role: 'user', text: '学习问题' }, { id: 'rest', role: 'assistant', text: '休息开场' }]).map(message => message.id), ['rest']);
  await f.chat(first, ['学习问题', '学习回复', '休息聊天']);
  const second = await f.archive.startSegment('导数', snapshot('study', 2), first, true); await f.chat(second, ['第二段']);
  const task = f.archive.getTask(f.archive.summary().activeTaskId!);
  assert.equal(task.segments.length, 2); assert.equal(task.segments[0].durationMs, 25000);
  assert.equal((await f.archive.getSegment(task.id, task.segments[0].id)).messages.at(-1)?.text, '休息聊天');
  assert.notEqual(first.fileName, second.fileName); assert.equal(f.archive.list().length, 1);
  await f.archive.finishTask({ ...snapshot('idle', 0), elapsedMs: 0 }, 30000, second);
  assert.equal(f.archive.list()[0].durationMs, 55000); assert.ok(f.archive.list()[0].endedAt);
  const restored = new ConversationArchive(f.directory); await restored.load();
  assert.equal(restored.list()[0].segmentCount, 2); assert.equal(restored.snapshot().study?.elapsedMs, 0);
  assert.equal(restored.summary().activeTaskId, undefined);
});

test('upgrade migration preserves existing conversation bytes and indexes all old nonempty chats', async () => {
  const f = await fixture(); const one = await f.chat(reference, ['旧问题', '旧回复']);
  const other = await f.chat({ ...reference, fileName: 'other-old-chat' }, ['另一份旧聊天']);
  const before = [await readFile(one), await readFile(other)];
  await f.archive.initialize(reference, [{ id: 'old', role: 'user', text: '旧问题' }], snapshot('idle', 0));
  assert.equal(f.archive.list().length, 2); assert.notEqual(f.archive.snapshot().currentChat?.fileName, reference.fileName);
  assert.deepEqual(await readFile(one), before[0]); assert.deepEqual(await readFile(other), before[1]);
  await f.archive.initialize(reference, [], snapshot('idle', 0)); assert.equal(f.archive.list().length, 2);
});

test('failed boundary write cannot commit hidden IDs or lose the active task, then can be retried', async () => {
  const f = await fixture(); await f.chat(reference, []); await f.archive.initialize(reference, [], snapshot('idle', 0));
  await f.archive.startSegment('数学', snapshot(), reference, false);
  const before = f.archive.snapshot(), blocker = path.join(f.directory, 'chat-library.json.tmp'); await mkdir(blocker);
  await assert.rejects(f.archive.endSegment(snapshot('break'), ['message-to-hide']));
  assert.deepEqual(f.archive.snapshot(), before); assert.equal(f.archive.saveStatus().dirty, true);
  await rmdir(blocker); await f.archive.endSegment(snapshot('break'), ['message-to-hide']);
  assert.deepEqual(f.archive.snapshot().hiddenIds, ['message-to-hide']); assert.equal(f.archive.saveStatus().dirty, false);
});

test('upgrading an active third segment preserves its number and the next segment number', async () => {
  const f = await fixture(); await f.chat(reference, ['升级前的聊天']);
  await f.archive.initialize(reference, [{ id: 'old', role: 'user', text: '升级前的聊天' }], snapshot('paused', 3));
  await f.archive.endSegment(snapshot('break', 3), ['old']);
  await f.archive.startSegment('第四段', snapshot('study', 4), reference, true);
  const task = f.archive.getTask(f.archive.summary().activeTaskId!);
  assert.deepEqual(task.segments.map(segment => segment.number), [3, 4]); assert.equal(task.imported, true);
});

test('late updates from a prior segment cannot overwrite the new segment snapshot', async () => {
  const f = await fixture(); await f.chat(reference, []); await f.archive.initialize(reference, [], snapshot('idle', 0));
  const first = await f.archive.startSegment('数学', snapshot(), reference, false), id = f.archive.summary().activeSegmentId;
  await f.archive.endSegment(snapshot('break'), []);
  await f.archive.update(snapshot('study'), id); assert.equal(f.archive.snapshot().study?.mode, 'break', 'late learning snapshot must not reopen an ended segment');
  await f.archive.startSegment('第二段', snapshot('study', 2), first, false);
  await f.archive.update({ ...snapshot('break'), elapsedMs: 999999 }, id);
  assert.equal(f.archive.snapshot().study?.segment, 2); assert.equal(f.archive.snapshot().study?.elapsedMs, 0);
  assert.throws(() => f.archive.getTask('../../outside'), /不存在/);
});

test('actual main boundary archives before clearing and immediately shows zero when the task finishes', async () => {
  const disk = await fixture(); await disk.chat(reference, []); await disk.archive.initialize(reference, [], snapshot('idle', 0));
  const f = mainFixture(); f.api.setArchive(disk.archive);
  const canonical = [{ id: 'st-one', role: 'user', text: '原聊天' }]; let selected = reference;
  f.bridge.call = async (method: string, data: any) => {
    if (method === 'getConversation') return { chat: selected, messages: canonical };
    if (method === 'openConversation') { selected = data.chat; await disk.chat(selected, []); return { chat: selected, messages: [] }; }
    throw new Error(`Unexpected call ${method}`);
  };
  try {
    await f.api.control('start', '归档学习');
    await f.api.control('finish');
    assert.equal(f.api.inspect().study.elapsedMs, 0); assert.equal(f.api.inspect().study.mode, 'idle');
    assert.deepEqual(f.api.inspect().messages, []); assert.equal(disk.archive.list().filter(task => task.kind === 'study').length, 1);
    assert.ok(disk.archive.list().find(task => task.kind === 'study')?.endedAt);
  } finally { await f.cleanup(); }
});
