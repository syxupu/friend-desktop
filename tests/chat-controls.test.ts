import test from 'node:test';
import assert from 'node:assert/strict';
import { mainFixture, deferred, until } from './main-fixture';

test('history writes exclude generation/settings and only publish server-acknowledged history', async () => {
  const f = mainFixture();
  try {
    const history = [{ id: 'st-user', role: 'user', text: '原问题' }, { id: 'st-reply', role: 'assistant', text: '原回复' }];
    f.bridge.call = async () => ({ character: '测试角色', entries: 8, messages: history });
    await f.api.saveSettings({});
    const write = deferred(); f.bridge.call = async () => write.promise;
    const editing = f.api.changeMessage({ action: 'edit', id: 'st-user', expectedText: '原问题', text: '新问题' });
    assert.equal(f.api.inspect().configuring, true);
    assert.equal(f.api.inspect().messages[0].text, '原问题');
    await assert.rejects(f.api.generate('不得发送'), /保存设置/);
    await assert.rejects(f.api.changeMessage({ action: 'delete', id: 'st-reply', expectedText: '原回复' }), /当前操作/);
    write.resolve({ messages: [{ ...history[0], text: '新问题' }, history[1]] }); await editing;
    assert.equal(f.api.inspect().messages[0].text, '新问题');
    assert.equal(f.api.inspect().configuring, false);
    await assert.rejects(f.api.changeMessage({ action: 'edit', id: 'st-user', expectedText: '原问题', text: '过时修改' }), /记录已变化/);
  } finally { await f.cleanup(); }
});

test('regeneration replaces the latest assistant, preserves original on cancel, and counts no extra round', async () => {
  const f = mainFixture();
  try {
    await f.api.control('start');
    const original = f.bridge.call.bind(f.bridge);
    f.bridge.call = async () => ({ character: '测试角色', entries: 8, messages: [{ id: 'st-latest', role: 'assistant', text: '原回复' }] });
    await f.api.saveSettings({}); f.bridge.call = original;
    const change = { action: 'regenerate', id: 'st-latest', expectedText: '原回复' };
    const running = f.api.changeMessage(change);
    assert.equal(f.api.inspect().messages.filter((m: any) => m.role === 'assistant').length, 1);
    f.reply('“新回复。”'); await running;
    assert.equal(f.api.inspect().study.rounds, 0);
    // Fixture reply is deliberately restored to the same canonical identity.
    f.bridge.call = async () => ({ character: '测试角色', entries: 8, messages: [{ id: 'st-latest', role: 'assistant', text: '原回复' }] });
    await f.api.saveSettings({}); f.bridge.call = original;
    const cancelled = f.api.changeMessage(change); await until(() => f.api.inspect().busy);
    await f.api.cancelGeneration(); await cancelled;
    assert.equal(f.api.inspect().messages.find((m: any) => m.id === 'st-latest').text, '原回复');
    assert.equal(f.api.inspect().study.rounds, 0);
  } finally { await f.cleanup(); }
});

test('pin commits without reconfiguring Tavern, and save failure leaves the native window unchanged', async () => {
  const f = mainFixture();
  try {
    const settings = { ...f.api.inspect().settings, chatAlwaysOnTop: false };
    let fail = false;
    f.api.setStore({ value: settings, save: async (patch: any) => { if (fail) throw new Error('EACCES'); Object.assign(settings, patch); } });
    await f.handlers.get('friend:pin')!(f.sender, true);
    assert.equal(f.window.pinned, true); assert.equal(f.calls.length, 0);
    fail = true; await assert.rejects(f.handlers.get('friend:pin')!(f.sender, false), /EACCES/);
    assert.equal(f.window.pinned, true); assert.equal(f.api.inspect().settings.chatAlwaysOnTop, true);
    await assert.rejects(f.handlers.get('friend:pin')!({ sender: {} }, false), /无效窗口/);
  } finally { await f.cleanup(); }
});
