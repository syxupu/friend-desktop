import test from 'node:test';
import assert from 'node:assert/strict';
import { mainFixture, deferred, tick } from './main-fixture';
import { revisionOf } from '../src/companions';
const fields = { name: 'Neutral', description: 'Original', personality: '', scenario: '', first_mes: '', mes_example: '' };
test('backup failure prevents an existing card from reaching the Tavern write endpoint', async () => {
  const f = mainFixture({ backup: async () => { throw new Error('backup disk failure'); } }); let edits = 0;
  f.bridge.call = async method => { if (method === 'editDefinition') edits++; return { data: { ...fields, extensions: { keep: true } } }; };
  await assert.rejects(f.handlers.get('friend:character-save')!(f.sender, { avatar: 'other.png', revision: revisionOf(fields), fields: { ...fields, description: 'Edited' } }), /backup disk failure/);
  assert.equal(edits, 0); assert.equal(f.api.inspect().configuring, false); assert.equal(f.api.inspect().tavernReady, true); await f.cleanup();
});
test('pending backup/save excludes generation and settings; writable revision conflict is checked before a write', async () => {
  const hold = deferred<void>(), f = mainFixture({ backup: () => hold.promise }); let data = { ...fields }, edits = 0;
  f.bridge.call = async (method, payload) => { if (method === 'editDefinition') { edits++; data = { ...payload.fields }; } return { data }; };
  const pending = f.handlers.get('friend:character-save')!(f.sender, { avatar: 'other.png', revision: revisionOf(fields), fields: { ...fields, description: 'Edited' } });
  await tick(); await assert.rejects(f.api.generate('overlap'), /正在保存/); await assert.rejects(f.api.saveSettings({ userName: 'overlap' }), /尚未完成/);
  hold.resolve(); const result = await pending; assert.equal(result.fields.description, 'Edited'); assert.equal(edits, 1);
  await assert.rejects(f.handlers.get('friend:character-save')!(f.sender, { avatar: 'other.png', revision: revisionOf(fields), fields }), /已变化/); assert.equal(edits, 1); await f.cleanup();
});
test('new free chat archive failure retains the old visible conversation and usable role', async () => {
  const f = mainFixture(); const reply = f.api.generate('original user message'); f.reply('original assistant message'); await reply;
  const before = JSON.stringify(f.api.inspect().messages);
  f.bridge.call = async () => ({ chat: { avatar: 'test.png', fileName: 'old' }, messages: f.api.inspect().messages });
  f.api.setArchive({ summary: () => ({ revision: 0, taskCount: 0 }), saveStatus: () => ({ status: 'saved', dirty: false }), newChat: () => ({ avatar: 'test.png', fileName: 'new' }), switchCharacter: async () => { throw new Error('archive disk failure'); } });
  await assert.rejects(f.handlers.get('friend:character-chat')!(f.sender), /archive disk failure/);
  assert.equal(JSON.stringify(f.api.inspect().messages), before); assert.equal(f.api.inspect().tavernReady, true); assert.equal(f.api.inspect().configuring, false); await f.cleanup();
});
