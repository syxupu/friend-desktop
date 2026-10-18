import test from 'node:test';
import assert from 'node:assert/strict';
import { mainFixture, deferred, tick } from './main-fixture';

function fixture(failArchive = false) {
  const f = mainFixture(), chats = { 'test.png': { avatar: 'test.png', fileName: 'old' }, 'other.png': { avatar: 'other.png', fileName: 'other' } };
  let current = chats['test.png'];
  const selected: string[] = [];
  Object.assign(f.bridge, { listCharacters: async () => [{ avatar: 'test.png', name: 'Test' }, { avatar: 'other.png', name: 'Other' }] });
  f.bridge.call = async (method: string) => {
    if (method === 'getConversation') return { chat: chats['test.png'], messages: [{ id: 'st-old', role: 'user', text: 'original' }] };
    if (method === 'configure') { selected.push(f.bridge.avatar); return { character: f.bridge.avatar, entries: 0, chat: chats[f.bridge.avatar as keyof typeof chats], messages: [] }; }
    throw new Error(method);
  };
  f.api.setArchive({ summary: () => ({ revision: 0, taskCount: 0 }), snapshot: () => ({ currentChat: current }), saveStatus: () => ({ status: 'saved', dirty: false }),
    initialize: async () => {}, visible: (messages: unknown) => messages,
    switchCharacter: async (chat: typeof current, hasMessages: boolean) => { assert.ok(hasMessages); if (failArchive) throw new Error('disk failure'); current = chat; },
  });
  return { ...f, select: (avatar: string) => f.handlers.get('friend:character-select')!(f.sender, avatar), selected, current: () => current };
}
test('character selection commits archive identity and blocks overlapping generation/settings', async () => {
  const f = fixture(), hold = deferred<boolean>(); f.api.setPersist(() => hold.promise);
  const selecting = f.select('other.png'); await tick();
  assert.equal(f.api.inspect().configuring, true);
  await assert.rejects(f.api.generate('overlap'), /正在保存/);
  await assert.rejects(f.api.saveSettings({ userName: 'overlap' }), /尚未完成/);
  hold.resolve(true); await selecting;
  assert.equal(f.current().avatar, 'other.png'); assert.equal(f.api.inspect().characterAvatar, 'other.png'); assert.equal(f.api.inspect().configuring, false);
  await f.cleanup();
});
test('failed archive commit restores old role and chat without accepting the new selection', async () => {
  const f = fixture(true); await assert.rejects(f.select('other.png'), /disk failure/);
  assert.deepEqual(f.selected, ['other.png', 'test.png']); assert.equal(f.current().avatar, 'test.png'); assert.equal(f.api.inspect().tavernReady, true);
  await f.cleanup();
});
test('unsaved chat, active study, missing role and untrusted window cannot switch roles', async () => {
  const f = fixture(); f.api.setPersist(async () => false);
  await assert.rejects(f.select('other.png'), /尚未保存/); assert.equal(f.selected.length, 0);
  await assert.rejects(f.select('missing.png'), /不存在/);
  await assert.rejects(f.select('../escape.png'), /标识/);
  f.api.study.start('study'); await assert.rejects(f.select('other.png'), /结束当前任务/);
  await assert.rejects(f.handlers.get('friend:character-select')!({ sender: {} }, 'other.png'), /无效窗口/);
  assert.equal(f.current().avatar, 'test.png'); await f.cleanup();
});
